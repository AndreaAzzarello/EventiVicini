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
const call = (qs: string) =>
	GET({ url: new URL(`https://example.test/api/events?${qs}`), setHeaders: () => {} } as unknown as Parameters<typeof GET>[0]);

beforeEach(() => {
	vi.mocked(store.eventsAround).mockResolvedValue({ events: hostile, fetched: {} } as never);
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
