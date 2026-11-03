// App Check con provider personalizzato: il browser ottiene un token solo dopo una verifica Cloudflare Turnstile riuscita.
// 1) verifyTurnstile: il token del widget si controlla con siteverify (Cloudflare lo accetta una sola volta).
// 2) mintAppCheckToken: si firma un token personalizzato con l'account di servizio e lo si scambia con un token App Check
//    (stesso schema di admin.appCheck().createToken del SDK ufficiale).
import { env } from '$env/dynamic/private';
import { env as pub } from '$env/dynamic/public';
import { CLOUD_SCOPE, account, accessToken, signJwt } from './gauth';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const AUDIENCE = 'https://firebaseappcheck.googleapis.com/google.firebase.appcheck.v1.TokenExchangeService';
export const TURNSTILE_ACTION = 'appcheck';
/** Durata dei token App Check: il minimo consentito (30 minuti) per ridurre il danno di un token rubato. */
export const TOKEN_TTL_S = 1800;

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Controlla un token Turnstile: successo, azione e dominio attesi. Mai il token né il segreto negli errori. */
export async function verifyTurnstile(token: string, hostname: string): Promise<Verdict> {
	const secret = env.TURNSTILE_SECRET;
	if (!secret) return { ok: false, reason: 'turnstile-not-configured' };
	let res: Response;
	try {
		// Nessun indirizzo IP del visitatore a Cloudflare: il parametro remoteip è facoltativo.
		res = await fetch(SITEVERIFY, { method: 'POST', body: new URLSearchParams({ secret, response: token }) });
	} catch {
		return { ok: false, reason: 'turnstile-unreachable' };
	}
	if (!res.ok) return { ok: false, reason: `turnstile-http-${res.status}` };
	const r = (await res.json().catch(() => ({}))) as { success?: boolean; action?: string; hostname?: string; 'error-codes'?: string[] };
	if (!r.success) return { ok: false, reason: `turnstile-${(r['error-codes'] ?? ['rejected']).slice(0, 3).join(',')}` };
	if (r.action !== TURNSTILE_ACTION) return { ok: false, reason: 'turnstile-wrong-action' };
	if (r.hostname !== hostname) return { ok: false, reason: 'turnstile-wrong-hostname' };
	return { ok: true };
}

export type AppCheckToken = { token: string; expireTimeMillis: number };

/** Conia un token App Check per l'app web. Lancia se manca l'account di servizio o lo scambio fallisce. */
export async function mintAppCheckToken(now = Date.now()): Promise<AppCheckToken> {
	const a = account();
	if (!a) throw new Error('account di servizio non configurato');
	const project = pub.PUBLIC_FIREBASE_PROJECT_ID;
	const appId = pub.PUBLIC_FIREBASE_APP_ID;
	const iat = Math.floor(now / 1000);
	const customToken = await signJwt(a, { iss: a.client_email, sub: a.client_email, app_id: appId, aud: AUDIENCE, exp: iat + 300, iat, ttl: `${TOKEN_TTL_S}s` });
	const res = await fetch(`https://firebaseappcheck.googleapis.com/v1/projects/${project}/apps/${appId}:exchangeCustomToken`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessToken(a, CLOUD_SCOPE)}` },
		body: JSON.stringify({ customToken, limitedUse: false })
	});
	// Nessun corpo della risposta nell'errore: potrebbe contenere il token.
	if (!res.ok) throw new Error(`scambio del token App Check rifiutato (HTTP ${res.status})`);
	const { token, ttl } = (await res.json()) as { token?: string; ttl?: string };
	if (!token) throw new Error('risposta App Check senza token');
	const seconds = ttl?.endsWith('s') ? Number(ttl.slice(0, -1)) : TOKEN_TTL_S;
	return { token, expireTimeMillis: now + Math.floor((Number.isFinite(seconds) ? seconds : TOKEN_TTL_S) * 1000) };
}
