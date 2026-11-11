import { error } from '@sveltejs/kit';
import { sitemapDoc } from '$lib/server/firestore';
import { xmlResponse } from '$lib/server/sitemap';
import type { RequestHandler } from './$types';

// Home, regioni, città e pagine legali: pagina della sitemap scritta dall'importer (tools/importer/sitemap.py).
export const GET: RequestHandler = async () => {
	const xml = await sitemapDoc('sm_luoghi');
	if (!xml) error(404, 'Sitemap non disponibile');
	return xmlResponse(xml);
};
