import { json } from '@sveltejs/kit';
import { mintAppCheckToken, verifyTurnstile } from '$lib/server/appcheck';
import type { RequestHandler } from './$types';

// POST /api/appcheck {token}  → {token, expireTimeMillis}
// Il token App Check si emette solo dopo una verifica Turnstile riuscita (Cloudflare accetta ogni token una sola volta).
// Senza token valido: 400 o 403 e nessun token. Le risposte non spiegano il motivo al chiamante; il motivo va solo nel log.
const headers = { 'cache-control': 'no-store' };
const MAX_BODY = 4096;

export const POST: RequestHandler = async ({ request, url }) => {
	if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'invalid-request' }, { status: 413, headers });
	let token: unknown;
	try {
		const text = await request.text();
		if (text.length > MAX_BODY) return json({ error: 'invalid-request' }, { status: 413, headers });
		token = (JSON.parse(text) as { token?: unknown }).token;
	} catch {
		return json({ error: 'invalid-request' }, { status: 400, headers });
	}
	if (typeof token !== 'string' || token.length < 10 || token.length > 2048) return json({ error: 'invalid-request' }, { status: 400, headers });

	const verdict = await verifyTurnstile(token, url.hostname);
	if (!verdict.ok) {
		console.warn('appcheck: verifica rifiutata:', verdict.reason);
		return json({ error: 'verification-failed' }, { status: 403, headers });
	}
	try {
		return json(await mintAppCheckToken(), { headers });
	} catch (e) {
		console.error('appcheck: conio del token fallito:', (e as Error).message);
		return json({ error: 'unavailable' }, { status: 503, headers });
	}
};
