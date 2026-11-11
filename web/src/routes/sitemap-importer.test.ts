import { beforeEach, describe, expect, it, vi } from 'vitest';
import slugs from '../../../docs/schema/sitemap-slugs.json';
import { eventPath, slugify } from '$lib/event';

vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_SITE_URL: 'https://example.test' } }));

const docs = vi.hoisted(() => ({ map: {} as Record<string, string | null>, reads: [] as string[] }));
vi.mock('$lib/server/firestore', () => ({
	sitemapDoc: async (name: string) => {
		docs.reads.push(name);
		return docs.map[name] ?? null;
	},
	upcomingEvents: async () => [],
	coverage: async () => []
}));

const urlset = (...paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>{{BASE}}${p}</loc></url>`).join('')}</urlset>`;
beforeEach(() => {
	docs.map = {};
	docs.reads = [];
});

describe('sitemap scritta dall’importer (#20)', () => {
	it('sitemap.xml serve l’indice senza calcoli, con {{BASE}} sostituito', async () => {
		docs.map.sm_index = '<sitemapindex><sitemap><loc>{{BASE}}/sitemap-luoghi.xml</loc></sitemap></sitemapindex>';
		const { GET } = await import('./sitemap.xml/+server');
		const res = await GET({} as never);
		expect(res.headers.get('content-type')).toContain('application/xml');
		expect(await res.text()).toBe('<sitemapindex><sitemap><loc>https://example.test/sitemap-luoghi.xml</loc></sitemap></sitemapindex>');
		expect(docs.reads).toEqual(['sm_index']); // una sola lettura, nessuna ricerca di eventi
	});

	it('sitemap-luoghi.xml e sitemap-eventi-N.xml leggono un documento ciascuno; assente = 404', async () => {
		docs.map.sm_luoghi = urlset('/', '/citta/modena');
		docs.map.sm_eventi_2 = urlset('/eventi/concerto-e00001');
		const luoghi = await import('./sitemap-luoghi.xml/+server');
		const eventi = await import('./sitemap-eventi-[n].xml/+server');
		expect(await (await luoghi.GET({} as never)).text()).toContain('<loc>https://example.test/citta/modena</loc>');
		expect(await (await eventi.GET({ params: { n: '2' } } as never)).text()).toContain('<loc>https://example.test/eventi/concerto-e00001</loc>');
		await expect(eventi.GET({ params: { n: '3' } } as never)).rejects.toMatchObject({ status: 404 });
		await expect(eventi.GET({ params: { n: '0' } } as never)).rejects.toMatchObject({ status: 404 });
		await expect(eventi.GET({ params: { n: '../x' } } as never)).rejects.toMatchObject({ status: 404 });
		docs.map = {};
		await expect(luoghi.GET({} as never)).rejects.toMatchObject({ status: 404 });
	});

	it('con sm_index assente sitemap.xml ripiega sul generatore attuale', async () => {
		const { GET } = await import('./sitemap.xml/+server');
		const xml = await (await GET({} as never)).text();
		expect(xml).toContain('<urlset');
		expect(xml).toContain('https://example.test/privacy');
	});
});

describe('parità degli slug con l’importer', () => {
	// Stesso file letto da tools/importer/tests/test_sitemap.py: l'URL che l'importer scrive è quello canonico della webapp.
	it.each(slugs)('$title', ({ title, slug }) => {
		expect(slugify(title)).toBe(slug);
		expect(eventPath({ id: 'e1', title })).toBe(`/eventi/${slug || 'evento'}-e1`);
	});
});
