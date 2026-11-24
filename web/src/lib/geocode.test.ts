import { beforeEach, describe, expect, it, vi } from 'vitest';

// Il bordo di Cloudflare e la cache HTTP del browser indicizzano per URL: la versione del formato deve stare nell'URL.
const nuovo = [{ label: 'Modena (MO)', detail: 'comune', lat: 44.6459, lng: 10.9256, place: null }];
const vecchio = [{ label: 'Modena, Emilia-Romagna, Italia', lat: 44.5385, lng: 10.936, place: null }];

let mem: Record<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
const load = () => import('./geocode'); // modulo nuovo a ogni test: ha una cache in memoria

beforeEach(() => {
	vi.resetModules();
	mem = {};
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => mem[k] ?? null,
		setItem: (k: string, v: string) => void (mem[k] = v),
		removeItem: (k: string) => void delete mem[k]
	});
	fetchMock = vi.fn().mockImplementation(async () => Response.json(nuovo));
	vi.stubGlobal('fetch', fetchMock);
	vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
});

const asked = (i = 0) => new URL(String(fetchMock.mock.calls[i][0]), 'https://example.test');
const run = async <T>(p: Promise<T>) => {
	await vi.runAllTimersAsync();
	return p;
};

describe('geocode: la versione del formato è parte dell’URL richiesto', () => {
	it('kind=address', async () => {
		const { GEOCODE_FORMAT, searchPlaces } = await load();
		await run(searchPlaces('modena', 'address'));
		expect(asked().searchParams.get('v')).toBe(String(GEOCODE_FORMAT));
	});
	it('kind=city (ricerca del luogo in home)', async () => {
		const { GEOCODE_FORMAT, searchPlaces } = await load();
		await run(searchPlaces('modena', 'city'));
		expect(asked().searchParams.get('v')).toBe(String(GEOCODE_FORMAT));
	});
	it('reverse geocoding', async () => {
		const { GEOCODE_FORMAT, reversePlace } = await load();
		await run(reversePlace(44.6459, 10.9256));
		expect(asked().searchParams.get('v')).toBe(String(GEOCODE_FORMAT));
	});
	it('la versione è più alta di 2: la #100 ha già salvato in v2 risposte vecchie arrivate dal bordo', async () => {
		const { GEOCODE_FORMAT } = await load();
		expect(GEOCODE_FORMAT).toBeGreaterThan(2);
	});
});

describe('geocode: localStorage inquinato dalla versione precedente', () => {
	it('una voce v2 col formato vecchio non viene riusata: parte la richiesta e arriva il formato nuovo', async () => {
		mem['ev:geocode'] = JSON.stringify({ 'v2:address:modena': vecchio });
		const { searchPlaces } = await load();
		const res = await run(searchPlaces('modena', 'address'));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(res).toEqual(nuovo);
	});
	it('la stessa ricerca ripetuta usa la memoria locale: nessuna seconda richiesta', async () => {
		const { searchPlaces } = await load();
		await run(searchPlaces('modena', 'address'));
		await run(searchPlaces('Modena', 'address'));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
