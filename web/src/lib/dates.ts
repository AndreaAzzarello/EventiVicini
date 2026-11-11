// Date sempre in ora italiana, anche quando il server (Worker) gira in UTC.
export const TZ = 'Europe/Rome';

/** Formatter creati alla prima chiamata, non all'import: l'inizializzazione di ICU costa a ogni avvio a freddo del Worker (#51). */
const lazy = <T>(make: () => T): (() => T) => {
	let v: T | undefined;
	return () => (v ??= make());
};

const partsFmt = lazy(
	() =>
		new Intl.DateTimeFormat('en-US', {
			timeZone: TZ,
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
			hourCycle: 'h23',
			weekday: 'short'
		})
);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Ora legale europea (dal 1996): da ultima domenica di marzo a ultima domenica di ottobre, alle 01:00 UTC. Europe/Rome = UTC+1 / UTC+2.
// Calcolata per aritmetica: Intl.DateTimeFormat costa ~10× di più per chiamata, e una lista di centinaia di card ne fa migliaia (#51).
const HOUR = 3_600_000;
const dstCache = new Map<number, [number, number]>();
function lastSundayUtc(year: number, month: number): number {
	const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return last - new Date(Date.UTC(year, month, last)).getUTCDay();
}
function dstRange(year: number): [number, number] {
	let r = dstCache.get(year);
	if (!r) dstCache.set(year, (r = [Date.UTC(year, 2, lastSundayUtc(year, 2), 1), Date.UTC(year, 9, lastSundayUtc(year, 9), 1)]));
	return r;
}
/** Anni in cui le regole UE valgono come qui; fuori (date inventate in un URL) si ricorre a Intl. */
const inEuRules = (ms: number) => ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1);

/** Componenti della data in ora italiana. weekday: 0 = domenica. */
export function romeParts(ms: number) {
	if (!inEuRules(ms)) return romePartsIntl(ms);
	const [start, end] = dstRange(new Date(ms).getUTCFullYear());
	const d = new Date(ms + (ms >= start && ms < end ? 2 * HOUR : HOUR));
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds(),
		weekday: d.getUTCDay()
	};
}

/** Riferimento con Intl (e ripiego per gli anni fuori dalle regole UE note): i test confrontano `romeParts` con questa. */
export function romePartsIntl(ms: number) {
	const p = Object.fromEntries(partsFmt().formatToParts(ms).map((x) => [x.type, x.value]));
	return {
		year: +p.year,
		month: +p.month,
		day: +p.day,
		hour: +p.hour,
		minute: +p.minute,
		second: +p.second,
		weekday: WEEKDAYS.indexOf(p.weekday)
	};
}

/** Istante (ms) corrispondente a una data e ora "da muro" italiana. Regge l'ora legale. */
export function romeTime(year: number, month: number, day: number, hour = 0, minute = 0): number {
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	let ms = wall;
	for (let i = 0; i < 2; i++) {
		const p = romeParts(ms);
		const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
		ms += wall - seen;
	}
	return ms;
}

export type DateWindow = 'any' | 'today' | 'tomorrow' | 'weekend' | 'week' | 'range';

/** Giorni in avanti scelti dal selettore. Oltre non ci sono eventi: è l'orizzonte dell'importer (tools/importer/run.py --horizon-days). */
export const MAX_DAYS = 60;

const z2 = (n: number) => String(n).padStart(2, '0');
/** "2026-11-14" in ora italiana: il valore di <input type="date">. */
export function dayInput(ms: number): string {
	const p = romeParts(ms);
	return `${p.year}-${z2(p.month)}-${z2(p.day)}`;
}
/** "AAAA-MM-GG" -> [anno, mese, giorno], o null se non è una data del calendario. */
export function parseDay(v: string): [number, number, number] | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
	if (!m) return null;
	const [y, mo, d] = [+m[1], +m[2], +m[3]];
	const t = new Date(Date.UTC(y, mo - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

/** Intervallo [da, a) della finestra scelta, in ora italiana. Per 'range', from/to sono "AAAA-MM-GG" (to vuoto = un solo giorno). */
export function windowRange(w: DateWindow, now: number, from = '', to = ''): [number, number] | null {
	if (w === 'any') return null;
	const p = romeParts(now);
	const today = romeTime(p.year, p.month, p.day);
	if (w === 'today') return [today, romeTime(p.year, p.month, p.day + 1)];
	if (w === 'tomorrow') return [romeTime(p.year, p.month, p.day + 1), romeTime(p.year, p.month, p.day + 2)];
	if (w === 'week') return [today, romeTime(p.year, p.month, p.day + 7)];
	if (w === 'range') {
		const a = parseDay(from);
		if (!a) return null;
		const b = (to >= from && parseDay(to)) || a; // 'al' prima di 'dal' o non valido: un giorno solo
		// Il passato non si cerca: un periodo già finito vale come oggi.
		const start = Math.max(romeTime(a[0], a[1], a[2]), today);
		const end = romeTime(b[0], b[1], b[2] + 1);
		return [start, end > start ? end : romeTime(p.year, p.month, p.day + 1)];
	}
	// Di domenica il weekend in corso è iniziato ieri.
	const toSat = p.weekday === 0 ? -1 : 6 - p.weekday;
	return [romeTime(p.year, p.month, p.day + toSat), romeTime(p.year, p.month, p.day + toSat + 2)];
}

// Testi it-IT (stesso risultato di Intl.DateTimeFormat('it-IT'), verificato dai test) da tabelle: niente ICU nel percorso caldo (#51).
const MONTHS_SHORT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const MONTHS_LONG = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const WEEKDAYS_SHORT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const WEEKDAYS_LONG = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

/** "12 nov". */
export const shortDate = (ms: number) => {
	const p = romeParts(ms);
	return `${p.day} ${MONTHS_SHORT[p.month - 1]}`;
};
const longDay = (ms: number, withYear: boolean) => {
	const p = romeParts(ms);
	return `${WEEKDAYS_LONG[p.weekday]} ${p.day} ${MONTHS_LONG[p.month - 1]}${withYear ? ` ${p.year}` : ''}`;
};
const clock = (ms: number) => {
	const p = romeParts(ms);
	return `${z2(p.hour)}:${z2(p.minute)}`;
};

const sameDay = (a: number, b: number) => {
	const x = romeParts(a);
	const y = romeParts(b);
	return x.year === y.year && x.month === y.month && x.day === y.day;
};
export const allDay = (start: number, end: number) => {
	const s = romeParts(start);
	const e = romeParts(end);
	return s.hour === 0 && s.minute === 0 && e.hour === 23 && e.minute === 59;
};

/** "sabato 14 novembre · 21:00–23:30", "dal 12 nov al 15 nov". Anno solo se diverso da quello corrente. */
export function formatWhen(start: number, end: number, now = Date.now()): string {
	if (!sameDay(start, end)) return `dal ${shortDate(start)} al ${shortDate(end)}`;
	const day = longDay(start, romeParts(start).year !== romeParts(now).year);
	if (allDay(start, end)) return `${day} · tutto il giorno`;
	const hours = end > start ? `${clock(start)}–${clock(end)}` : clock(start);
	return `${day} · ${hours}`;
}

/** Etichetta corta per le card: "Oggi", "Domani", "sab 14 nov". */
export function shortDay(start: number, now = Date.now()): string {
	const start0 = Math.max(start, now);
	const p = romeParts(now);
	const tomorrow = romeTime(p.year, p.month, p.day + 1);
	if (sameDay(start0, now)) return 'Oggi';
	if (start0 >= tomorrow && start0 < romeTime(p.year, p.month, p.day + 2)) return 'Domani';
	const c = romeParts(start0);
	return `${WEEKDAYS_SHORT[c.weekday]} ${c.day} ${MONTHS_SHORT[c.month - 1]}`;
}

/** Prima lettera maiuscola: "lun 3 nov" -> "Lun 3 nov". */
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const formatTime = clock;

/** Valore per <input type="datetime-local"> in ora italiana, e ritorno. */
export function toLocalInput(ms: number): string {
	const p = romeParts(ms);
	const z = (n: number) => String(n).padStart(2, '0');
	return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}
export function fromLocalInput(v: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
	return m ? romeTime(+m[1], +m[2], +m[3], +m[4], +m[5]) : NaN;
}
