import { error } from '@sveltejs/kit';
import { sitemapDoc } from '$lib/server/firestore';
import { xmlResponse } from '$lib/server/sitemap';
import type { RequestHandler } from './$types';

// Pagina n della sitemap degli eventi (1000 URL, ordinati per id), scritta dall'importer (tools/importer/sitemap.py).
export const GET: RequestHandler = async ({ params }) => {
	if (!/^[1-9][0-9]{0,2}$/.test(params.n)) error(404, 'Sitemap non trovata');
	const xml = await sitemapDoc(`sm_eventi_${Number(params.n)}`);
	if (!xml) error(404, 'Sitemap non trovata');
	return xmlResponse(xml);
};
