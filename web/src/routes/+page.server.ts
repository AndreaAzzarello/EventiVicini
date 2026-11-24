import { redirect } from '@sveltejs/kit';
import { HTML_CACHE } from '$lib/server/cache';
import { comuneBySlug } from '$lib/server/comuneSlug';
import { applyFilter, filterFromParams, groupingFor } from '$lib/filters';
import { DEFAULT_PLACE, type ChosenPlace } from '$lib/geo';
import { autoRadius, nearestWithEvents, placeFromEvents, placeFromParams, popularPlaces, regionsWithEvents } from '$lib/places';
import { sections } from '$lib/sections';
import { coverage, eventsAround, eventsInCityList } from '$lib/server/firestore';
import type { PageServerLoad } from './$types';

/** Card nell'HTML del server: oltre, il resto arriva da /api/events dopo l'idratazione (render di centinaia di card = CPU del Worker, #51). */
const SSR_CARDS = 12;

// SSR sul luogo dell'URL (?luogo=slug oppure ?nome=&lat=&lng=). I filtri si applicano nel browser; la posizione salvata
// dall'utente (solo nel suo localStorage) riporta qui con un link al luogo.
// Senza luogo il server non sceglie al posto dell'utente: niente eventi, ma i link alle regioni e alle città con più eventi
// (per chi non ha JavaScript e per i motori di ricerca); il browser porta al luogo salvato o chiede dove cercare.

export const load: PageServerLoad = async ({ url, setHeaders }) => {
	// La cache HTML (bordo e browser) vale solo per pagine complete: errore, lista parziale o copertura non letta → no-store.
	// Si decide alla fine di ogni ramo, non in anticipo: la pagina d'errore (200) altrimenti resterebbe 5 minuti in caches.default.
	let cacheable = true;
	const done = <T extends object>(data: T) => {
		setHeaders({ 'cache-control': cacheable ? HTML_CACHE : 'no-store' });
		return data;
	};
	const filter = filterFromParams(url.searchParams);
	const radiusKm = filter.radiusKm;
	const wanted = url.searchParams.has('luogo') || url.searchParams.has('lat');
	const regions = await coverage().catch(() => {
		cacheable = false;
		return [];
	});
	const slug = (url.searchParams.get('luogo') ?? '').trim().toLowerCase();
	let fromUrl = wanted ? placeFromParams(url.searchParams, regions) : null;
	// Qualsiasi comune italiano si apre anche senza eventi: lo risolve l'indice per iniziale, senza letture Firestore.
	if (wanted && !fromUrl) fromUrl = await comuneBySlug(slug);
	// Città con eventi ma (ancora) fuori dalla copertura: si ricava il luogo dagli eventi, mai il predefinito in silenzio.
	if (wanted && !fromUrl && /^[a-z0-9-]{1,80}$/.test(slug)) {
		const city = await eventsInCityList(slug, 20).catch(() => null);
		if (!city?.complete) cacheable = false;
		fromUrl = placeFromEvents(slug, city?.events ?? []);
	}
	const place: ChosenPlace = fromUrl ?? { ...DEFAULT_PLACE };
	// Senza raggio nell'URL, dove non ci sono eventi vicini si allarga fino a trovarne (se ce ne sono): il redirect tiene coerenti URL, filtri e pagina.
	const { radiusKm: auto, quiet } = fromUrl && regions.length ? autoRadius(place, regions) : { radiusKm, quiet: false };
	if (fromUrl && !url.searchParams.has('r') && auto !== radiusKm) {
		const to = new URL(url);
		to.searchParams.set('r', String(auto));
		redirect(307, to.pathname + to.search);
	}
	const nearest = fromUrl && quiet ? nearestWithEvents(place, regions) : [];
	const view = url.searchParams.get('vista') === 'mappa' ? ('map' as const) : ('list' as const);
	const base = { place, fromUrl: !!fromUrl, unknownPlace: wanted && !fromUrl ? slug : null, noPlace: !wanted, view, quiet, nearest };

	if (!wanted || !fromUrl) {
		// Senza luogo (o con un luogo che non conosciamo) niente eventi: si sceglie il luogo, non si ripiega su Modena.
		const popular = {
			regions: regionsWithEvents(regions),
			cities: popularPlaces(regions, 12)
				.filter((h) => h.events > 0)
				.map((h) => ({ slug: h.place.slug!, name: h.place.label, events: h.events }))
		};
		// popular c'è anche con un luogo sconosciuto: niente vicolo cieco, si scelgono le città con più eventi
		// km: 0 → mai "coperto": il browser scarica gli eventi solo dopo aver saputo il luogo
		return done({ ...base, events: [], fetched: { lat: place.lat, lng: place.lng, km: 0 }, error: '', popular, partial: false, total: 0, sectionCounts: null, version: '' });
	}

	try {
		const around = await eventsAround(place, radiusKm);
		if (!around.complete) cacheable = false;
		const { events: nearby, fetched, version } = around;
		// Con i filtri dell'URL le card sono già quelle che il browser mostrerebbe: le prime SSR_CARDS vanno nell'HTML, con i conteggi
		// dell'elenco intero (titoli di sezione e riepilogo senza salti). `fetched.km = 0` fa scaricare la lista completa dopo l'idratazione.
		const now = Date.now();
		const groups = sections(applyFilter(nearby, filter, now, place), now, groupingFor(filter, now));
		const total = groups.reduce((n, g) => n + g.events.length, 0);
		if (total <= SSR_CARDS) return done({ ...base, events: nearby, fetched, error: '', popular: null, partial: false, total, sectionCounts: null, version });
		const sectionCounts = Object.fromEntries(groups.map((g) => [g.key, g.events.length]));
		const first = groups.flatMap((g) => g.events).slice(0, SSR_CARDS);
		return done({ ...base, events: first, fetched: { lat: place.lat, lng: place.lng, km: 0 }, error: '', popular: null, partial: true, total, sectionCounts, version });
	} catch (e) {
		console.error(e);
		cacheable = false;
		// L'area risulta "coperta": il browser non riprova da solo mentre Firestore è in difficoltà.
		return done({ ...base, events: [], fetched: { lat: place.lat, lng: place.lng, km: radiusKm }, error: 'Non riesco a caricare gli eventi in questo momento. Riprova tra poco.', popular: null, partial: false, total: 0, sectionCounts: null, version: '' });
	}
};
