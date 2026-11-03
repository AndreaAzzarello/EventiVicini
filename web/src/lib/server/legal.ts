import { env } from '$env/dynamic/private';
import { env as pub } from '$env/dynamic/public';

/** Dati del titolare per /privacy, /termini e /cookie, configurabili da variabili d'ambiente. */
export function legalInfo() {
	return {
		controller: env.CONTROLLER_NAME || 'il gestore di Eventi Vicini',
		email: env.CONTACT_EMAIL || 'eventivicini.info@gmail.com',
		updated: '3 novembre 2026',
		// Le pagine dichiarano le statistiche solo se il token di Cloudflare Web Analytics è configurato.
		analytics: Boolean(pub.PUBLIC_CF_BEACON_TOKEN)
	};
}
