import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { firestoreAuthHeader, resetAuthCache } from './gauth';

const cfg = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => cfg);

const EMAIL = 'reader@demo.iam.gserviceaccount.com';
let publicKey: CryptoKey;
let secret: string;
let pem: string;

const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const part = (jwt: string, i: number) => jwt.split('.')[i];

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
	publicKey = pair.publicKey;
	const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
	pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
	secret = JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: pem });
});

let fetchMock: ReturnType<typeof vi.fn>;
const tokenResponse = (token = 'ya29.test', expires_in = 3600) => new Response(JSON.stringify({ access_token: token, expires_in }));

beforeEach(() => {
	cfg.env = { FIREBASE_READER_SA: secret };
	resetAuthCache();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
	fetchMock = vi.fn(async () => tokenResponse());
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('firestoreAuthHeader', () => {
	it('senza segreto non c’è intestazione (si ripiega sulla chiave web)', async () => {
		cfg.env = {};
		expect(await firestoreAuthHeader()).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('con l’emulatore non serve nessuna credenziale', async () => {
		cfg.env = { FIREBASE_READER_SA: secret, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
		expect(await firestoreAuthHeader()).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('firma un JWT RS256 valido con i claim giusti e lo scambia per un token', async () => {
		expect(await firestoreAuthHeader()).toBe('Bearer ya29.test');
		const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: URLSearchParams }];
		expect(url).toBe('https://oauth2.googleapis.com/token');
		expect(init.method).toBe('POST');
		expect(init.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
		const jwt = init.body.get('assertion')!;
		expect(JSON.parse(new TextDecoder().decode(unb64(part(jwt, 0))))).toEqual({ alg: 'RS256', typ: 'JWT' });
		const claims = JSON.parse(new TextDecoder().decode(unb64(part(jwt, 1))));
		const iat = Date.parse('2026-11-03T10:00:00Z') / 1000;
		expect(claims).toEqual({ iss: EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 });
		const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, unb64(part(jwt, 2)), new TextEncoder().encode(`${part(jwt, 0)}.${part(jwt, 1)}`));
		expect(ok).toBe(true);
	});

	it('riusa il token finché non sta per scadere, anche con letture in parallelo', async () => {
		const all = await Promise.all([1, 2, 3, 4, 5].map(() => firestoreAuthHeader()));
		expect(new Set(all)).toEqual(new Set(['Bearer ya29.test']));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.setSystemTime(new Date('2026-11-03T10:50:00Z')); // 50 minuti: ancora valido oltre il margine di 5
		await firestoreAuthHeader();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('lo rinnova entro gli ultimi 5 minuti', async () => {
		fetchMock.mockResolvedValueOnce(tokenResponse('vecchio', 3600)).mockResolvedValueOnce(tokenResponse('nuovo', 3600));
		expect(await firestoreAuthHeader()).toBe('Bearer vecchio');
		vi.setSystemTime(new Date('2026-11-03T10:56:00Z')); // mancano 4 minuti
		expect(await firestoreAuthHeader()).toBe('Bearer nuovo');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('se lo scambio fallisce, l’errore non contiene chiave, asserzione né corpo della risposta', async () => {
		fetchMock.mockResolvedValue(new Response('{"error":"invalid_grant","detail":"CORPO-SEGRETO"}', { status: 400 }));
		const err = await firestoreAuthHeader().catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		const msg = (err as Error).message;
		expect(msg).toContain('HTTP 400');
		for (const leak of ['CORPO-SEGRETO', 'BEGIN PRIVATE KEY', pem.slice(40, 80), 'eyJ']) expect(msg).not.toContain(leak);
		// Dopo un errore si può riprovare (nessun fallimento memorizzato).
		fetchMock.mockResolvedValue(tokenResponse('ripreso'));
		expect(await firestoreAuthHeader()).toBe('Bearer ripreso');
	});

	it('un segreto non valido dà un errore che non lo ripete', async () => {
		cfg.env = { FIREBASE_READER_SA: '{"client_email":"x","private_key":"CHIAVE-SEGRETA' };
		const err = await firestoreAuthHeader().catch((e: Error) => e);
		expect((err as Error).message).toMatch(/non è un JSON/);
		expect((err as Error).message).not.toContain('CHIAVE-SEGRETA');
		cfg.env = { FIREBASE_READER_SA: '{"client_email":"x"}' };
		await expect(firestoreAuthHeader()).rejects.toThrow(/non è un JSON/);
	});
});
