import { describe, expect, it } from 'vitest';
import { EVENT_KEYS, fromData } from './event';

// Dati personali: ciò che le API pubbliche (/api/events, /api/citta, bundle, sitemap) possono restituire di un evento è solo ciò che
// esce da fromData. Un campo privato scritto per errore nel documento Firestore non deve arrivare al browser.
const PRIVATE = ['ownerId', 'submittedBy', 'email', 'uid', 'userId', 'authorEmail', 'ip', 'token', 'reporter', 'reportedBy'];
const ALLOWED = new Set<string>([...EVENT_KEYS, 'id', 'source', 'sourceUrl', 'imageMiniUrl', 'imagePreviewUrl', 'locality', 'cityAlt', 'longRunning', 'approxLocation', 'contentHash', 'createdAt', 'updatedAt']);

describe('fromData: nessun campo privato in uscita', () => {
	const raw = { title: 'T', startTime: 10, ...Object.fromEntries(PRIVATE.map((k) => [k, `valore-${k}`])), qualcosaDiNuovo: 'x' };
	const out = fromData('abc', raw) as unknown as Record<string, unknown>;

	it('le chiavi private non compaiono', () => {
		for (const k of PRIVATE) expect(k in out, k).toBe(false);
		expect(JSON.stringify(out)).not.toMatch(/valore-/);
	});
	it('un campo sconosciuto non passa (lista chiusa, non lista nera)', () => {
		expect('qualcosaDiNuovo' in out).toBe(false);
	});
	it('ogni chiave in uscita è nell’elenco dei campi pubblici dell’evento', () => {
		const extra = Object.keys(out).filter((k) => !ALLOWED.has(k));
		expect(extra).toEqual([]);
	});
});
