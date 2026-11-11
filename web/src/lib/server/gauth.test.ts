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

	it('con l’emulatore presenta "Bearer owner" (salta le regole) e non chiama Google', async () => {
		cfg.env = { FIREBASE_READER_SA: secret, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
		expect(await firestoreAuthHeader()).toBe('Bearer owner');
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

// Cache API del data center simulata in memoria (in Node `caches` non esiste: gli altri test girano senza).
function stubEdgeCache() {
	const store = new Map<string, { body: string; headers: Headers }>();
	const cache = {
		match: vi.fn(async (req: Request) => {
			const hit = store.get(req.url);
			return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
		}),
		put: vi.fn(async (req: Request, res: Response) => {
			store.set(req.url, { body: await res.text(), headers: new Headers(res.headers) });
		})
	};
	vi.stubGlobal('caches', { default: cache });
	return { store, cache };
}

describe('token nella Cache API', () => {
	it('un isolate freddo lo prende dalla cache senza firmare né chiamare Google', async () => {
		const { store } = stubEdgeCache();
		expect(await firestoreAuthHeader()).toBe('Bearer ya29.test');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(store.size).toBe(1);
		resetAuthCache(); // nuovo isolate: memoria vuota
		expect(await firestoreAuthHeader()).toBe('Bearer ya29.test');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('in cache il token è cifrato: né nel nome né nel corpo, la voce vive fino al margine di rinnovo', async () => {
		const { store } = stubEdgeCache();
		await firestoreAuthHeader();
		const [[url, entry]] = [...store];
		expect(url).toMatch(/^https:\/\/gauth\.invalid\/v1\/[A-Za-z0-9_-]{43}$/);
		for (const text of [url, entry.body, JSON.stringify([...entry.headers])]) {
			expect(text).not.toContain('ya29');
			expect(text).not.toContain(EMAIL);
			expect(text).not.toContain('PRIVATE KEY');
		}
		expect(entry.headers.get('cache-control')).toBe('public, max-age=3300'); // 3600 s meno i 5 minuti di margine
	});

	it('voce con il token ormai nel margine di rinnovo: si rifà il token', async () => {
		stubEdgeCache();
		fetchMock.mockResolvedValueOnce(tokenResponse('vecchio', 3600)).mockResolvedValueOnce(tokenResponse('nuovo', 3600));
		await firestoreAuthHeader();
		resetAuthCache();
		vi.setSystemTime(new Date('2026-11-03T10:56:00Z')); // mancano 4 minuti
		expect(await firestoreAuthHeader()).toBe('Bearer nuovo');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('segreto cambiato: la voce non si decifra e si firma di nuovo', async () => {
		stubEdgeCache();
		await firestoreAuthHeader();
		resetAuthCache();
		const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
		const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
		const other = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
		cfg.env = { FIREBASE_READER_SA: JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: other }) };
		fetchMock.mockResolvedValueOnce(tokenResponse('con-chiave-nuova'));
		expect(await firestoreAuthHeader()).toBe('Bearer con-chiave-nuova');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('voce corrotta o cache che va in errore: nessun errore verso l’alto, si rifà il token', async () => {
		const { store, cache } = stubEdgeCache();
		await firestoreAuthHeader();
		resetAuthCache();
		const [key] = [...store.keys()];
		store.set(key, { body: 'xx.yy', headers: new Headers() });
		fetchMock.mockResolvedValueOnce(tokenResponse('rifatto'));
		expect(await firestoreAuthHeader()).toBe('Bearer rifatto');
		resetAuthCache();
		cache.match.mockRejectedValueOnce(new Error('cache giù'));
		cache.put.mockRejectedValueOnce(new Error('cache giù'));
		fetchMock.mockResolvedValueOnce(tokenResponse('ancora'));
		expect(await firestoreAuthHeader()).toBe('Bearer ancora');
	});
});
