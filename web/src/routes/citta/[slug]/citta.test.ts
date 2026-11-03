import { describe, expect, it, vi } from 'vitest';
import { fromData } from '$lib/event';

const calls: string[] = [];
let override: ReturnType<typeof fromData>[] | null = null;
const ev = (id: string, locality: string) =>
	fromData(id, { city: 'Terre del Reno', citySlug: 'terre-del-reno', province: 'FE', locality, startTime: 1 });
vi.mock('$lib/server/comuneSlug', () => ({
	comuneBySlug: async (slug: string) => (slug === 'modena' ? { label: 'Modena', lat: 44.65, lng: 10.93, slug } : null)
}));
vi.mock('$lib/server/firestore', () => ({
	eventsInCity: async (slug: string) => (calls.push(slug), override ?? [ev('a', "Sant'Agostino"), ev('b', 'Mirabello')]),
	regionCoverage: async (slug: string) => (slug === 'emilia-romagna' ? { slug, name: 'Emilia-Romagna', comuni: [] } : null),
	coverage: async () => [
		{ slug: 'trentino-alto-adige', name: 'Trentino-Alto Adige', comuni: [{ name: 'Bolzano', slug: 'bolzano', alt: 'Bozen' }] }
	]
}));

describe('/citta/[slug]', () => {
	it('interroga per citySlug e titola col comune, non con la frazione', async () => {
		const { load } = await import('./+page.server');
		const r = (await load({ params: { slug: 'terre-del-reno' }, setHeaders() {} } as never)) as { city: string };
		expect(calls).toEqual(['terre-del-reno']);
		expect(r.city).toBe('Terre del Reno');
	});

	it('il breadcrumb porta alla pagina regione solo se la regione è coperta', async () => {
		const { load } = await import('./+page.server');
		const run = async (region: string) => {
			override = [fromData('x', { city: 'Lecco', citySlug: 'lecco', region, startTime: 1 })];
			return (await load({ params: { slug: 'lecco' }, setHeaders() {} } as never)) as { regionSlug: string };
		};
		expect((await run('Emilia-Romagna')).regionSlug).toBe('emilia-romagna');
		expect((await run('Lombardia')).regionSlug).toBe('');
	});

	it("l'alias dei comuni bilingui porta al nome italiano (301) e il titolo li mostra entrambi", async () => {
		const { load } = await import('./+page.server');
		override = [];
		for (const slug of ['bozen', 'bolzano-bozen']) {
			await expect(load({ params: { slug }, setHeaders() {} } as never)).rejects.toMatchObject({ status: 301, location: '/citta/bolzano' });
		}
		await expect(load({ params: { slug: 'bozenx' }, setHeaders() {} } as never)).rejects.toMatchObject({ status: 404 });
		override = [fromData('b', { city: 'Bolzano', citySlug: 'bolzano', cityAlt: 'Bozen', startTime: 1 })];
		const r = (await load({ params: { slug: 'bolzano' }, setHeaders() {} } as never)) as { city: string; cityAlt: string };
		expect([r.city, r.cityAlt]).toEqual(['Bolzano', 'Bozen']);
	});

	it('un comune vero senza eventi rimanda alla home con 302, uno slug inesistente resta 404', async () => {
		const { load } = await import('./+page.server');
		override = [];
		await expect(load({ params: { slug: 'modena' }, setHeaders() {} } as never)).rejects.toMatchObject({ status: 302, location: '/?luogo=modena' });
		await expect(load({ params: { slug: 'cittainventata' }, setHeaders() {} } as never)).rejects.toMatchObject({ status: 404 });
	});

	it('gli slug di regioni e comuni con accenti e apostrofi sono stabili', async () => {
		const { slugify } = await import('$lib/event');
		expect(slugify("Valle d'Aosta")).toBe('valle-d-aosta');
		expect(slugify('Trentino-Alto Adige')).toBe('trentino-alto-adige');
		expect(slugify('Friuli Venezia Giulia')).toBe('friuli-venezia-giulia');
		expect(slugify("Sant'Orso")).toBe('sant-orso');
		expect(slugify('Forlì')).toBe('forli');
		expect(slugify('Bozen')).toBe('bozen');
		expect(slugify('Aoste')).toBe('aoste');
	});
});
