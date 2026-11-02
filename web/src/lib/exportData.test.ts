import { describe, expect, it } from 'vitest';
import { localKeys, plain } from './exportData';

describe('esportazione dei dati', () => {
	it('i timestamp Firestore diventano ISO, anche annidati', () => {
		const ts = { toDate: () => new Date('2026-11-02T10:00:00Z') };
		expect(plain({ a: ts, b: [ts, 1], c: { d: 'x' }, e: null })).toEqual({
			a: '2026-11-02T10:00:00.000Z',
			b: ['2026-11-02T10:00:00.000Z', 1],
			c: { d: 'x' },
			e: null
		});
	});
	it('senza localStorage le chiavi locali sono vuote, senza lanciare', () => expect(localKeys()).toEqual({}));
});
