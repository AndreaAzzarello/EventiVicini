import { error, json } from '@sveltejs/kit';
import { slugify } from '$lib/event';
import { eventsInCity } from '$lib/server/firestore';
import type { RequestHandler } from './$types';

// GET /api/citta/<slug> → tutti gli eventi della città (gli stessi della pagina /citta/<slug>, in cache: nessuna lettura in più).
// Serve a «Mostra altri» e ai filtri della pagina città, che porta nell'HTML solo una pagina di card.
export const GET: RequestHandler = async ({ params, setHeaders }) => {
	if (params.slug !== slugify(params.slug)) error(404, 'Città non trovata');
	const events = await eventsInCity(params.slug);
	setHeaders({ 'cache-control': 'public, max-age=300, s-maxage=1800, stale-while-revalidate=86400' });
	return json(events);
};
