// Elenco degli strumenti tecnici che il sito scrive nel browser. È l'unica fonte di /cookie e del test
// e2e/storage.spec.ts: se compare qualcosa che non è qui, il test fallisce. Aggiungere una voce = dichiararla.
// Politica: solo strumenti strettamente necessari, niente banner (ClaudeVault/decisioni/eventivicini-cookie.md).
export type Kind = 'cookie' | 'localStorage' | 'sessionStorage' | 'indexedDB' | 'cacheStorage';

export type Tool = {
	kind: Kind;
	/** Nome esatto, oppure espressione regolare per i nomi con suffisso (es. versione della build). */
	name: string | RegExp;
	/** Come appare nella tabella di /cookie. */
	label: string;
	purpose: string;
	duration: string;
	/** Chi lo scrive: "Eventi Vicini" o il componente di terzi che lo imposta. */
	origin: string;
	/** Dopo il login con l'emulatore (o solo per chi ha un account). */
	account?: boolean;
	/** Presente solo se la funzione è attiva (si mostra in /cookie solo allora): App Check con Turnstile. */
	needs?: 'appCheck';
};

const SITE = 'Eventi Vicini';
const FIREBASE = 'Firebase SDK (Google)';

export const TOOLS: Tool[] = [
	{ kind: 'localStorage', name: 'ev:place', label: 'ev:place', purpose: 'Ricorda la zona che hai scelto.', duration: 'Finché non la cambi o cancelli i dati del sito', origin: SITE },
	{ kind: 'localStorage', name: 'ev:favorites', label: 'ev:favorites', purpose: 'Conserva i preferiti sul dispositivo.', duration: 'Finché non li togli o cancelli i dati del sito', origin: SITE },
	{ kind: 'localStorage', name: 'ev:theme', label: 'ev:theme', purpose: 'Ricorda il tema chiaro o scuro.', duration: 'Finché non lo cambi o cancelli i dati del sito', origin: SITE },
	{ kind: 'localStorage', name: 'ev:session', label: 'ev:session', purpose: 'Segna che c’è un accesso, per caricare il login solo a chi ne ha bisogno.', duration: 'Fino all’uscita dall’account', origin: SITE, account: true },
	{ kind: 'localStorage', name: 'ev:emailForSignIn', label: 'ev:emailForSignIn', purpose: 'Tiene l’email inserita per completare l’accesso col link.', duration: 'Fino al completamento dell’accesso', origin: SITE, account: true },
	{ kind: 'localStorage', name: 'ev:geocode', label: 'ev:geocode', purpose: 'Memoria delle ultime ricerche di luoghi, per non ripeterle.', duration: 'Finché non cancelli i dati del sito (massimo 60 ricerche)', origin: SITE },
	{ kind: 'localStorage', name: 'ev:loginHint', label: 'ev:loginHint', purpose: 'Ricorda che il suggerimento di accedere è già stato mostrato.', duration: 'Finché non cancelli i dati del sito', origin: SITE },
	{ kind: 'localStorage', name: 'ev:reported', label: 'ev:reported', purpose: 'Elenco degli eventi già segnalati da questo dispositivo, per non duplicare la segnalazione.', duration: 'Finché non cancelli i dati del sito', origin: SITE },
	{ kind: 'sessionStorage', name: 'sveltekit:scroll', label: 'sveltekit:scroll', purpose: 'Riporta la pagina al punto in cui eri quando torni indietro.', duration: 'Fino alla chiusura della scheda', origin: 'SvelteKit (framework del sito)' },
	{ kind: 'sessionStorage', name: 'sveltekit:snapshot', label: 'sveltekit:snapshot', purpose: 'Ripristina campi e filtri quando torni indietro.', duration: 'Fino alla chiusura della scheda', origin: 'SvelteKit (framework del sito)' },
	{ kind: 'indexedDB', name: 'firebaseLocalStorageDb', label: 'firebaseLocalStorageDb', purpose: 'Sessione di accesso (token dell’account).', duration: 'Fino all’uscita dall’account', origin: FIREBASE, account: true },
	{ kind: 'indexedDB', name: 'firebase-heartbeat-database', label: 'firebase-heartbeat-database', purpose: 'Dato tecnico dell’SDK Firebase: data dell’ultimo utilizzo, allegata alle richieste a Firebase.', duration: 'Finché non cancelli i dati del sito', origin: FIREBASE, account: true },
	{ kind: 'indexedDB', name: 'firebase-app-check-database', label: 'firebase-app-check-database', purpose: 'Conserva il token di verifica anti-abuso (App Check) per non rifare il controllo a ogni richiesta.', duration: 'Pochi minuti: il token scade dopo 30 minuti e si rinnova', origin: FIREBASE, account: true, needs: 'appCheck' },
	// Scritto dentro il riquadro di Cloudflare (origine challenges.cloudflare.com), non nel dominio del sito: il test e2e non lo vede.
	{ kind: 'localStorage', name: 'cf.turnstile.u', label: 'cf.turnstile.u', purpose: 'Controllo anti-bot di Cloudflare Turnstile: distingue le persone dai programmi automatici prima di salvare, proporre o segnalare. Resta nel dominio challenges.cloudflare.com.', duration: 'Non scade da solo: resta finché non cancelli i dati del browser', origin: 'Cloudflare Turnstile', account: true, needs: 'appCheck' },
	{ kind: 'cacheStorage', name: /^shell-/, label: 'shell-…', purpose: 'File del sito (script, stili, font, icone) per aprirlo più in fretta e senza rete.', duration: 'Fino al prossimo aggiornamento del sito', origin: SITE },
	{ kind: 'cacheStorage', name: 'pages-v1', label: 'pages-v1', purpose: 'Fino a 40 pagine pubbliche già visitate, per aprirle senza rete (non account, accesso e moduli).', duration: 'Finché non cancelli i dati del sito', origin: SITE }
];

export const isDeclared = (kind: Kind, name: string) =>
	TOOLS.some((t) => t.kind === kind && (typeof t.name === 'string' ? t.name === name : t.name.test(name)));
