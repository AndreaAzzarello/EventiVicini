import type { Handle } from '@sveltejs/kit';

// Intestazioni di sicurezza delle risposte del Worker (pagine e /api). Gli asset statici le prendono da static/_headers:
// Cloudflare Pages non applica _headers alle risposte del Worker. Tenere le due liste allineate.
// same-origin-allow-popups: il popup di accesso con Google deve poter parlare con la pagina che lo apre.
export const SECURITY_HEADERS = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(self), payment=()',
	'x-frame-options': 'DENY',
	'cross-origin-opener-policy': 'same-origin-allow-popups'
};

// Sonda della CPU (#44): una riga per invocazione che passa dal Worker. `n` è il numero della richiesta nell'isolate: n=1 è un
// avvio a freddo. Il tempo di CPU lo riporta l'evento di `wrangler pages deployment tail` (scripts/cpu-tail.mjs). Nessun dato
// dell'utente: solo l'id della rotta (es. /citta/[slug]), mai URL, query, IP o intestazioni. Le risposte servite dalla Cache API
// dell'adapter non passano di qui: nel tail sono gli eventi senza sonda.
let invocations = 0;

export const handle: Handle = async ({ event, resolve }) => {
	const n = ++invocations;
	const response = await resolve(event);
	console.log(JSON.stringify({ probe: 'cpu', route: event.route.id ?? 'nessuna', n, status: response.status }));
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
	return response;
};
