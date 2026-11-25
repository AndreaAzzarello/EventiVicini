import { error, json } from '@sveltejs/kit';
import { RADII_KM, inItaly } from '$lib/geo';
import { API_CACHE } from '$lib/server/cache';
import { MAX_IDS, eventsAround, getEvents } from '$lib/server/firestore';
import type { RequestHandler } from './$types';

// GET /api/events?lat=&lng=&r=  → eventi nel raggio dal punto della griglia di ~5 km più vicino
//                                  (il browser rifiltra sulla distanza vera): poche chiavi di cache.
//                                  `v` (versione dei dati, la stessa della pagina) è ignorato qui: serve solo a far cambiare
//                                  l'URL, quindi la voce della cache del bordo e del browser, quando l'importer pubblica dati nuovi.
// GET /api/events?ids=a,b,c     → eventi per id (preferiti di chi non ha l'account)

export const GET: RequestHandler = async ({ url, setHeaders }) => {
	const ids = url.searchParams.get('ids');
	if (ids != null) {
		const wanted = ids.split(',').filter(Boolean);
		if (wanted.length > MAX_IDS) error(400, `Al massimo ${MAX_IDS} id`);
		const list = await getEvents(wanted);
		setHeaders({ 'cache-control': 'public, max-age=60, s-maxage=600' });
		return json(list);
	}
	const lat = Number(url.searchParams.get('lat'));
	const lng = Number(url.searchParams.get('lng'));
	const r = Number(url.searchParams.get('r'));
	if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inItaly({ lat, lng }))
		error(400, 'Coordinate non valide');
	if (!(RADII_KM as readonly number[]).includes(r)) error(400, 'Raggio non valido');
	const { events, complete } = await eventsAround({ lat, lng }, r);
	// Lista possibilmente parziale (import a metà, query fallita, vuoto sospetto): mai nella cache del bordo né del browser.
	// Un errore di Firestore esce come 5xx e l'adapter non memorizza mai oltre il 399.
	setHeaders({ 'cache-control': complete ? API_CACHE : 'no-store' });
	return json(events);
};
