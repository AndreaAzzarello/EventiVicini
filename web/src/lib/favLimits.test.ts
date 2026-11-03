import { describe, expect, it } from 'vitest';
import { afterChange, changesToday, countersOf, dailyRoom, prioritize } from './favLimits';

const DAY = 86_400_000;
const noon = Date.UTC(2026, 10, 3, 12);

describe('contatori dei preferiti', () => {
	it('profilo senza contatori: tutto a zero', () => expect(countersOf({ name: 'A' })).toEqual({ count: 0, changes: 0, at: null }));
	it('legge i campi del profilo, anche la data come Timestamp', () =>
		expect(countersOf({ favCount: 3, favChanges: 7, favAt: { toMillis: () => noon } })).toEqual({ count: 3, changes: 7, at: noon }));
	it('lo stesso giorno UTC continua a contare, il giorno dopo riparte', () => {
		const c = { count: 10, changes: 99, at: noon };
		expect(changesToday(c, noon + 3_600_000)).toBe(99);
		expect(dailyRoom(c, noon)).toBe(1);
		expect(changesToday(c, noon + DAY)).toBe(0);
		expect(dailyRoom(c, noon + DAY)).toBe(100);
	});
	it('afterChange: aggiungere e togliere contano entrambi, il conteggio non va sotto zero', () => {
		expect(afterChange({ count: 4, changes: 2, at: noon }, 'add', noon)).toEqual({ favCount: 5, favChanges: 3 });
		expect(afterChange({ count: 4, changes: 2, at: noon }, 'remove', noon)).toEqual({ favCount: 3, favChanges: 3 });
		expect(afterChange({ count: 0, changes: 100, at: noon - DAY }, 'remove', noon)).toEqual({ favCount: 0, favChanges: 1 });
	});
});

describe('prioritize', () => {
	const when = new Map([
		['tardi', { start: noon + 5 * DAY, end: noon + 5 * DAY + 1 }],
		['presto', { start: noon + DAY, end: noon + DAY + 1 }],
		['in corso', { start: noon - DAY, end: noon + DAY }],
		['passato', { start: noon - 9 * DAY, end: noon - 8 * DAY }]
	]);
	it('prima i più vicini, poi passati e sconosciuti nell’ordine dato', () =>
		expect(prioritize(['tardi', 'ignoto', 'passato', 'presto', 'in corso'], when, noon)).toEqual(['in corso', 'presto', 'tardi', 'ignoto', 'passato']));
});
