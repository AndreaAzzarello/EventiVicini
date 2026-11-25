// «Questo weekend» della home (#22): finestra (parità con tools/importer/weekend.py) e scelta degli eventi.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromData, type Event } from './event';
import { WEEKEND_COUNT, WEEKEND_MIN, pickWeekend, weekendWindow } from './weekend';

const PARITY = JSON.parse(readFileSync(new URL('../../../docs/schema/parity.json', import.meta.url), 'utf8')) as {
	weekendWindows: { now: string; start: string; end: string }[];
};
const ms = (iso: string) => Date.parse(iso);
const NOW = ms('2026-11-25T09:17:00+01:00'); // mercoledì
const [LO, HI] = [ms('2026-11-27T18:00:00+01:00'), ms('2026-11-29T23:59:59.999+01:00')];
const H = 3_600_000;

describe('weekendWindow', () => {
	it.each(PARITY.weekendWindows)('coincide con il file condiviso: $now', ({ now, start, end }) => {
		expect(weekendWindow(ms(now))).toEqual([ms(start), ms(end)]);
	});
	it('ven 18:00 – dom 23:59:59,999 in ora italiana; dal lunedì il weekend che arriva', () => {
		expect(weekendWindow(NOW)).toEqual([LO, HI]);
		expect(weekendWindow(LO - 1)).toEqual([LO, HI]);
		expect(weekendWindow(HI)).toEqual([LO, HI]);
		expect(weekendWindow(HI + 1)[0]).toBeGreaterThan(HI);
	});
	it('ci sono almeno dodici casi, tra cui i due cambi di ora legale', () => {
		expect(PARITY.weekendWindows.length).toBeGreaterThanOrEqual(12);
		expect(new Set(PARITY.weekendWindows.flatMap((c) => [c.start.slice(-6), c.end.slice(-6)]))).toEqual(new Set(['+01:00', '+02:00']));
	});
});

let n = 0;
const ev = (city: string, region: string, over: Record<string, unknown> = {}): Event =>
	fromData(`e${String(++n).padStart(3, '0')}`, {
		title: `Evento ${n}`, city, citySlug: city.toLowerCase(), region, province: 'XX', lat: 44.6, lng: 10.9,
		startTime: LO + H, endTime: LO + 3 * H, category: 'music', priceType: 'free', ...over
	});
const ids = (l: Event[]) => l.map((e) => e.id);

describe('pickWeekend', () => {
	const sample = () => [ev('Modena', 'Emilia-Romagna'), ev('Bologna', 'Emilia-Romagna'), ev('Roma', 'Lazio'), ev('Lecce', 'Puglia'), ev('Bolzano', 'Trentino-Alto Adige'), ev('Aosta', "Valle d'Aosta"), ev('Torino', 'Piemonte')];

	it('al massimo 5 eventi, una città una volta sola, regioni diverse per prime', () => {
		const out = pickWeekend(sample(), NOW);
		expect(out).toHaveLength(WEEKEND_COUNT);
		expect(new Set(out.map((e) => e.citySlug)).size).toBe(WEEKEND_COUNT);
		// 6 regioni disponibili: nessuna ne ripete una prima di averle usate tutte
		expect(new Set(out.map((e) => e.region)).size).toBe(WEEKEND_COUNT);
	});
	it('stessa scelta per tutto il giorno, ordinata per inizio; cambia il giorno dopo', () => {
		const events = sample().map((e, i) => ({ ...e, startTime: LO + (7 - i) * H, endTime: LO + (9 - i) * H }));
		const a = pickWeekend(events, NOW);
		expect(ids(pickWeekend(events, NOW + 6 * H))).toEqual(ids(a));
		expect(a.map((e) => e.startTime)).toEqual([...a.map((e) => e.startTime)].sort((x, y) => x - y));
		const manyDays = new Set(Array.from({ length: 12 }, (_, d) => ids(pickWeekend(events, NOW - d * 24 * H)).join()));
		expect(manyDays.size).toBeGreaterThan(1);
	});
	it('se le regioni non bastano, una seconda dalla stessa regione (ma mai la stessa città)', () => {
		const events = [ev('Modena', 'ER'), ev('Bologna', 'ER'), ev('Parma', 'ER'), ev('Roma', 'Lazio'), ev('Rieti', 'Lazio'), ev('Latina', 'Lazio'), ev('Modena', 'ER', { startTime: LO + 5 * H, endTime: LO + 6 * H })];
		const out = pickWeekend(events, NOW);
		expect(out).toHaveLength(5);
		expect(out.filter((e) => e.citySlug === 'modena')).toHaveLength(1);
		expect(out.filter((e) => e.region === 'Lazio').length).toBeGreaterThanOrEqual(2);
	});
	it('esclusi: lunga durata, posizione approssimata, già finiti e fuori finestra', () => {
		const bad = [
			ev('Lunga', 'A', { startTime: LO, endTime: LO + 20 * 24 * H }),
			ev('Approssimata', 'B', { approxLocation: true }),
			ev('Finita', 'C', { startTime: ms('2026-11-28T10:00:00+01:00'), endTime: ms('2026-11-28T12:00:00+01:00') }),
			ev('Prima', 'D', { startTime: LO - 2 * H, endTime: LO }),
			ev('Dopo', 'E', { startTime: HI + H, endTime: HI + 2 * H }),
			ev('Senzacoord', 'F', { lat: 0, lng: 0 })
		];
		const sat = { startTime: ms('2026-11-28T10:00:00+01:00'), endTime: ms('2026-11-28T22:00:00+01:00') };
		const good = [ev('Uno', 'G', sat), ev('Due', 'H', sat), ev('Tre', 'I', sat)];
		const now = ms('2026-11-28T18:00:00+01:00');
		expect(ids(pickWeekend([...bad, ...good], now)).sort()).toEqual(ids(good).sort());
	});
	it('con meno di 3 eventi la fascia non c’è', () => {
		expect(WEEKEND_MIN).toBe(3);
		expect(pickWeekend(sample().slice(0, 2), NOW)).toEqual([]);
		expect(pickWeekend(sample().slice(0, 3), NOW)).toHaveLength(3);
		expect(pickWeekend([], NOW)).toEqual([]);
	});
	it('rifiltra sull’ora di adesso: domenica tarda restano solo quelli ancora in corso', () => {
		const sat = ms('2026-11-28T10:00:00+01:00');
		const events = [ev('A', 'R1', { startTime: sat, endTime: sat + H }), ev('B', 'R2', { startTime: sat, endTime: sat + 40 * H }), ev('C', 'R3', { startTime: sat, endTime: sat + 40 * H }), ev('D', 'R4', { startTime: sat, endTime: sat + 40 * H })];
		expect(pickWeekend(events, ms('2026-11-29T20:00:00+01:00'))).toHaveLength(3);
	});
});
