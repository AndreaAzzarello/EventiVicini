// Lettura di bundles/weekend (#22): chiave legata alla version, bundle assente = nessuna fascia, nessuna lettura prima del primo import.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIELDS } from './bundles';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_FIREBASE_PROJECT_ID: 'p', PUBLIC_FIREBASE_API_KEY: 'k' } }));

const H = 3_600_000;
const str = (stringValue: string) => ({ stringValue });
const rowOf = (id: string, over: Record<string, unknown> = {}) =>
	FIELDS.map((f) => ({ id, title: id, startTime: Date.now() + H, endTime: Date.now() + 2 * H, category: 'music', priceType: 'free', city: 'Roma', citySlug: 'roma', lat: 41.9, lng: 12.5, tags: [], ...over } as Record<string, unknown>)[f] ?? '');
const store = new Map<string, Response>();
const fakeCaches = { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => void store.set(r.url, res) } };

let hasCoverage = true;
let version = 1;
let weekend: { rows: unknown[][]; parts?: number } | null = null;
let bundleReads = 0;

beforeEach(() => {
	store.clear();
	hasCoverage = true;
	version = 1;
	weekend = { rows: [rowOf('w1'), rowOf('w2')] };
	bundleReads = 0;
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.stubGlobal('caches', fakeCaches);
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
		if (url.includes('/bundles/coverage') && !init?.body) {
			if (!hasCoverage) return new Response('{}', { status: 404 });
			return new Response(JSON.stringify({ name: 'x', fields: { json: str('[]'), version: { integerValue: String(version) } } }));
		}
		bundleReads++;
		const names: string[] = JSON.parse(init!.body!).documents.map((d: string) => d.split('/bundles/')[1]);
		const found = names.filter((n) => n === 'weekend' && weekend).map((n) => ({
			found: { name: `projects/p/databases/(default)/documents/bundles/${n}`, fields: { json: str(JSON.stringify(weekend!.rows)), parts: { integerValue: String(weekend!.parts ?? 1) } } }
		}));
		return new Response(JSON.stringify(found.length ? found : [{ missing: 'x' }]));
	}));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('weekendEventsList', () => {
	it('legge il bundle, lo memorizza con la version nella chiave e non lo rilegge', async () => {
		const f = await import('./firestore');
		const a = await f.weekendEventsList();
		expect(a).toMatchObject({ complete: true, version: '1' });
		expect(a.events.map((e) => e.id)).toEqual(['w1', 'w2']);
		const reads = bundleReads;
		await f.weekendEventsList();
		expect(bundleReads).toBe(reads);
		expect([...store.keys()].some((k) => k.includes('weekend'))).toBe(true);
	});
	it('una version nuova rilegge anche a lista ancora fresca', async () => {
		const f = await import('./firestore');
		await f.weekendEventsList();
		const reads = bundleReads;
		version = 2;
		weekend = { rows: [rowOf('w3')] };
		vi.setSystemTime(Date.now() + 1.5 * H); // coverage (1 h) scaduta, lista (3 h) ancora fresca
		const b = await f.weekendEventsList();
		expect(b.version).toBe('2');
		expect(b.events.map((e) => e.id)).toEqual(['w3']);
		expect(bundleReads).toBeGreaterThan(reads);
	});
	it('bundle assente (prima del primo import che lo scrive): lista vuota e completa, la fascia non compare', async () => {
		weekend = null;
		const f = await import('./firestore');
		expect(await f.weekendEventsList()).toMatchObject({ events: [], complete: true });
	});
	it('parte ~k mancante: si serve ma non si memorizza', async () => {
		weekend = { rows: [rowOf('w1')], parts: 2 };
		const f = await import('./firestore');
		expect((await f.weekendEventsList()).complete).toBe(false);
		expect([...store.keys()].some((k) => k.includes('weekend'))).toBe(false);
	});
	it('senza bundles/coverage (nessun import ancora): nessuna lettura del weekend', async () => {
		hasCoverage = false;
		const f = await import('./firestore');
		expect(await f.weekendEventsList()).toMatchObject({ events: [], complete: true });
		expect(bundleReads).toBe(0);
	});
	it('gli eventi già finiti non si restituiscono', async () => {
		weekend = { rows: [rowOf('old', { endTime: Date.now() - H }), rowOf('ok')] };
		const f = await import('./firestore');
		expect((await f.weekendEventsList()).events.map((e) => e.id)).toEqual(['ok']);
	});
});
