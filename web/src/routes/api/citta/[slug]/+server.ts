import { error, json } from '@sveltejs/kit';
import { slugify } from '$lib/event';
import { API_CACHE } from '$lib/server/cache';
import { eventsInCityList } from '$lib/server/firestore';
import type { RequestHandler } from './$types';

// GET /api/citta/<slug>?v=<version> → tutti gli eventi della città (gli stessi della pagina /citta/<slug>, in cache: nessuna lettura in più).
// Serve a «Mostra altri» e ai filtri della pagina città, che porta nell'HTML solo una pagina di card.
// `v` (versione dei dati, la stessa della pagina) è ignorato qui: fa solo cambiare l'URL, quindi la voce della cache del bordo e
// del browser, quando l'importer pubblica dati nuovi.
export const GET: RequestHandler = async ({ params, setHeaders }) => {
	if (params.slug !== slugify(params.slug)) error(404, 'Città non trovata');
	const { events, complete } = await eventsInCityList(params.slug);
	// Lista possibilmente parziale (import a metà, query fallita, vuoto sospetto): mai nella cache del bordo né del browser.
	setHeaders({ 'cache-control': complete ? API_CACHE : 'no-store' });
	return json(events);
};
