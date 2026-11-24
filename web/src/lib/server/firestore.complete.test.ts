// Liste incomplete (parte di bundle mancante, query fallita, vuoto sospetto) non entrano in nessuna cache; la versione dei dati
// (bundles/coverage) entra nella chiave. Vedi cached() e readBundles() in firestore.ts.
import { geohashForLocation } from 'geofire-common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIELDS } from './bundles';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_FIREBASE_PROJECT_ID: 'p', PUBLIC_FIREBASE_API_KEY: 'k' } }));

const H = 3_600_000;
const modena = { lat: 44.65, lng: 10.95 };
const cell = `g_${geohashForLocation([modena.lat, modena.lng], 4)}`;
const str = (stringValue: string) => ({ stringValue });
const rowOf = (id: string) =>
	FIELDS.map((f) => ({ id, title: id, startTime: Date.now() + H, endTime: Date.now() + 2 * H, category: 'music', priceType: 'free', lat: modena.lat, lng: modena.lng, tags: [] } as Record<string, unknown>)[f] ?? '');
const bdoc = (name: string, fields: Record<string, unknown>) => ({ found: { name: `projects/p/databases/(default)/documents/bundles/${name}`, fields } });

const store = new Map<string, Response>();
const fakeCaches = { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => void store.set(r.url, res) } };
const nearKeys = () => [...store.keys()].filter((k) => k.includes('near') || k.includes('city'));

let version = 1;
let comuni: { name: string; slug: string; lat: number; lng: number; events: number }[] = [];
let withParts = false; // la cella dichiara 2 parti ma la seconda manca
let cellRows: unknown[][] = [rowOf('e1')];
let bundleReads = 0;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	store.clear();
	version = 1;
	comuni = [];
	withParts = false;
	cellRows = [rowOf('e1')];
	bundleReads = 0;
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.stubGlobal('caches', fakeCaches);
	fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
		if (url.includes('/bundles/coverage') && !init?.body)
			return new Response(JSON.stringify({ name: 'x', fields: { json: str(JSON.stringify([{ slug: 'er', name: 'ER', comuni }])), version: { integerValue: String(version) } } }));
		bundleReads++;
		const names: string[] = JSON.parse(init!.body!).documents.map((d: string) => d.split('/bundles/')[1]);
		const out = names.flatMap((n) =>
			n === cell ? [bdoc(n, { json: str(JSON.stringify(cellRows)), parts: { integerValue: withParts ? '2' : '1' } })] : []
		);
		return new Response(JSON.stringify(out.length ? out : [{ missing: 'x' }]));
	});
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('liste complete e incomplete', () => {
	it('lista valida: si memorizza (edge) e la seconda richiesta non rilegge', async () => {
		const f = await import('./firestore');
		const a = await f.eventsNearList(modena, 25);
		expect(a).toMatchObject({ complete: true, version: '1' });
		expect(a.events.map((e) => e.id)).toEqual(['e1']);
		expect(nearKeys()).toHaveLength(1);
		const reads = bundleReads;
		await f.eventsNearList(modena, 25);
		expect(bundleReads).toBe(reads);
	});

	it('parte ~k mancante: si serve ma non si memorizza, e si rilegge a ogni richiesta', async () => {
		withParts = true;
		const f = await import('./firestore');
		const a = await f.eventsNearList(modena, 25);
		expect(a.complete).toBe(false);
		expect(a.events.map((e) => e.id)).toEqual(['e1']);
		expect(nearKeys()).toHaveLength(0);
		const reads = bundleReads;
		await f.eventsNearList(modena, 25);
		expect(bundleReads).toBeGreaterThan(reads);
	});

	it('vuoto con la copertura che dice «qui ci sono eventi»: non si memorizza', async () => {
		cellRows = [];
		comuni = [{ name: 'Modena', slug: 'modena', lat: modena.lat, lng: modena.lng, events: 40 }];
		const f = await import('./firestore');
		expect((await f.eventsNearList(modena, 25)).complete).toBe(false);
		expect(nearKeys()).toHaveLength(0);
		expect((await f.eventsInCityList('modena')).complete).toBe(false);
	});

	it('vuoto davvero (cella senza eventi, nessun comune con eventi vicino): si memorizza', async () => {
		cellRows = [];
		comuni = [{ name: 'Lontano', slug: 'lontano', lat: 40, lng: 15, events: 40 }];
		const f = await import('./firestore');
		const a = await f.eventsNearList(modena, 25);
		expect(a).toMatchObject({ complete: true, events: [] });
		expect(nearKeys()).toHaveLength(1);
	});

	it('la versione di coverage cambia la chiave: dopo un import si rilegge anche a lista ancora fresca', async () => {
		const f = await import('./firestore');
		await f.eventsNearList(modena, 25);
		const reads = bundleReads;
		version = 2;
		cellRows = [rowOf('e1'), rowOf('e2')];
		vi.setSystemTime(Date.now() + 1.5 * H); // coverage (1 h) scaduta, lista (3 h) ancora fresca
		const b = await f.eventsNearList(modena, 25);
		expect(b.version).toBe('2');
		expect(b.events.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
		expect(bundleReads).toBeGreaterThan(reads);
	});

	it('incompleta dopo la scadenza, con una copia completa precedente: serve la copia, non la lista parziale', async () => {
		const f = await import('./firestore');
		await f.eventsNearList(modena, 25);
		vi.setSystemTime(Date.now() + 3.1 * H);
		withParts = true;
		cellRows = [];
		const b = await f.eventsNearList(modena, 25);
		expect(b.complete).toBe(true);
		expect(b.events.map((e) => e.id)).toEqual(['e1']);
	});

	it('errore di Firestore senza copia: arriva a chi chiama e nulla viene memorizzato', async () => {
		fetchMock.mockImplementation(async (url: string, init?: { body?: string }) =>
			url.includes('/bundles/coverage') && !init?.body ? new Response('boom', { status: 500 }) : new Response('boom', { status: 500 })
		);
		const f = await import('./firestore');
		await expect(f.eventsNearList(modena, 25)).rejects.toThrow('500');
		expect(nearKeys()).toHaveLength(0);
	});

	it('senza bundle: una query longRunning fallita (non 429) rende la lista incompleta', async () => {
		fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
			if (!init?.body) return new Response('{}', { status: 404 }); // bundles/coverage assente
			if (init.body.includes('longRunning')) return new Response('indice', { status: 400 });
			return new Response('[]');
		});
		const f = await import('./firestore');
		const a = await f.eventsNearList(modena, 25);
		expect(a).toMatchObject({ complete: false, version: 'q' });
		expect(nearKeys()).toHaveLength(0);
	});
});
