import { romeParts, romeTime, sentence, shortDate, weekdayLong, windowRange, type DateWindow } from './dates';
import type { Event } from './event';

export type SectionKey = string;
export type Section = { key: SectionKey; title: string; events: Event[] };

/** Dalle 18 in poi un evento di oggi è "stasera". */
export const EVENING_HOUR = 18;

/** Fino a questo numero di giorni un filtro di date raggruppa per giorno; oltre, per settimana. */
export const MAX_DAY_GROUPS = 14;

const DAY_MS = 86_400_000;
const z2 = (n: number) => String(n).padStart(2, '0');

/** L'intervallo scelto con un filtro di date (vedi `groupingFor` in filters.ts): la lista si raggruppa per quello, non per il tempo da adesso. */
export type Grouping = { range: [number, number]; when: DateWindow };

type Timed = Pick<Event, 'startTime' | 'endTime' | 'longRunning'>;
type Group<T> = { key: SectionKey; title: string; events: T[] };

/**
 * Divide una lista (già filtrata e ordinata) in sezioni, in ora italiana. Ogni evento sta in una sola sezione;
 * l'ordine interno è quello ricevuto. Mostre e rassegne lunghe (longRunning) vanno a parte, in "In corso", in fondo.
 *
 * Senza `grouping` (nessun filtro di date, o «Oggi») si raggruppa per tempo da adesso: Oggi, Stasera, Prossimi giorni, Questo weekend,
 * Più avanti; un evento già iniziato conta da adesso (una sagra iniziata ieri è "Oggi").
 * Con `grouping` un evento conta dal primo momento dentro l'intervallo scelto: un gruppo per giorno («Oggi», «Domani», «Sabato 21»),
 * o per settimana («Settimana dal 23 nov») se l'intervallo supera MAX_DAY_GROUPS giorni.
 */
export function sections<T extends Timed>(events: T[], now: number, grouping: Grouping | null = null): Group<T>[] {
	return grouping ? byRange(events, now, grouping) : byTime(events, now);
}

function byTime<T extends Timed>(events: T[], now: number): Group<T>[] {
	const [dayStart, dayEnd] = windowRange('today', now)!;
	const [weekendStart, weekendEnd] = windowRange('weekend', now)!;
	const weekendNow = weekendStart <= dayStart; // sabato o domenica: il weekend è già qui
	const buckets: Record<string, T[]> = { today: [], tonight: [], soon: [], weekend: [], later: [], running: [] };

	for (const e of events) {
		const t = Math.max(e.startTime, now);
		let key: string;
		if (e.longRunning) key = 'running';
		else if (t < dayEnd) key = e.startTime >= dayStart && romeParts(e.startTime).hour >= EVENING_HOUR ? 'tonight' : 'today';
		else if (t >= weekendStart && t < weekendEnd) key = 'weekend';
		else if (t < weekendStart) key = 'soon';
		else key = 'later';
		buckets[key].push(e);
	}

	const titles: Record<string, string> = {
		today: 'Oggi',
		tonight: 'Stasera',
		soon: 'Prossimi giorni',
		weekend: 'Questo weekend',
		later: weekendNow ? 'Prossimi giorni' : 'Più avanti',
		running: 'In corso'
	};
	return ['today', 'tonight', 'soon', 'weekend', 'later', 'running']
		.filter((key) => buckets[key].length)
		.map((key) => ({ key, title: titles[key], events: buckets[key] }));
}

const RUNNING_TITLE: Partial<Record<DateWindow, string>> = { tomorrow: 'In corso domani', weekend: 'In corso nel weekend' };

function byRange<T extends Timed>(events: T[], now: number, { range: [rangeStart, rangeEnd], when }: Grouping): Group<T>[] {
	const p = romeParts(now);
	const dayStart = romeTime(p.year, p.month, p.day);
	const tomorrowStart = romeTime(p.year, p.month, p.day + 1);
	const from = Math.max(rangeStart, now); // da qui un evento già iniziato "comincia"
	const first = Math.max(rangeStart, dayStart); // primo giorno dell'intervallo (mai nel passato)
	const weekly = Math.round((rangeEnd - first) / DAY_MS) > MAX_DAY_GROUPS;

	const groups = new Map<number, Group<T>>(); // per istante di inizio del gruppo: l'ordine è cronologico
	const running: T[] = [];
	const put = (order: number, key: string, title: string, e: T) => {
		const g = groups.get(order) ?? { key, title, events: [] as T[] };
		g.events.push(e);
		groups.set(order, g);
	};

	for (const e of events) {
		if (e.longRunning) {
			running.push(e);
			continue;
		}
		const t = Math.max(e.startTime, from);
		const c = romeParts(t);
		if (weekly) {
			const monday = romeTime(c.year, c.month, c.day - ((c.weekday + 6) % 7));
			const label = Math.max(monday, first); // la prima settimana parte dal primo giorno scelto
			const l = romeParts(label);
			put(label, `w-${l.year}-${z2(l.month)}-${z2(l.day)}`, `Settimana dal ${shortDate(label)}`, e);
			continue;
		}
		const ds = romeTime(c.year, c.month, c.day);
		const key = `d-${c.year}-${z2(c.month)}-${z2(c.day)}`;
		if (ds === dayStart) {
			const evening = e.startTime >= dayStart && romeParts(e.startTime).hour >= EVENING_HOUR;
			put(ds * 2 + (evening ? 1 : 0), evening ? `${key}-sera` : key, evening ? 'Stasera' : 'Oggi', e);
		} else if (ds === tomorrowStart) put(ds * 2, key, 'Domani', e);
		else put(ds * 2, key, `${sentence(weekdayLong(ds))} ${c.day}`, e);
	}

	const out = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
	if (running.length) out.push({ key: 'running', title: RUNNING_TITLE[when] ?? 'In corso in questi giorni', events: running });
	return out;
}
