import { redirect } from '@sveltejs/kit';
import { HTML_CACHE } from '$lib/server/cache';
import { comuneBySlug } from '$lib/server/comuneSlug';
import { filterFromParams } from '$lib/filters';
import { DEFAULT_PLACE, type ChosenPlace } from '$lib/geo';
import { autoRadius, nearestWithEvents, placeFromEvents, placeFromParams, popularPlaces, regionsWithEvents } from '$lib/places';
import { coverage, eventsAround, eventsInCity } from '$lib/server/firestore';
import type { PageServerLoad } from './$types';

// SSR sul luogo dell'URL (?luogo=slug oppure ?nome=&lat=&lng=). I filtri si applicano nel browser; la posizione salvata
// dall'utente (solo nel suo localStorage) riporta qui con un link al luogo.
// Senza luogo il server non sceglie al posto dell'utente: niente eventi, ma i link alle regioni e alle città con più eventi
// (per chi non ha JavaScript e per i motori di ricerca); il browser porta al luogo salvato o chiede dove cercare.

export const load: PageServerLoad = async ({ url, setHeaders }) => {
	setHeaders({ 'cache-control': HTML_CACHE });
	const radiusKm = filterFromParams(url.searchParams).radiusKm;
	const wanted = url.searchParams.has('luogo') || url.searchParams.has('lat');
	const regions = await coverage().catch(() => []);
	const slug = url.searchParams.get('luogo') ?? '';
	let fromUrl = wanted ? placeFromParams(url.searchParams, regions) : null;
	// Qualsiasi comune italiano si apre anche senza eventi: lo risolve l'indice per iniziale, senza letture Firestore.
	if (wanted && !fromUrl) fromUrl = await comuneBySlug(slug);
	// Città con eventi ma (ancora) fuori dalla copertura: si ricava il luogo dagli eventi, mai il predefinito in silenzio.
	if (wanted && !fromUrl && /^[a-z0-9-]{1,80}$/.test(slug)) fromUrl = placeFromEvents(slug, await eventsInCity(slug, 20).catch(() => []));
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
		// km: 0 → mai "coperto": il browser scarica gli eventi solo dopo aver saputo il luogo
		return { ...base, events: [], fetched: { lat: place.lat, lng: place.lng, km: 0 }, error: '', popular: wanted ? null : popular };
	}

	try {
		return { ...base, ...(await eventsAround(place, radiusKm)), error: '', popular: null };
	} catch (e) {
		console.error(e);
		// L'area risulta "coperta": il browser non riprova da solo mentre Firestore è in difficoltà.
		return { ...base, events: [], fetched: { lat: place.lat, lng: place.lng, km: radiusKm }, error: 'Non riesco a caricare gli eventi in questo momento. Riprova tra poco.', popular: null };
	}
};
