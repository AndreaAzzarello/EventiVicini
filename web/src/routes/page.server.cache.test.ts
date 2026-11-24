// Cache HTTP della home: HTML_CACHE solo per pagine complete; errore, lista parziale o copertura non letta → no-store.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HTML_CACHE } from '$lib/server/cache';

vi.mock('$lib/server/firestore', () => ({ coverage: vi.fn(), eventsAround: vi.fn(), eventsInCityList: vi.fn() }));
vi.mock('$lib/server/comuneSlug', () => ({ comuneBySlug: vi.fn(async () => null) }));
import * as store from '$lib/server/firestore';
import { load } from './+page.server';

const H = 3_600_000;
const comune = { name: 'Modena', slug: 'modena', province: 'MO', lat: 44.65, lng: 10.93, events: 40 };
const regions = [{ slug: 'emilia-romagna', name: 'Emilia-Romagna', comuni: [comune] }];
const ev = (i: number) => ({ id: `e${i}`, title: `Evento ${i}`, startTime: Date.now() + H, endTime: Date.now() + 2 * H, category: 'music', priceType: 'free', lat: 44.65, lng: 10.93, city: 'Modena', citySlug: 'modena', tags: [] });
const around = (n: number, complete = true) => ({ events: Array.from({ length: n }, (_, i) => ev(i)), fetched: { lat: 44.65, lng: 10.95, km: 29 }, complete, version: '7' });

let headers: Record<string, string>;
let setCalls: number;
const run = async (qs = 'luogo=modena&r=25') => {
	headers = {};
	setCalls = 0;
	const data = (await load({
		url: new URL(`https://example.test/?${qs}`),
		setHeaders: (h: Record<string, string>) => (setCalls++, Object.assign(headers, h))
	} as unknown as Parameters<typeof load>[0])) as Record<string, unknown>;
	return data;
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(store.coverage).mockResolvedValue(regions as never);
	vi.mocked(store.eventsAround).mockResolvedValue(around(3) as never);
	vi.mocked(store.eventsInCityList).mockResolvedValue({ events: [], complete: true, version: '7' } as never);
});

describe('home: intestazioni di cache', () => {
	it('risposta valida: HTML_CACHE, una sola volta, con la versione dei dati', async () => {
		const d = await run();
		expect(headers['cache-control']).toBe(HTML_CACHE);
		expect(setCalls).toBe(1);
		expect(d).toMatchObject({ version: '7', total: 3, partial: false });
	});

	it('lista lunga: HTML con le prime card ma conteggio dell\'elenco intero, stessa versione per il browser', async () => {
		vi.mocked(store.eventsAround).mockResolvedValue(around(40) as never);
		const d = await run();
		expect(headers['cache-control']).toBe(HTML_CACHE);
		expect(d).toMatchObject({ partial: true, total: 40, version: '7' });
		expect((d.events as unknown[]).length).toBe(12);
	});

	it('lista incompleta: no-store', async () => {
		vi.mocked(store.eventsAround).mockResolvedValue(around(0, false) as never);
		await run();
		expect(headers['cache-control']).toBe('no-store');
		expect(setCalls).toBe(1);
	});

	it('errore di Firestore: pagina d\'errore con no-store (non 5 minuti nel bordo)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(store.eventsAround).mockRejectedValue(new Error('Firestore 500'));
		const d = await run();
		expect(d.error).toMatch(/Non riesco/);
		expect(headers['cache-control']).toBe('no-store');
		expect(setCalls).toBe(1);
	});

	it('copertura non leggibile: no-store', async () => {
		vi.mocked(store.coverage).mockRejectedValue(new Error('Firestore 500'));
		await run('luogo=modena&r=25');
		expect(headers['cache-control']).toBe('no-store');
	});

	it('città fuori copertura: il ripiego su eventsInCityList fallito → no-store; riuscito e completo → HTML_CACHE', async () => {
		const sconosciuta = 'luogo=paesino-fuori-copertura&r=25';
		vi.mocked(store.eventsInCityList).mockRejectedValue(new Error('Firestore 500'));
		await run(sconosciuta);
		expect(headers['cache-control']).toBe('no-store');
		vi.mocked(store.eventsInCityList).mockResolvedValue({ events: [], complete: false, version: '7' } as never);
		await run(sconosciuta);
		expect(headers['cache-control']).toBe('no-store');
		vi.mocked(store.eventsInCityList).mockResolvedValue({ events: [], complete: true, version: '7' } as never);
		await run(sconosciuta);
		expect(headers['cache-control']).toBe(HTML_CACHE);
	});

	it('senza luogo: nessun evento caricato, HTML_CACHE', async () => {
		await run('');
		expect(headers['cache-control']).toBe(HTML_CACHE);
		expect(store.eventsAround).not.toHaveBeenCalled();
	});
});
