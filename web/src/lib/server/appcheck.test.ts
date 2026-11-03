import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAuthCache } from './gauth';
import { TOKEN_TTL_S, mintAppCheckToken, verifyTurnstile } from './appcheck';
import { POST } from '../../routes/api/appcheck/+server';

const cfg = vi.hoisted(() => ({ priv: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: new Proxy({}, { get: (_t, k: string) => cfg.priv[k] }) }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_FIREBASE_PROJECT_ID: 'proj', PUBLIC_FIREBASE_APP_ID: '1:123:web:abc' } }));

const HOST = 'eventi-vicini.pages.dev';
const EMAIL = 'reader@demo.iam.gserviceaccount.com';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
let publicKey: CryptoKey;
let secret: string;
let pem: string;

const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const claimsOf = (jwt: string) => JSON.parse(new TextDecoder().decode(unb64(jwt.split('.')[1])));
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
	publicKey = pair.publicKey;
	const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
	pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
	secret = JSON.stringify({ client_email: EMAIL, private_key: pem });
});

/** Cloudflare e Google finti. Come il vero Turnstile, ogni token "good-*" vale una sola volta. */
let calls: { url: string; body?: unknown; auth?: string }[];
let used: Set<string>;
let exchange: () => Response;
beforeEach(() => {
	cfg.priv = { FIREBASE_READER_SA: secret, TURNSTILE_SECRET: 'ts-secret' };
	resetAuthCache();
	calls = [];
	used = new Set();
	exchange = () => reply({ token: 'APPCHECK.JWT.TOKEN', ttl: '1800s' });
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: { body?: unknown; headers?: Record<string, string> }) => {
			calls.push({ url, body: init?.body, auth: init?.headers?.authorization });
			if (url === SITEVERIFY) {
				const body = init!.body as URLSearchParams;
				const token = body.get('response')!;
				if (body.get('secret') !== 'ts-secret') return reply({ success: false, 'error-codes': ['invalid-input-secret'] });
				if (used.has(token)) return reply({ success: false, 'error-codes': ['timeout-or-duplicate'] });
				if (token.startsWith('good-')) {
					used.add(token);
					return reply({ success: true, action: token.includes('wrongaction') ? 'login' : 'appcheck', hostname: token.includes('wronghost') ? 'altro.example' : HOST });
				}
				return reply({ success: false, 'error-codes': ['invalid-input-response'] });
			}
			if (url === 'https://oauth2.googleapis.com/token') return reply({ access_token: 'ya29.cloud', expires_in: 3600 });
			if (url.startsWith('https://firebaseappcheck.googleapis.com/')) return exchange();
			throw new Error(`fetch inatteso: ${url}`);
		})
	);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const post = (body: unknown) =>
	POST({ request: new Request(`https://${HOST}/api/appcheck`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), url: new URL(`https://${HOST}/api/appcheck`) } as never);
const minted = () => calls.some((c) => c.url.startsWith('https://firebaseappcheck.googleapis.com/'));

describe('verifyTurnstile', () => {
	it('accetta una verifica riuscita per l’azione e il dominio attesi, senza mandare l’IP', async () => {
		expect(await verifyTurnstile('good-1234567890', HOST)).toEqual({ ok: true });
		const body = calls[0].body as URLSearchParams;
		expect([...body.keys()].sort()).toEqual(['response', 'secret']);
	});
	it.each([
		['segreto non configurato', () => (cfg.priv.TURNSTILE_SECRET = undefined), 'good-1234567890', 'turnstile-not-configured'],
		['token non valido', () => {}, 'bad-1234567890', 'turnstile-invalid-input-response'],
		['azione diversa', () => {}, 'good-wrongaction1', 'turnstile-wrong-action'],
		['dominio diverso', () => {}, 'good-wronghost1', 'turnstile-wrong-hostname']
	])('rifiuta: %s', async (_n, setup, token, reason) => {
		setup();
		expect(await verifyTurnstile(token, HOST)).toEqual({ ok: false, reason });
	});
	it('rifiuta se Cloudflare non risponde, senza lanciare', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rete'); }));
		expect(await verifyTurnstile('good-1234567890', HOST)).toEqual({ ok: false, reason: 'turnstile-unreachable' });
		vi.stubGlobal('fetch', vi.fn(async () => reply({}, 500)));
		expect(await verifyTurnstile('good-1234567890', HOST)).toEqual({ ok: false, reason: 'turnstile-http-500' });
	});
});

describe('mintAppCheckToken', () => {
	it('firma il token personalizzato come il SDK ufficiale e lo scambia', async () => {
		const now = Date.parse('2026-11-04T10:00:00Z');
		const out = await mintAppCheckToken(now);
		expect(out).toEqual({ token: 'APPCHECK.JWT.TOKEN', expireTimeMillis: now + 1800_000 });
		const ex = calls.find((c) => c.url.startsWith('https://firebaseappcheck'))!;
		expect(ex.url).toBe('https://firebaseappcheck.googleapis.com/v1/projects/proj/apps/1:123:web:abc:exchangeCustomToken');
		expect(ex.auth).toBe('Bearer ya29.cloud');
		const { customToken, limitedUse } = JSON.parse(ex.body as string);
		expect(limitedUse).toBe(false);
		const iat = Math.floor(now / 1000);
		expect(claimsOf(customToken)).toEqual({
			iss: EMAIL, sub: EMAIL, app_id: '1:123:web:abc', exp: iat + 300, iat, ttl: `${TOKEN_TTL_S}s`,
			aud: 'https://firebaseappcheck.googleapis.com/google.firebase.appcheck.v1.TokenExchangeService'
		});
		const [h, c, s] = customToken.split('.');
		expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, unb64(s), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
	});
	it('il token dura il minimo consentito (30 minuti)', () => expect(TOKEN_TTL_S).toBe(1800));
	it('se lo scambio fallisce l’errore non contiene corpo, token né chiave', async () => {
		exchange = () => reply({ error: 'CORPO-SEGRETO' }, 403);
		const err = await mintAppCheckToken().catch((e: Error) => e);
		expect((err as Error).message).toBe('scambio del token App Check rifiutato (HTTP 403)');
	});
	it('senza account di servizio lancia', async () => {
		cfg.priv.FIREBASE_READER_SA = undefined;
		await expect(mintAppCheckToken()).rejects.toThrow('non configurato');
	});
});

describe('POST /api/appcheck: senza Turnstile valido nessun token', () => {
	it('verifica riuscita → token App Check, mai in cache', async () => {
		const res = await post({ token: 'good-1234567890' });
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toMatchObject({ token: 'APPCHECK.JWT.TOKEN', expireTimeMillis: expect.any(Number) });
	});
	it('lo stesso token Turnstile una seconda volta: 403 e nessun token', async () => {
		expect((await post({ token: 'good-1234567890' })).status).toBe(200);
		calls.length = 0;
		const again = await post({ token: 'good-1234567890' });
		expect(again.status).toBe(403);
		expect(minted()).toBe(false);
	});
	it.each([
		['corpo assente', ''],
		['non è JSON', 'ciao'],
		['senza token', {}],
		['token non stringa', { token: 12345678901234 }],
		['token troppo corto', { token: 'abc' }],
		['token enorme', { token: 'x'.repeat(2049) }]
	])('400 e nessuna chiamata a Cloudflare né a Google: %s', async (_n, body) => {
		const res = await post(body);
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});
	it('corpo oltre 4 KB: 413', async () => {
		expect((await post('x'.repeat(5000))).status).toBe(413);
		expect(calls).toEqual([]);
	});
	it.each([
		['token non valido', 'bad-1234567890'],
		['azione sbagliata', 'good-wrongaction1'],
		['dominio sbagliato', 'good-wronghost1']
	])('403 e nessun token: %s', async (_n, token) => {
		const res = await post({ token });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'verification-failed' }); // il motivo va solo nel log
		expect(minted()).toBe(false);
	});
	it('segreto Turnstile non configurato: 403 e nessun token', async () => {
		cfg.priv.TURNSTILE_SECRET = undefined;
		expect((await post({ token: 'good-1234567890' })).status).toBe(403);
		expect(minted()).toBe(false);
	});
	it('Turnstile ok ma lo scambio con Google fallisce: 503 senza dettagli', async () => {
		exchange = () => reply({ error: 'CORPO-SEGRETO' }, 500);
		const res = await post({ token: 'good-1234567890' });
		expect(res.status).toBe(503);
		expect(JSON.stringify(await res.json())).not.toContain('CORPO-SEGRETO');
	});
	it('nei log non finiscono token Turnstile, segreti né chiave', async () => {
		await post({ token: 'bad-1234567890' });
		exchange = () => reply({}, 500);
		await post({ token: 'good-abcdefghij' });
		const logged = JSON.stringify([...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]);
		for (const leak of ['bad-1234567890', 'good-abcdefghij', 'ts-secret', 'PRIVATE KEY', pem.slice(40, 80)]) expect(logged).not.toContain(leak);
	});
});
