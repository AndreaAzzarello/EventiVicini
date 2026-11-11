import { siteUrl } from '$lib/config';
import { cityPath, eventPath } from '$lib/event';
import { coverage, sitemapDoc, upcomingEvents } from '$lib/server/firestore';
import { xmlResponse } from '$lib/server/sitemap';
import type { RequestHandler } from './$types';

// Ogni evento in elenco costa una lettura Firestore a ogni rigenerazione: 500 bastano a far scoprire le pagine città/regione,
// che a loro volta linkano gli eventi. shortcut: oltre serve un indice di sitemap paginato e un budget di letture dedicato.
const MAX_EVENTS = 500;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Con l'importer che scrive bundles/sm_* (tools/importer/sitemap.py) il Worker serve l'indice già pronto: nessun calcolo.
// Finché non esiste (prima del primo import che lo crea) si genera come prima: 500 eventi, rollout senza interruzioni.
export const GET: RequestHandler = async () => {
	const ready = await sitemapDoc('sm_index').catch(() => null);
	if (ready) return xmlResponse(ready);
	const base = siteUrl();
	const [events, regions] = await Promise.all([upcomingEvents(MAX_EVENTS), coverage().catch(() => [])]);
	const cities = [...new Set(events.map((e) => e.citySlug).filter(Boolean))];
	const day = (ms?: number) => (ms ? `<lastmod>${new Date(ms).toISOString().slice(0, 10)}</lastmod>` : '');
	const urls = [
		`<url><loc>${base}/</loc><changefreq>daily</changefreq></url>`,
		...regions
			.filter((r) => r.comuni.length)
			.map((r) => `<url><loc>${esc(`${base}/regione/${r.slug}`)}</loc><changefreq>daily</changefreq></url>`),
		...cities.map((c) => `<url><loc>${esc(base + cityPath(c))}</loc><changefreq>daily</changefreq></url>`),
		...events.map((e) => `<url><loc>${esc(base + eventPath(e))}</loc>${day(e.updatedAt ?? e.createdAt)}</url>`),
		`<url><loc>${base}/privacy</loc></url>`,
		`<url><loc>${base}/cookie</loc></url>`,
		`<url><loc>${base}/termini</loc></url>`
	];
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
		{
			headers: {
				'content-type': 'application/xml; charset=utf-8',
				'cache-control': 'public, max-age=3600, s-maxage=43200'
			}
		}
	);
};
