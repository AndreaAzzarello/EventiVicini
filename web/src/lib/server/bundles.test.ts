import { geohashForLocation } from 'geofire-common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIELDS, cellsAround, rowToEvent } from './bundles';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_FIREBASE_PROJECT_ID: 'p', PUBLIC_FIREBASE_API_KEY: 'k' } }));

const modena = { lat: 44.65, lng: 10.95 };

describe('cellsAround', () => {
	it('include la cella del centro e di un punto sul bordo del cerchio, non una lontana', () => {
		const cells = cellsAround(modena, 25);
		expect(cells).toContain(`g_${geohashForLocation([modena.lat, modena.lng], 4)}`);
		const edge = { lat: modena.lat + 24 / 111.2, lng: modena.lng };
		expect(cells).toContain(`g_${geohashForLocation([edge.lat, edge.lng], 4)}`);
		expect(cells).not.toContain(`g_${geohashForLocation([41.9, 12.5], 4)}`);
		expect(cells.length).toBeLessThanOrEqual(12);
		expect(new Set(cells).size).toBe(cells.length);
	});
});

describe('rowToEvent', () => {
	it('ricostruisce la card dai campi nell\'ordine di FIELDS', () => {
		const row: unknown[] = FIELDS.map((f) => ({ id: 'a1', title: 'Jazz', startTime: 1, endTime: 2, category: 'music', lat: 44.6, lng: 10.9, tags: ['kids'], longRunning: false, approxLocation: true, city: 'Modena' })[f] ?? '');
		expect(rowToEvent(row)).toMatchObject({ id: 'a1', title: 'Jazz', category: 'music', city: 'Modena', approxLocation: true, tags: ['kids'] });
	});
});

describe('rowToEvent: scale piccole (#95)', () => {
	const cols = (n: number) => FIELDS.slice(0, n).map((f) => ({ id: 'a1', title: 'Jazz', startTime: 1, endTime: 2, category: 'music', imageUrl: 'https://c.it/image-800-aa.jpeg' })[f] ?? '');
	it('riga nuova: mini e preview', () => {
		const row = FIELDS.map((f) => ({ id: 'a1', title: 'Jazz', imageMiniUrl: 'https://c.it/image-200-aa.jpeg', imagePreviewUrl: 'https://c.it/image-400-bb.jpeg' })[f] ?? '');
		expect(rowToEvent(row)).toMatchObject({ imageMiniUrl: 'https://c.it/image-200-aa.jpeg', imagePreviewUrl: 'https://c.it/image-400-bb.jpeg' });
	});
	it('riga di un bundle scritto prima (20 campi): nessuna scala, imageUrl intatto', () => {
		const e = rowToEvent(cols(20));
		expect(e.imageMiniUrl).toBeUndefined();
		expect(e.imagePreviewUrl).toBeUndefined();
		expect(e.imageUrl).toBe('https://c.it/image-800-aa.jpeg');
	});
	it('riga con stringhe vuote (fonti senza scale): campi non valorizzati', () => {
		const e = rowToEvent(cols(FIELDS.length));
		expect(e.imageMiniUrl).toBeUndefined();
	});
	it('URL non http(s) scartati', () => {
		const row = FIELDS.map((f) => ({ id: 'a1', imageMiniUrl: 'javascript:alert(1)' })[f] ?? '');
		expect(rowToEvent(row).imageMiniUrl).toBeUndefined();
	});
});

describe('letture dai bundle', () => {
	const H = 3_600_000;
	const rowOf = (id: string, over: Record<string, unknown> = {}) =>
		FIELDS.map((f) => ({ id, title: id, startTime: Date.now() + H, endTime: Date.now() + 2 * H, category: 'music', priceType: 'free', lat: modena.lat, lng: modena.lng, tags: [], ...over })[f] ?? '');
	const doc = (name: string, fields: Record<string, unknown>) => ({
		found: { name: `projects/p/databases/(default)/documents/bundles/${name}`, fields }
	});
	const str = (stringValue: string) => ({ stringValue });
	let batches: string[][];

	beforeEach(() => {
		vi.resetModules();
		batches = [];
		const center = `g_${geohashForLocation([modena.lat, modena.lng], 4)}`;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
			if (url.includes('/bundles/coverage')) return new Response(JSON.stringify({ name: 'x', fields: { json: str('[]') } }));
			const names: string[] = JSON.parse(init!.body!).documents.map((d: string) => d.split('/bundles/')[1]);
			batches.push(names);
			const out = names.flatMap((n) => {
				if (n === center) return [doc(n, { json: str(JSON.stringify([rowOf('e1'), rowOf('vecchio', { endTime: 1 })])), parts: { integerValue: '2' } })];
				if (n === `${center}~1`) return [doc(n, { json: str(JSON.stringify([rowOf('e2'), rowOf('e1')])) })];
				return []; // cella senza eventi: nessun documento
			});
			return new Response(JSON.stringify(out.length ? out : [{ missing: 'x' }]));
		}));
	});
	afterEach(() => vi.unstubAllGlobals());

	it('una richiesta per le celle, una seconda per le parti; scarta finiti e doppioni', async () => {
		const { eventsNear } = await import('./firestore');
		const events = await eventsNear(modena, 25);
		expect(events.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
		expect(batches).toHaveLength(2);
		expect(batches[1]).toHaveLength(1);
	});
});
