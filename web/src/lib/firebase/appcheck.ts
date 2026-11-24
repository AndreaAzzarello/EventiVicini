// Provider App Check personalizzato: Cloudflare Turnstile (widget "managed", invisibile finché non serve una verifica)
// → /api/appcheck → token App Check. Si carica solo insieme all'SDK Firebase (client.ts), mai per chi naviga e basta.
// Cosa scrive nel browser: vedi /cookie (src/lib/cookies.ts).
import { noteAppCheck } from '../errors';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TIMEOUT_MS = 30_000;

type Turnstile = {
	render(el: HTMLElement, o: Record<string, unknown>): string;
	remove(id: string): void;
};

let script: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
	script ??= new Promise<Turnstile>((resolve, reject) => {
		const s = document.createElement('script');
		s.src = SCRIPT;
		s.async = true;
		s.onload = () => ((window as unknown as { turnstile?: Turnstile }).turnstile ? resolve((window as unknown as { turnstile: Turnstile }).turnstile) : reject(new Error('turnstile-missing')));
		s.onerror = () => {
			script = null; // si può riprovare (rete assente)
			reject(new Error('turnstile-load'));
		};
		document.head.append(s);
	});
	return script;
}

/** Un token Turnstile fresco (ogni token vale una volta sola: un widget nuovo a ogni richiesta). */
async function turnstileToken(sitekey: string): Promise<string> {
	const ts = await loadTurnstile();
	// Il widget resta invisibile; se Cloudflare chiede un'interazione compare in basso, raggiungibile da tastiera.
	const box = document.createElement('div');
	box.setAttribute('role', 'region');
	box.setAttribute('aria-label', 'Verifica anti-bot');
	Object.assign(box.style, { position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: '3000' });
	document.body.append(box);
	let id: string | null = null;
	try {
		return await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('turnstile-timeout')), TIMEOUT_MS);
			const done = (fn: () => void) => () => (clearTimeout(timer), fn());
			id = ts.render(box, {
				sitekey,
				action: 'appcheck',
				appearance: 'interaction-only',
				language: 'it',
				callback: (t: string) => done(() => resolve(t))(),
				'error-callback': done(() => reject(new Error('turnstile-error'))),
				'timeout-callback': done(() => reject(new Error('turnstile-expired')))
			});
		});
	} finally {
		if (id) ts.remove(id);
		box.remove();
	}
}

export type AppCheckToken = { token: string; expireTimeMillis: number };

/** Provider con il widget Turnstile reale. */
export function turnstileProvider(sitekey: string) {
	return {
		async getToken(): Promise<AppCheckToken> {
			try {
				const res = await fetch('/api/appcheck', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token: await turnstileToken(sitekey) })
				});
				if (!res.ok) throw new Error(`appcheck-${res.status}`);
				const token = (await res.json()) as AppCheckToken;
				noteAppCheck(true);
				return token;
			} catch (e) {
				noteAppCheck(false); // errors.ts: da qui un permission-denied delle richieste dipende dalla verifica, non dalle regole
				// L'SDK inghiotte gli errori del provider: così si vedono durante il monitoraggio (solo codici, mai token).
				console.warn('appcheck:', e instanceof Error ? e.message : 'errore');
				throw e;
			}
		}
	};
}

/** Provider di sviluppo con gli emulatori: nessuna rete, token finto (gli emulatori non applicano App Check). */
export const emulatorProvider = {
	async getToken(): Promise<AppCheckToken> {
		// Solo nella build dei test e2e (__E2E_HOOKS__ è falso in produzione e il ramo sparisce dal bundle): un test può simulare
		// il fallimento della verifica impostando globalThis.__appCheckFail prima del caricamento della pagina.
		if (__E2E_HOOKS__ && (globalThis as { __appCheckFail?: boolean }).__appCheckFail) {
			noteAppCheck(false);
			throw new Error('turnstile-load');
		}
		noteAppCheck(true);
		return { token: 'emulator-app-check-token', expireTimeMillis: Date.now() + 1_800_000 };
	}
};
