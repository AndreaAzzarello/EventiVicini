import { env } from '$env/dynamic/private';

/** Dati del titolare per /privacy e /termini, configurabili da variabili d'ambiente. */
export function legalInfo() {
	return {
		controller: env.CONTROLLER_NAME || 'il gestore di Eventi Vicini',
		email: env.CONTACT_EMAIL || 'eventivicini.info@gmail.com',
		updated: '2 novembre 2026'
	};
}
