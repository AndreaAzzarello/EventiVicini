import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromData } from '$lib/event';

vi.mock('$lib/server/firestore', () => ({ eventsInCityList: vi.fn() }));
import * as store from '$lib/server/firestore';
import { GET } from './+server';

const list = [fromData('a', { city: 'Modena', citySlug: 'modena', startTime: 1 })];
let headers: Record<string, string> = {};
const call = (slug: string, qs = '') => {
	headers = {};
	return GET({ params: { slug }, url: new URL(`https://example.test/api/citta/${slug}${qs}`), setHeaders: (h: Record<string, string>) => Object.assign(headers, h) } as unknown as Parameters<typeof GET>[0]);
};

beforeEach(() => {
	vi.mocked(store.eventsInCityList).mockResolvedValue({ events: list, complete: true, version: '1' } as never);
});

describe('/api/citta/[slug]', () => {
	it('lista completa: stessa cache breve di /api/events; `v` non cambia la risposta', async () => {
		const res = await call('modena', '?v=1700000000000');
		expect(headers['cache-control']).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');
		expect(await res.json()).toHaveLength(1);
		expect(vi.mocked(store.eventsInCityList)).toHaveBeenCalledWith('modena');
	});
	it('lista incompleta: no-store', async () => {
		vi.mocked(store.eventsInCityList).mockResolvedValue({ events: [], complete: false, version: '1' } as never);
		await call('modena');
		expect(headers['cache-control']).toBe('no-store');
	});
	it('slug non canonico: 404', async () => {
		await expect(call('Modena')).rejects.toMatchObject({ status: 404 });
	});
});
