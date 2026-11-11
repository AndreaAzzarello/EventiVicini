import { describe, expect, it, vi } from 'vitest';
import { fromData } from '$lib/event';

vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_SITE_URL: 'https://example.test' } }));

const ev = (id: string, locality: string) =>
	fromData(id, { title: 'T ' + id, city: 'Terre del Reno', citySlug: 'terre-del-reno', locality, startTime: 1 });
// sm_index assente (prima del primo import che lo scrive): il generatore di ripiego
vi.mock('$lib/server/firestore', () => ({
	sitemapDoc: async () => null,
	upcomingEvents: async () => [ev('a', "Sant'Agostino"), ev('b', 'Mirabello')],
	coverage: async () => [
		{ slug: 'emilia-romagna', name: 'Emilia-Romagna', comuni: [{ slug: 'x' }] },
		{ slug: 'vuota', name: 'Vuota', comuni: [] }
	]
}));

describe('sitemap.xml', () => {
	it('usa solo citySlug: una pagina città, mai la frazione', async () => {
		const { GET } = await import('./+server');
		const xml = await (await GET({} as never)).text();
		expect(xml.match(/<loc>[^<]*\/citta\/[^<]*<\/loc>/g)).toEqual(['<loc>https://example.test/citta/terre-del-reno</loc>']);
		expect(xml).not.toMatch(/Agostino|agostino|Mirabello|mirabello/);
	});

	it('elenca le pagine regione coperte (non quelle vuote)', async () => {
		const { GET } = await import('./+server');
		const xml = await (await GET({} as never)).text();
		expect(xml.match(/<loc>[^<]*\/regione\/[^<]*<\/loc>/g)).toEqual(['<loc>https://example.test/regione/emilia-romagna</loc>']);
	});
});
