// Credenziali del Worker: account di servizio dedicato (vedi docs/sicurezza-prossimi-passi.md). Il JSON dell'account sta nel segreto
// FIREBASE_READER_SA di Cloudflare: mai nel repo, mai nei log. Si firma un JWT RS256 con WebCrypto e lo si scambia con un token
// OAuth (1 ora), tenuto in memoria dell'isolate fino a poco prima della scadenza. Serve a due cose: leggere Firestore (scope
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

const b64url = (data: ArrayBuffer | string) => {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

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
	cached.set(scope, { token: access_token, expiresAt: now + (expires_in ?? 3600) * 1000 });
	return access_token;
}

/** Token OAuth dell'account per lo scope dato, in cache. Una sola richiesta alla volta per scope, anche con molte letture in parallelo. */
export async function accessToken(a: Account, scope: string): Promise<string> {
	const hit = cached.get(scope);
	if (hit && hit.expiresAt - REFRESH_MARGIN_MS > Date.now()) return hit.token;
	let p = inflight.get(scope);
	if (!p) {
		p = fetchToken(a, scope).finally(() => inflight.delete(scope));
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
