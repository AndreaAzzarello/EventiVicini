// Un solo punto che traduce gli errori della verifica del browser (App Check con Cloudflare Turnstile) in un messaggio chiaro.
// Solo memoria: nessun dato scritto nel browser (vedi src/lib/cookies.ts).

export const VERIFY_MESSAGE =
	'Non sono riuscito a verificare il browser. Ricarica la pagina e riprova; se usi un blocco della pubblicità, disattivalo per questo sito.';

// Esito dell'ultimo tentativo di ottenere il token App Check (null = nessun tentativo: App Check non attivo o non ancora partito).
let last: 'ok' | 'failed' | null = null;

/** Lo chiama il provider App Check a ogni tentativo: un successo annulla un fallimento precedente. */
export function noteAppCheck(ok: boolean) {
	last = ok ? 'ok' : 'failed';
}

/**
 * Vero solo quando la causa è la verifica del browser:
 * - errori del provider (`turnstile-*`, `appcheck-<status>`) o dell'SDK App Check;
 * - `permission-denied` quando l'ultimo tentativo App Check è fallito e non è seguito da un successo (senza token l'enforcement
 *   rifiuta la richiesta). Con un token valido un `permission-denied` è delle regole (es. utente non admin): resta il suo testo.
 */
export function isVerifyError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : '';
	if (/^(turnstile|appcheck)-/.test(msg)) return true;
	const code = (e as { code?: string } | null)?.code ?? '';
	if (code.startsWith('appCheck/') || code === 'auth/firebase-app-check-token-is-invalid') return true;
	return (code === 'permission-denied' || code === 'firestore/permission-denied') && last === 'failed';
}

/** Il testo da mostrare: quello della verifica se la causa è quella, altrimenti `fallback` (rete, regole, limiti: invariati). */
export function errorMessage(e: unknown, fallback: string): string {
	return isVerifyError(e) ? VERIFY_MESSAGE : fallback;
}

/** Solo per i test. */
export function resetAppCheckNote() {
	last = null;
}
