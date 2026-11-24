import { beforeEach, describe, expect, it, vi } from 'vitest';
import { xssDue, xssUno } from '$lib/hostileEvents';

vi.mock('$lib/server/firestore', () => ({
	MAX_IDS: 30,
	eventsAround: vi.fn(),
	getEvents: vi.fn()
}));
import * as store from '$lib/server/firestore';
import { GET } from './+server';

const hostile = [xssUno(), xssDue()];
let headers: Record<string, string> = {};
const call = (qs: string) => {
	headers = {};
	return GET({ url: new URL(`https://example.test/api/events?${qs}`), setHeaders: (h: Record<string, string>) => Object.assign(headers, h) } as unknown as Parameters<typeof GET>[0]);
};

beforeEach(() => {
	vi.mocked(store.eventsAround).mockResolvedValue({ events: hostile, fetched: {}, complete: true, version: '1' } as never);
	vi.mocked(store.getEvents).mockResolvedValue(hostile as never);
});

describe('/api/events con record ostili', () => {
	it('lat/lng/r: 200, JSON, dati identici (l\'escaping spetta a chi li mostra)', async () => {
		const res = await call('lat=44.64&lng=10.92&r=10');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/^application\/json/);
		const body = await res.json();
		expect(body.map((e: { id: string }) => e.id)).toEqual(['xssUno', 'xssDue']);
		expect(body).toEqual(JSON.parse(JSON.stringify(hostile)));
	});
	it('ids: 200, JSON; gli id passano a getEvents, che scarta quelli non validi', async () => {
		const res = await call('ids=xssUno,xssDue');
		expect(res.headers.get('content-type')).toMatch(/^application\/json/);
		expect(await res.json()).toHaveLength(2);
		await call('ids=' + encodeURIComponent('x"><script>alert(1)</script>') + ',xssUno');
		expect(vi.mocked(store.getEvents)).toHaveBeenLastCalledWith(['x"><script>alert(1)</script>', 'xssUno']);
	});
	it('parametri non validi: 400', async () => {
		await expect(call('lat=abc&lng=1&r=10')).rejects.toMatchObject({ status: 400 });
		await expect(call('lat=44.64&lng=10.92&r=10;DROP')).rejects.toMatchObject({ status: 400 });
	});
});

describe('/api/events: cache HTTP', () => {
	const q = 'lat=44.64&lng=10.92&r=10';
	it('lista completa: breve, con s-maxage 300 e stale-while-revalidate 600', async () => {
		await call(q);
		expect(headers['cache-control']).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');
	});
	it('lista incompleta (anche vuota): no-store', async () => {
		vi.mocked(store.eventsAround).mockResolvedValue({ events: [], fetched: {}, complete: false, version: '1' } as never);
		const res = await call(q);
		expect(headers['cache-control']).toBe('no-store');
		expect(await res.json()).toEqual([]);
	});
	it('lista vuota ma completa (zona senza eventi): si può memorizzare', async () => {
		vi.mocked(store.eventsAround).mockResolvedValue({ events: [], fetched: {}, complete: true, version: '1' } as never);
		await call(q);
		expect(headers['cache-control']).toMatch(/s-maxage=300/);
	});
	it('errore di Firestore: la richiesta fallisce, nessuna intestazione di cache', async () => {
		vi.mocked(store.eventsAround).mockRejectedValue(new Error('Firestore 500'));
		await expect(call(q)).rejects.toThrow('500');
		expect(headers['cache-control']).toBeUndefined();
	});
	it('il parametro v non cambia la risposta', async () => {
		const a = await (await call(q)).json();
		const b = await (await call(q + '&v=999')).json();
		expect(b).toEqual(a);
		expect(vi.mocked(store.eventsAround)).toHaveBeenLastCalledWith({ lat: 44.64, lng: 10.92 }, 10);
	});
});
