import { describe, expect, it } from 'vitest';
import { romeTime, windowRange } from './dates';
import { sections, type Grouping } from './sections';

const ev = (id: string, start: number, endH = 2, longRunning = false) => ({
	id,
	startTime: start,
	endTime: start + endH * 3600_000,
	longRunning
});
const keys = (list: ReturnType<typeof sections<ReturnType<typeof ev>>>) => list.map((s) => `${s.key}:${s.events.map((e) => e.id).join(',')}`);

describe('sections', () => {
	const wed = romeTime(2026, 10, 28, 15); // mercoledì 15:00

	it('mercoledì: oggi, stasera, prossimi giorni, weekend, più avanti, in corso', () => {
		const list = [
			ev('mattina', romeTime(2026, 10, 28, 10), 8), // già iniziato, ancora in corso: oggi
			ev('pomeriggio', romeTime(2026, 10, 28, 16)),
			ev('sera', romeTime(2026, 10, 28, 21)),
			ev('giovedi', romeTime(2026, 10, 29, 10)),
			ev('sabato', romeTime(2026, 10, 31, 20)),
			ev('domenica', romeTime(2026, 11, 1, 11)),
			ev('lunedi', romeTime(2026, 11, 2, 11)),
			ev('mostra', romeTime(2026, 10, 1, 9), 24 * 60, true)
		];
		expect(keys(sections(list, wed))).toEqual([
			'today:mattina,pomeriggio',
			'tonight:sera',
			'soon:giovedi',
			'weekend:sabato,domenica',
			'later:lunedi',
			'running:mostra'
		]);
		expect(sections(list, wed).map((s) => s.title)).toEqual(['Oggi', 'Stasera', 'Prossimi giorni', 'Questo weekend', 'Più avanti', 'In corso']);
	});

	it('ogni evento sta in una sola sezione', () => {
		const list = [ev('a', romeTime(2026, 10, 28, 18)), ev('b', romeTime(2026, 10, 31, 9)), ev('c', romeTime(2026, 11, 20, 9))];
		expect(sections(list, wed).flatMap((s) => s.events).map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
	});

	it('sezioni vuote nascoste e lista vuota', () => {
		expect(sections([], wed)).toEqual([]);
		expect(keys(sections([ev('x', romeTime(2026, 10, 28, 19))], wed))).toEqual(['tonight:x']);
	});

	it('sabato: il resto del weekend è weekend, da lunedì "Prossimi giorni"', () => {
		const sat = romeTime(2026, 10, 31, 12);
		const list = [ev('oggi', romeTime(2026, 10, 31, 15)), ev('dom', romeTime(2026, 11, 1, 10)), ev('lun', romeTime(2026, 11, 2, 10))];
		const out = sections(list, sat);
		expect(keys(out)).toEqual(['today:oggi', 'weekend:dom', 'later:lun']);
		expect(out[2].title).toBe('Prossimi giorni');
	});

	it('domenica: il weekend in corso non apre una sezione dopo oggi', () => {
		const sun = romeTime(2026, 11, 1, 12);
		expect(keys(sections([ev('sera', romeTime(2026, 11, 1, 20)), ev('mar', romeTime(2026, 11, 3, 10))], sun))).toEqual(['tonight:sera', 'later:mar']);
	});

	it('venerdì: sabato è weekend e non c’è "Prossimi giorni"', () => {
		const fri = romeTime(2026, 10, 30, 12);
		expect(keys(sections([ev('sab', romeTime(2026, 10, 31, 10))], fri))).toEqual(['weekend:sab']);
	});

	it('una sagra iniziata ieri e ancora aperta (non lunga) è "Oggi"', () => {
		expect(keys(sections([ev('sagra', romeTime(2026, 10, 27, 20), 48)], wed))).toEqual(['today:sagra']);
	});

	it('cambio ora legale: la sera del 25 ottobre resta "Stasera"', () => {
		const sun = romeTime(2026, 10, 25, 9);
		expect(keys(sections([ev('sera', romeTime(2026, 10, 25, 18, 30))], sun))).toEqual(['tonight:sera']);
	});
});

describe('sections con un filtro di date', () => {
	const wed = romeTime(2026, 10, 28, 15);
	const weekend = (at = wed): Grouping => ({ range: windowRange('weekend', at)!, when: 'weekend' });
	const titled = (list: ReturnType<typeof ev>[], g: Grouping | null, at = wed) =>
		sections(list, at, g).map((s) => `${s.title}:${s.events.map((e) => e.id).join(',')}`);

	it('Weekend di mercoledì: nessun «Oggi», l’evento lungo conta da sabato', () => {
		const list = [
			ev('lungo', romeTime(2026, 10, 20, 10), 24 * 14), // iniziato la settimana scorsa, finisce dopo il weekend
			ev('sab', romeTime(2026, 10, 31, 20)),
			ev('dom', romeTime(2026, 11, 1, 11))
		];
		expect(titled(list, weekend())).toEqual(['Sabato 31:lungo,sab', 'Domenica 1:dom']);
	});

	it('chiavi di sezione stabili per giorno', () => {
		expect(sections([ev('sab', romeTime(2026, 10, 31, 20))], wed, weekend()).map((s) => s.key)).toEqual(['d-2026-10-31']);
	});

	it('mostre e rassegne lunghe: «In corso nel weekend», in fondo', () => {
		const list = [ev('mostra', romeTime(2026, 10, 1, 9), 24 * 60, true), ev('sab', romeTime(2026, 10, 31, 20))];
		expect(sections(list, wed, weekend()).map((s) => s.title)).toEqual(['Sabato 31', 'In corso nel weekend']);
	});

	it('sabato: Oggi, Stasera e Domani', () => {
		const sat = romeTime(2026, 10, 31, 12);
		const list = [ev('a', romeTime(2026, 10, 31, 15)), ev('b', romeTime(2026, 10, 31, 20)), ev('c', romeTime(2026, 11, 1, 10))];
		expect(titled(list, weekend(sat), sat)).toEqual(['Oggi:a', 'Stasera:b', 'Domani:c']);
	});

	it('domenica: l’evento iniziato sabato e ancora aperto è «Oggi»', () => {
		const sun = romeTime(2026, 11, 1, 12);
		expect(titled([ev('festa', romeTime(2026, 10, 31, 20), 30)], weekend(sun), sun)).toEqual(['Oggi:festa']);
	});

	it('Domani: gli eventi in corso contano come domani; mostre «In corso domani»', () => {
		const g: Grouping = { range: windowRange('tomorrow', wed)!, when: 'tomorrow' };
		const list = [ev('sagra', romeTime(2026, 10, 27, 20), 72), ev('mostra', romeTime(2026, 10, 1, 9), 24 * 60, true)];
		expect(titled(list, g)).toEqual(['Domani:sagra', 'In corso domani:mostra']);
	});

	it('7 giorni: un gruppo per giorno, mostre «In corso in questi giorni»', () => {
		const g: Grouping = { range: windowRange('week', wed)!, when: 'week' };
		const list = [ev('oggi', romeTime(2026, 10, 28, 16)), ev('ven', romeTime(2026, 10, 30, 10)), ev('mostra', romeTime(2026, 10, 1, 9), 24 * 60, true)];
		expect(titled(list, g)).toEqual(['Oggi:oggi', 'Venerdì 30:ven', 'In corso in questi giorni:mostra']);
	});

	it('Scegli date fino a 14 giorni: per giorno', () => {
		const g: Grouping = { range: windowRange('range', wed, '2026-11-02', '2026-11-15')!, when: 'range' }; // 14 giorni
		expect(titled([ev('a', romeTime(2026, 11, 2, 10)), ev('b', romeTime(2026, 11, 9, 10))], g)).toEqual(['Lunedì 2:a', 'Lunedì 9:b']);
	});

	it('Scegli date oltre 14 giorni: per settimana, «Settimana dal 2 nov»', () => {
		const g: Grouping = { range: windowRange('range', wed, '2026-11-02', '2026-11-16')!, when: 'range' }; // 15 giorni
		const list = [
			ev('a', romeTime(2026, 11, 2, 10)),
			ev('b', romeTime(2026, 11, 8, 20)), // domenica: ancora la settimana del 2
			ev('c', romeTime(2026, 11, 9, 10)),
			ev('d', romeTime(2026, 11, 16, 10)),
			ev('mostra', romeTime(2026, 10, 1, 9), 24 * 60, true)
		];
		expect(titled(list, g)).toEqual(['Settimana dal 2 nov:a,b', 'Settimana dal 9 nov:c', 'Settimana dal 16 nov:d', 'In corso in questi giorni:mostra']);
		expect(sections(list, wed, g).map((s) => s.key).slice(0, 2)).toEqual(['w-2026-11-02', 'w-2026-11-09']);
	});

	it('Scegli date oltre 14 giorni da metà settimana: la prima settimana parte dal primo giorno scelto', () => {
		const g: Grouping = { range: windowRange('range', wed, '2026-11-04', '2026-11-25')!, when: 'range' };
		const list = [ev('lungo', romeTime(2026, 10, 20, 10), 24 * 30), ev('x', romeTime(2026, 11, 12, 10))];
		expect(titled(list, g)).toEqual(['Settimana dal 4 nov:lungo', 'Settimana dal 9 nov:x']);
	});

	it('cambio ora legale (25 ottobre): la domenica resta un giorno solo', () => {
		const thu = romeTime(2026, 10, 22, 12);
		const list = [ev('sab', romeTime(2026, 10, 24, 22)), ev('dom-notte', romeTime(2026, 10, 25, 1)), ev('dom', romeTime(2026, 10, 25, 18, 30))];
		expect(titled(list, weekend(thu), thu)).toEqual(['Sabato 24:sab', 'Domenica 25:dom-notte,dom']);
	});

	it('senza raggruppamento il comportamento è quello di prima', () => {
		expect(titled([ev('x', romeTime(2026, 10, 28, 16))], null)).toEqual(['Oggi:x']);
	});
});
