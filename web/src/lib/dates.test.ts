import { describe, expect, it } from 'vitest';
import { dayInput, formatWhen, fromLocalInput, parseDay, romeParts, romeTime, shortDay, toLocalInput, windowRange } from './dates';

describe('ora italiana', () => {
	it('romeTime regge ora legale e solare', () => {
		expect(new Date(romeTime(2026, 7, 15, 21, 0)).toISOString()).toBe('2026-07-15T19:00:00.000Z');
		expect(new Date(romeTime(2026, 12, 15, 21, 0)).toISOString()).toBe('2026-12-15T20:00:00.000Z');
		// giorno del cambio d'ora (25 ottobre 2026): mezzanotte è ancora CEST
		expect(new Date(romeTime(2026, 10, 25)).toISOString()).toBe('2026-10-24T22:00:00.000Z');
	});
	it('romeParts', () =>
		expect(romeParts(Date.parse('2026-10-31T23:30:00Z'))).toMatchObject({ month: 11, day: 1, hour: 0, weekday: 0 }));
	it('datetime-local andata e ritorno', () => {
		const ms = romeTime(2026, 3, 29, 10, 30);
		expect(toLocalInput(ms)).toBe('2026-03-29T10:30');
		expect(fromLocalInput('2026-03-29T10:30')).toBe(ms);
		expect(fromLocalInput('')).toBeNaN();
	});
});

describe('finestre', () => {
	const wed = romeTime(2026, 10, 28, 15); // mercoledì
	const sun = romeTime(2026, 11, 1, 15); // domenica
	it('oggi', () => expect(windowRange('today', wed)).toEqual([romeTime(2026, 10, 28), romeTime(2026, 10, 29)]));
	it('weekend da mercoledì', () =>
		expect(windowRange('weekend', wed)).toEqual([romeTime(2026, 10, 31), romeTime(2026, 11, 2)]));
	it('weekend di domenica è quello in corso', () =>
		expect(windowRange('weekend', sun)).toEqual([romeTime(2026, 10, 31), romeTime(2026, 11, 2)]));
	it('qualsiasi', () => expect(windowRange('any', wed)).toBeNull());
	it('domani', () => expect(windowRange('tomorrow', wed)).toEqual([romeTime(2026, 10, 29), romeTime(2026, 10, 30)]));
	it('prossimi 7 giorni: da oggi, 7 giorni interi', () =>
		expect(windowRange('week', wed)).toEqual([romeTime(2026, 10, 28), romeTime(2026, 11, 4)]));

	describe('a cavallo del mese e del fuso', () => {
		it('domani il 31 ottobre è il 1 novembre', () =>
			expect(windowRange('tomorrow', romeTime(2026, 10, 31, 10))).toEqual([romeTime(2026, 11, 1), romeTime(2026, 11, 2)]));
		it('weekend sab 31/10 – dom 1/11 visto da venerdì sera', () =>
			expect(windowRange('weekend', romeTime(2026, 10, 30, 23, 59))).toEqual([romeTime(2026, 10, 31), romeTime(2026, 11, 2)]));
		it("weekend a cavallo dell'anno (sab 2/1 – dom 3/1)", () =>
			expect(windowRange('weekend', romeTime(2026, 12, 31, 12))).toEqual([romeTime(2027, 1, 2), romeTime(2027, 1, 4)]));
		it('23:30 UTC del 31/10 è già il 1/11 a Roma: oggi è domenica', () =>
			expect(windowRange('today', Date.parse('2026-10-31T23:30:00Z'))).toEqual([romeTime(2026, 11, 1), romeTime(2026, 11, 2)]));
		it("ora solare: domani il 25/10 dura 25 ore (cambio dell'ora)", () => {
			const [a, b] = windowRange('tomorrow', romeTime(2026, 10, 24, 12))!;
			expect(a).toBe(romeTime(2026, 10, 25));
			expect((b - a) / 3600_000).toBe(25);
		});
		it("ora legale: domani il 29/3 dura 23 ore (cambio dell'ora)", () => {
			const [a, b] = windowRange('tomorrow', romeTime(2026, 3, 28, 12))!;
			expect(a).toBe(romeTime(2026, 3, 29));
			expect((b - a) / 3600_000).toBe(23);
			expect(windowRange('week', romeTime(2026, 3, 27, 12))![1]).toBe(romeTime(2026, 4, 3));
		});
	});

	describe('periodo scelto', () => {
		it('un giorno solo se "al" manca', () =>
			expect(windowRange('range', wed, '2026-11-14')).toEqual([romeTime(2026, 11, 14), romeTime(2026, 11, 15)]));
		it('periodo inclusivo, anche a cavallo del mese', () =>
			expect(windowRange('range', wed, '2026-10-31', '2026-11-02')).toEqual([romeTime(2026, 10, 31), romeTime(2026, 11, 3)]));
		it("periodo che attraversa il cambio dell'ora", () => {
			const [a, b] = windowRange('range', romeTime(2026, 10, 20, 12), '2026-10-24', '2026-10-25')!;
			expect((b - a) / 3600_000).toBe(49);
		});
		it('"al" prima di "dal" o non valido: un giorno solo', () => {
			expect(windowRange('range', wed, '2026-11-14', '2026-11-10')).toEqual([romeTime(2026, 11, 14), romeTime(2026, 11, 15)]);
			expect(windowRange('range', wed, '2026-11-14', 'boh')).toEqual([romeTime(2026, 11, 14), romeTime(2026, 11, 15)]);
		});
		it('il passato vale come oggi', () =>
			expect(windowRange('range', wed, '2026-10-01', '2026-10-03')).toEqual([romeTime(2026, 10, 28), romeTime(2026, 10, 29)]));
		it('data non valida: nessun filtro', () => {
			expect(windowRange('range', wed, '')).toBeNull();
			expect(windowRange('range', wed, '2026-02-30')).toBeNull();
		});
	});
});

describe('giorni "AAAA-MM-GG"', () => {
	it('parseDay', () => {
		expect(parseDay('2026-11-14')).toEqual([2026, 11, 14]);
		for (const v of ['', '2026-13-01', '2026-02-29', '14/11/2026', '2026-1-1']) expect(parseDay(v)).toBeNull();
		expect(parseDay('2028-02-29')).toEqual([2028, 2, 29]);
	});
	it('dayInput usa il giorno di Roma, non quello UTC', () =>
		expect(dayInput(Date.parse('2026-10-31T23:30:00Z'))).toBe('2026-11-01'));
});

describe('formattazione', () => {
	const now = romeTime(2026, 10, 28, 9);
	it('stesso giorno con orario', () =>
		expect(formatWhen(romeTime(2026, 11, 14, 21), romeTime(2026, 11, 14, 23, 30), now)).toBe(
			'sabato 14 novembre · 21:00–23:30'
		));
	it('tutto il giorno', () =>
		expect(formatWhen(romeTime(2026, 11, 14), romeTime(2026, 11, 14, 23, 59), now)).toBe(
			'sabato 14 novembre · tutto il giorno'
		));
	it('più giorni', () =>
		expect(formatWhen(romeTime(2026, 11, 12, 10), romeTime(2026, 11, 15, 18), now)).toBe('dal 12 nov al 15 nov'));
	it('anno diverso', () => expect(formatWhen(romeTime(2027, 1, 6, 10), romeTime(2027, 1, 6, 12), now)).toMatch(/2027/));
	it('oggi, domani, in corso', () => {
		expect(shortDay(romeTime(2026, 10, 28, 20), now)).toBe('Oggi');
		expect(shortDay(romeTime(2026, 10, 29, 20), now)).toBe('Domani');
		expect(shortDay(romeTime(2026, 10, 20, 20), now)).toBe('Oggi');
	});
});
