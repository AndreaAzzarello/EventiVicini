// «Questo weekend» della home senza luogo (#22): finestra e scelta degli eventi. Puro: lo usano la load server e i test.
// I candidati arrivano da bundles/weekend (tools/importer/weekend.py), già filtrati per la finestra del giorno dell'import:
// qui si rifiltra sull'ora di adesso (la lista resta in cache fino a 3 ore) e si scelgono quelli da mostrare.
import { dayInput, romeParts, romeTime } from './dates';
import type { Event } from './event';

/** Eventi mostrati nella fascia. */
export const WEEKEND_COUNT = 5;
/** Con meno di così la fascia non compare: due eventi sembrano un errore, non un weekend. */
export const WEEKEND_MIN = 3;

/**
 * [inizio, fine] (ms, fine compresa) del weekend di riferimento: venerdì 18:00 – domenica 23:59:59,999 in ora italiana.
 * Da lunedì al venerdì sera è quello che arriva, da venerdì 18:00 a domenica quello in corso.
 * Stessi estremi di tools/importer/weekend.py (casi in docs/schema/parity.json, `weekendWindows`).
 */
export function weekendWindow(now: number): [number, number] {
	const p = romeParts(now); // weekday: 0 = domenica
	const toFriday = p.weekday === 0 ? -2 : p.weekday === 6 ? -1 : 5 - p.weekday;
	return [romeTime(p.year, p.month, p.day + toFriday, 18), romeTime(p.year, p.month, p.day + toFriday + 3) - 1];
}

/** Hash FNV-1a a 32 bit: un ordine che sembra casuale ma è lo stesso per lo stesso giorno e gli stessi eventi. */
function fnv(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return h >>> 0;
}

/**
 * Fino a WEEKEND_COUNT eventi del weekend: uno per città, regioni diverse per prime (poi, se non bastano, una seconda
 * dalla stessa regione, e così via), esclusi quelli di lunga durata e con posizione approssimata. La scelta ruota ogni
 * giorno (seme = data italiana) e non cambia tra un ricaricamento e l'altro. Mostrati in ordine di inizio.
 * Con meno di WEEKEND_MIN eventi restituisce una lista vuota.
 */
export function pickWeekend(events: Event[], now: number, count = WEEKEND_COUNT): Event[] {
	const [from, to] = weekendWindow(now);
	const seed = dayInput(now);
	const candidates = events
		.filter((e) => !e.longRunning && !e.approxLocation && e.citySlug && e.lat && e.lng && e.endTime >= now && e.startTime >= from && e.startTime <= to)
		.map((e) => ({ e, rank: fnv(`${seed}|${e.id}`) }))
		.sort((a, b) => a.rank - b.rank || (a.e.id < b.e.id ? -1 : 1));
	const cities = new Set<string>();
	const perRegion = new Map<string, number>();
	const out: Event[] = [];
	for (let cap = 1; out.length < count && cap <= count; cap++) {
		for (const { e } of candidates) {
			if (out.length >= count) break;
			if (cities.has(e.citySlug) || (perRegion.get(e.region) ?? 0) >= cap) continue;
			cities.add(e.citySlug);
			perRegion.set(e.region, (perRegion.get(e.region) ?? 0) + 1);
			out.push(e);
		}
	}
	if (out.length < WEEKEND_MIN) return [];
	return out.sort((a, b) => a.startTime - b.startTime || (a.id < b.id ? -1 : 1));
}
