// Parità dello schema evento con l'importer Python e con firestore.rules (#18).
// Fonte condivisa: docs/schema/parity.json, letta anche da tools/importer/tests/test_schema_parity.py e da
// firebase/test/parity.test.js. Come aggiornarla: docs/importer.md, sezione «Schema evento».
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, EVENT_KEYS, PRICE_TYPES, fromData, isForKids, slugify } from './event';

const PARITY = JSON.parse(readFileSync(new URL('../../../docs/schema/parity.json', import.meta.url), 'utf8')) as {
	categories: string[];
	priceTypes: string[];
	sources: string[];
	eventKeys: string[];
	eventOptionalKeys: string[];
	importerOnlyKeys: string[];
	kidsTags: string[];
	slugify: { in: string; out: string }[];
};

describe('parità con docs/schema/parity.json', () => {
	it('le categorie coincidono', () => {
		expect(Object.keys(CATEGORIES)).toEqual(PARITY.categories);
	});

	it('i tipi di prezzo coincidono', () => {
		expect(Object.keys(PRICE_TYPES)).toEqual(PARITY.priceTypes);
	});

	it('i campi dell’evento (EventInput) coincidono', () => {
		expect([...EVENT_KEYS]).toEqual(PARITY.eventKeys);
	});

	it('fromData produce solo campi dichiarati nel file condiviso', () => {
		const doc = Object.fromEntries([...PARITY.eventKeys, ...PARITY.eventOptionalKeys, ...PARITY.importerOnlyKeys].map((k) => [k, 'x']));
		const ev = fromData('id1', { ...doc, tags: ['a'], source: 'scraper', category: 'music', priceType: 'free', approxLocation: true, longRunning: true });
		const allowed = new Set(['id', ...PARITY.eventKeys, ...PARITY.eventOptionalKeys, ...PARITY.importerOnlyKeys]);
		expect(Object.keys(ev).filter((k) => !allowed.has(k))).toEqual([]);
		// e ogni campo obbligatorio del file condiviso è presente nell'evento letto
		expect(PARITY.eventKeys.filter((k) => !(k in ev))).toEqual([]);
	});

	it('slugify dà gli stessi risultati di Python (almeno 20 casi)', () => {
		expect(PARITY.slugify.length).toBeGreaterThanOrEqual(20);
		for (const c of PARITY.slugify) expect(slugify(c.in), JSON.stringify(c.in)).toBe(c.out);
	});

	it('i tag «bambini» dell’importer sono riconosciuti da isForKids', () => {
		for (const tag of PARITY.kidsTags) expect(isForKids({ category: 'other', tags: [tag] }), tag).toBe(true);
	});

	it('i valori di source ammessi coincidono con quelli che fromData riconosce', () => {
		for (const s of PARITY.sources) expect(fromData('i', { source: s }).source).toBe(s);
	});
});
