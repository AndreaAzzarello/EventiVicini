import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config', () => ({ siteUrl: () => 'https://example.test' }));
import { GET } from './+server';

const call = async (q = 'Bologna'): Promise<Response> =>
	GET({ url: new URL(`https://example.test/api/geocode?q=${q}`), setHeaders: () => {} } as unknown as Parameters<typeof GET>[0]);
const status = (p: Promise<Response>) => p.then(() => 200, (e: { status?: number }) => e.status);

afterEach(() => vi.unstubAllGlobals());

describe('/api/geocode: Nominatim non raggiungibile', () => {
	it('errore di rete o timeout: 502, non 500', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
		expect(await status(call('Bologna'))).toBe(502);
	});
	it('risposta non JSON: 502', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
		expect(await status(call('Modena'))).toBe(502);
	});
	it('stato HTTP di errore di Nominatim: 502', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
		expect(await status(call('Parma'))).toBe(502);
	});
	it('risposta valida: 200 con i risultati', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([{ lat: '44.49', lon: '11.34', display_name: 'Bologna, Emilia-Romagna, Italia', address: { city: 'Bologna', 'ISO3166-2-lvl6': 'IT-BO', state: 'Emilia-Romagna' } }])));
		const res = await call('Reggio');
		expect(res.status).toBe(200);
		expect((await res.json())[0].lat).toBe(44.49);
	});
});

describe('/api/geocode: risultati distinguibili', () => {
	it('«modena»: la provincia è scartata, una sola richiesta a Nominatim, etichetta con dettaglio', async () => {
		const ita = { 'ISO3166-2-lvl6': 'IT-MO', state: 'Emilia-Romagna', county: 'Modena', country_code: 'it' };
		const fetchMock = vi.fn().mockResolvedValue(
			Response.json([
				{ lat: '44.5385', lon: '10.9360', name: 'Modena', display_name: 'Modena, Emilia-Romagna, Italia', addresstype: 'county', place_rank: 12, address: ita },
				{ lat: '44.6459', lon: '10.9256', name: 'Modena', display_name: 'Modena, Emilia-Romagna, Italia', addresstype: 'city', place_rank: 16, address: { city: 'Modena', ...ita } }
			])
		);
		vi.stubGlobal('fetch', fetchMock);
		const res = await GET({ url: new URL('https://example.test/api/geocode?q=modena&kind=address'), setHeaders: () => {} } as unknown as Parameters<typeof GET>[0]);
		const body = await res.json();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain('limit=5');
		expect(body).toHaveLength(1);
		expect(body[0]).toMatchObject({ label: 'Modena (MO)', detail: 'comune', lat: 44.6459 });
	});
});
