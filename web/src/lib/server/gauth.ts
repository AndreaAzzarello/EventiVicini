// Credenziali del Worker: account di servizio dedicato (vedi docs/sicurezza-prossimi-passi.md). Il JSON dell'account sta nel segreto
// FIREBASE_READER_SA di Cloudflare: mai nel repo, mai nei log. Si firma un JWT RS256 con WebCrypto e lo si scambia con un token
// OAuth (1 ora), tenuto in memoria dell'isolate e, cifrato, nella Cache API del data center (#44) fino a poco prima della scadenza,
// così un isolate freddo non rifà l'importazione della chiave e la firma RSA. Serve a due cose: leggere Firestore (scope
// datastore) e coniare i token App Check (appcheck.ts, scope cloud-platform).
import { env } from '$env/dynamic/private';

export const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
export const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_MARGIN_MS = 5 * 60_000;

type Account = { client_email: string; private_key: string };

const cached = new Map<string, { token: string; expiresAt: number }>();
const inflight = new Map<string, Promise<string>>();
let signingKey: Promise<CryptoKey> | null = null;
let keyOf: string | null = null; // il segreto da cui viene signingKey: se cambia, si reimporta

// Cache API del data center (funziona nelle Pages Functions, anche su *.pages.dev; non è condivisa tra data center). Il token ci sta
// cifrato (AES-GCM) con una chiave derivata dal segreto dell'account, e sotto un nome derivato dallo stesso segreto: chi non ha il
// segreto non lo ritrova né lo legge. Il testo del token non compare mai in chiavi, intestazioni o log.
const EDGE_URL = 'https://gauth.invalid/v1/';
const enc = new TextEncoder();
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function edgeCache(): Cache | null {
	return typeof caches === 'undefined' ? null : ((caches as unknown as { default?: Cache }).default ?? null);
}

/** Nome della voce in cache e chiave AES, entrambi derivati (HKDF) dal segreto dell'account e dallo scope. */
async function edgeKeys(a: Account, scope: string): Promise<{ url: string; aes: CryptoKey }> {
	const ikm = await crypto.subtle.importKey('raw', enc.encode(a.private_key), 'HKDF', false, ['deriveBits']);
	const bits = (info: string) => crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: enc.encode(info) }, ikm, 256);
	const [name, key] = await Promise.all([bits(`gauth-name/${scope}`), bits('gauth-aes')]);
	return { url: EDGE_URL + b64url(name), aes: await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']) };
}

type Entry = { token: string; expiresAt: number };

async function readEdge(a: Account, scope: string): Promise<Entry | null> {
	try {
		const store = edgeCache();
		if (!store) return null;
		const { url, aes } = await edgeKeys(a, scope);
		const res = await store.match(new Request(url));
		if (!res) return null;
		const [iv, data] = (await res.text()).split('.');
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(scope) }, aes, unb64(data));
		const { t, e } = JSON.parse(new TextDecoder().decode(plain)) as { t?: unknown; e?: unknown };
		return typeof t === 'string' && typeof e === 'number' ? { token: t, expiresAt: e } : null;
	} catch {
		return null; // voce illeggibile, segreto cambiato o cache assente: si rifà il token, senza dire altro
	}
}

async function writeEdge(a: Account, scope: string, entry: Entry): Promise<void> {
	try {
		const store = edgeCache();
		const ttl = Math.floor((entry.expiresAt - REFRESH_MARGIN_MS - Date.now()) / 1000);
		if (!store || ttl <= 0) return;
		const { url, aes } = await edgeKeys(a, scope);
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const plain = enc.encode(JSON.stringify({ t: entry.token, e: entry.expiresAt }));
		const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(scope) }, aes, plain);
		await store.put(new Request(url), new Response(`${b64url(iv)}.${b64url(data)}`, { headers: { 'cache-control': `public, max-age=${ttl}` } }));
	} catch {
		// la cache è un'ottimizzazione: se non scrive, il prossimo isolate firma da sé
	}
}

/** L'account di servizio configurato, o null se il segreto manca. */
export function account(): Account | null {
	const raw = env.FIREBASE_READER_SA;
	if (!raw) return null;
	try {
		const a = JSON.parse(raw) as Partial<Account>;
		if (typeof a.client_email === 'string' && typeof a.private_key === 'string') return { client_email: a.client_email, private_key: a.private_key };
	} catch {
		// il messaggio dell'errore di JSON.parse può citare parti del testo: non lo si propaga
	}
	throw new Error('FIREBASE_READER_SA non è un JSON di account di servizio valido');
}

function importKey(pem: string): Promise<CryptoKey> {
	const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** JWT RS256 con i claim dati, firmato con la chiave dell'account. */
export async function signJwt(a: Account, claims: Record<string, unknown>): Promise<string> {
	if (keyOf !== a.private_key || !signingKey) {
		keyOf = a.private_key;
		signingKey = importKey(a.private_key);
	}
	const head = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
	const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey, new TextEncoder().encode(head));
	return `${head}.${b64url(sig)}`;
}

async function fetchToken(a: Account, scope: string): Promise<string> {
	const now = Date.now();
	const iat = Math.floor(now / 1000);
	const assertion = await signJwt(a, { iss: a.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 });
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
	});
	// Mai il corpo della risposta né l'asserzione negli errori: potrebbero finire nei log.
	if (!res.ok) throw new Error(`Token dell'account di servizio rifiutato (HTTP ${res.status})`);
	const { access_token, expires_in } = (await res.json()) as { access_token?: string; expires_in?: number };
	if (!access_token) throw new Error("Risposta del token dell'account di servizio senza access_token");
	const entry = { token: access_token, expiresAt: now + (expires_in ?? 3600) * 1000 };
	cached.set(scope, entry);
	await writeEdge(a, scope, entry);
	return access_token;
}

/** Token OAuth dell'account per lo scope dato, in cache. Una sola richiesta alla volta per scope, anche con molte letture in parallelo. */
export async function accessToken(a: Account, scope: string): Promise<string> {
	const hit = cached.get(scope);
	if (hit && hit.expiresAt - REFRESH_MARGIN_MS > Date.now()) return hit.token;
	let p = inflight.get(scope);
	if (!p) {
		p = (async () => {
			// isolate freddo: prima la Cache API del data center, e solo se manca o sta per scadere si firma e si chiama Google
			const edge = await readEdge(a, scope);
			if (edge && edge.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
				cached.set(scope, edge);
				return edge.token;
			}
			return fetchToken(a, scope);
		})().finally(() => inflight.delete(scope));
		inflight.set(scope, p);
	}
	return p;
}

/**
 * Intestazione Authorization per Firestore, oppure null se non c'è un account di servizio (segreto assente).
 */
export async function firestoreAuthHeader(): Promise<string | null> {
	// L'emulatore tratta "Bearer owner" come proprietario e salta le regole, come fa l'account di servizio vero in produzione:
	// senza, le regole a lettura chiusa bloccherebbero il Worker anche nei test e in locale.
	if (env.FIRESTORE_EMULATOR_HOST) return 'Bearer owner';
	const a = account();
	if (!a) return null;
	return `Bearer ${await accessToken(a, DATASTORE_SCOPE)}`;
}

/** Solo per i test: svuota token e chiave in memoria. */
export function resetAuthCache() {
	cached.clear();
	inflight.clear();
	signingKey = null;
	keyOf = null;
}
