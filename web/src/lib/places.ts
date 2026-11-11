// Luoghi: normalizzazione, ranking sui comuni/regioni coperti e (de)serializzazione nell'URL della home.
// Puro e senza dipendenze dal browser: lo usano la ricerca, la load server e i test.
import { comunePlace as datasetPlace, fold, foldedScore, scoreComune, shorten, type Comune } from './comuni';
import { slugify } from './event';
import { filterToParams, type Filter } from './filters';
import { DEFAULT_RADIUS_KM, distanceKm, RADII_KM, type ChosenPlace, type LatLng } from './geo';

export interface CoverageComune {
	name: string;
	slug: string;
	province: string;
	lat: number;
	lng: number;
	events: number;
	/** Nome nell'altra lingua ufficiale (Bozen, Aoste). */
	alt?: string;
}
export interface CoverageRegion {
	slug: string;
	name: string;
	comuni: CoverageComune[];
}

/** Raggio proposto quando si sceglie una regione intera. */
export const REGION_RADIUS_KM = 100;

export { fold };

export interface PlaceHit {
	kind: 'comune' | 'regione';
	place: ChosenPlace;
	/** Riga di dettaglio: provincia o regione. */
	detail: string;
	events: number;
	/** 0 esatto, 1 prefisso, 2 inizio di parola, 3 contenuto. */
	score: number;
	/** Abitanti (0 se ignoti): a parità di eventi vince il comune più grande. */
	pop?: number;
}

const matchScore = (name: string, q: string) => foldedScore(fold(name), q);

/** Centro di una regione: media dei comuni pesata sul numero di eventi (semplice se nessuno ne ha). */
export function regionCenter(r: CoverageRegion): LatLng {
	const total = r.comuni.reduce((n, c) => n + c.events, 0);
	const w = (c: CoverageComune) => (total ? c.events : 1);
	const sum = r.comuni.reduce((n, c) => n + w(c), 0) || 1;
	return {
		lat: r.comuni.reduce((n, c) => n + c.lat * w(c), 0) / sum,
		lng: r.comuni.reduce((n, c) => n + c.lng * w(c), 0) / sum
	};
}

const regionPlace = (r: CoverageRegion): ChosenPlace => ({ ...regionCenter(r), label: r.name, slug: r.slug, region: r.name });
const comunePlace = (c: CoverageComune, r: CoverageRegion): ChosenPlace => ({
	lat: c.lat,
	lng: c.lng,
	label: c.name,
	slug: c.slug,
	region: r.name
});

/**
 * Comuni (anche col nome bilingue) poi regioni che corrispondono al testo, dal migliore.
 * Con `comuni` (dataset di tutti i comuni già unito alla copertura, vedi withCoverage) si cerca lì; senza, nei soli comuni coperti.
 * A parità di punteggio: prima i comuni, poi quelli con più eventi, più abitanti, in ordine alfabetico.
 */
export function rankPlaces(text: string, regions: CoverageRegion[], limit = 6, comuni: Comune[] = []): PlaceHit[] {
	const q = fold(text);
	if (q.length < 2) return [];
	const qs = shorten(q);
	const hits: PlaceHit[] = [];
	for (const c of comuni) {
		const score = scoreComune(c, q, qs);
		if (score !== null)
			hits.push({
				kind: 'comune',
				place: datasetPlace(c),
				detail: [c.alt, c.province && `(${c.province})`].filter(Boolean).join(' '),
				events: c.events,
				score,
				pop: c.pop
			});
	}
	for (const r of regions) {
		if (!comuni.length)
			for (const c of r.comuni) {
				const names = c.alt ? [c.name, c.alt, `${c.name} ${c.alt}`] : [c.name];
				const scores = names.map((n) => matchScore(n, q)).filter((s): s is number => s !== null);
				if (scores.length)
					hits.push({
						kind: 'comune',
						place: comunePlace(c, r),
						detail: [c.alt, c.province && `(${c.province})`].filter(Boolean).join(' '),
						events: c.events,
						score: Math.min(...scores)
					});
			}
		const s = matchScore(r.name, q);
		if (s !== null)
			hits.push({
				kind: 'regione',
				place: regionPlace(r),
				detail: 'Regione',
				events: r.comuni.reduce((n, c) => n + c.events, 0),
				score: s
			});
	}
	const kindOrder = { comune: 0, regione: 1 };
	return hits
		.sort(
			(a, b) =>
				a.score - b.score ||
				kindOrder[a.kind] - kindOrder[b.kind] ||
				b.events - a.events ||
				(b.pop ?? 0) - (a.pop ?? 0) ||
				a.place.label.localeCompare(b.place.label, 'it') ||
				a.detail.localeCompare(b.detail, 'it')
		)
		.slice(0, limit);
}

/** Il luogo che il testo nomina senza ambiguità (corrispondenza esatta o per prefisso), se c'è. */
export const strongPlace = (text: string, regions: CoverageRegion[], comuni: Comune[] = []) =>
	rankPlaces(text, regions, 1, comuni).find((h) => h.score <= 1) ?? null;

// Risultati memoizzati per identità dell'array di copertura: il Worker tiene lo stesso oggetto in memoria finché la cache non scade,
// quindi ordinare ~1.100 comuni (con localeCompare) si paga una volta per isolate invece che a ogni richiesta (#51).
const popularCache = new WeakMap<CoverageRegion[], Map<number, PlaceHit[]>>();

/** Comuni con più eventi: i suggerimenti quando si apre la ricerca dei luoghi senza scrivere. */
export function popularPlaces(regions: CoverageRegion[], limit = 6): PlaceHit[] {
	let byLimit = popularCache.get(regions);
	if (!byLimit) popularCache.set(regions, (byLimit = new Map()));
	const hit = byLimit.get(limit);
	if (hit) return hit;
	const all = regions.flatMap((r) => r.comuni.map((c) => ({ c, r })));
	// Ordinare solo chi ha eventi, se bastano a riempire l'elenco: lo spareggio per nome non tocca gli altri.
	const withEvents = all.filter(({ c }) => c.events > 0);
	const out = (withEvents.length >= limit ? withEvents : all)
		.sort((a, b) => b.c.events - a.c.events || a.c.name.localeCompare(b.c.name, 'it'))
		.slice(0, limit)
		.map(({ c, r }) => ({
			kind: 'comune' as const,
			place: comunePlace(c, r),
			detail: c.province ? `(${c.province})` : '',
			events: c.events,
			score: 0
		}));
	byLimit.set(limit, out);
	return out;
}

const regionTotalsCache = new WeakMap<CoverageRegion[], { slug: string; name: string; events: number }[]>();

/** Regioni con almeno un evento, dalla più ricca (totali per regione memoizzati come `popularPlaces`). */
export function regionsWithEvents(regions: CoverageRegion[]): { slug: string; name: string; events: number }[] {
	let out = regionTotalsCache.get(regions);
	if (!out) {
		out = regions
			.map((r) => ({ slug: r.slug, name: r.name, events: r.comuni.reduce((n, c) => n + c.events, 0) }))
			.filter((r) => r.events > 0)
			.sort((a, b) => b.events - a.events || a.name.localeCompare(b.name, 'it'));
		regionTotalsCache.set(regions, out);
	}
	return out;
}

/** Vero se un comune con eventi dista meno di `km` dal punto: altrimenti "Pochi eventi in questa zona". */
export const nearCovered = (p: LatLng, regions: CoverageRegion[], km = 25) =>
	regions.some((r) => r.comuni.some((c) => c.events > 0 && distanceKm(p, c) <= km));

/** Comuni coperti con eventi, dal più vicino al punto (con la distanza). */
export function nearestWithEvents(p: LatLng, regions: CoverageRegion[], n = 3): (ChosenPlace & { km: number })[] {
	return regions
		.flatMap((r) => r.comuni.filter((c) => c.events > 0).map((c) => ({ ...comunePlace(c, r), km: Math.round(distanceKm(p, c)) })))
		.sort((a, b) => a.km - b.km)
		.slice(0, n);
}

/**
 * Distanza (km, arrotondata come `nearestWithEvents`) dal comune con eventi più vicino, o null. Senza allocare un oggetto per comune e
 * senza trigonometria su ciascuno: una stima equirettangolare sceglie i candidati (errore ben sotto il 3% a queste distanze), la
 * distanza esatta di geofire si calcola solo su di loro. Stesso risultato di `nearestWithEvents(p, regions, 1)[0]?.km`.
 */
export function nearestEventsKm(p: LatLng, regions: CoverageRegion[]): number | null {
	const kx = Math.cos((p.lat * Math.PI) / 180) * 111.195;
	const ky = 111.195;
	let best = Infinity;
	for (const r of regions)
		for (const c of r.comuni) {
			if (c.events <= 0) continue;
			const dx = (c.lng - p.lng) * kx;
			const dy = (c.lat - p.lat) * ky;
			const d = dx * dx + dy * dy;
			if (d < best) best = d;
		}
	if (best === Infinity) return null;
	const limit = (Math.sqrt(best) * 1.03 + 1) ** 2;
	let exact = Infinity;
	for (const r of regions)
		for (const c of r.comuni) {
			if (c.events <= 0) continue;
			const dx = (c.lng - p.lng) * kx;
			const dy = (c.lat - p.lat) * ky;
			if (dx * dx + dy * dy <= limit) exact = Math.min(exact, distanceKm(p, c));
		}
	return Math.round(exact);
}

/**
 * Raggio con cui mostrare un luogo scelto senza raggio nell'URL: quello predefinito se entro lì ci sono eventi, altrimenti il più piccolo
 * dei raggi disponibili che arriva al comune con eventi più vicino (con 2 km di margine: gli eventi non sono al centro del comune).
 * `quiet` = nessun evento entro il raggio predefinito; senza eventi nemmeno al raggio massimo il raggio resta quello predefinito.
 */
export function autoRadius(p: LatLng, regions: CoverageRegion[]): { radiusKm: number; quiet: boolean } {
	const near = nearestEventsKm(p, regions);
	if (near === null || near <= DEFAULT_RADIUS_KM) return { radiusKm: DEFAULT_RADIUS_KM, quiet: near === null && regions.length > 0 };
	return { radiusKm: RADII_KM.find((r) => r >= near + 2) ?? DEFAULT_RADIUS_KM, quiet: true };
}

/** Raggio entro cui la posizione del dispositivo si "aggancia" a un comune coperto (l'unico dato che esce dal browser). */
export const NEAREST_COMUNE_KM = 30;

/** Il comune coperto più vicino al punto, se sta entro `km`. */
export function nearestComune(p: LatLng, regions: CoverageRegion[], km = NEAREST_COMUNE_KM): ChosenPlace | null {
	let best: { d: number; place: ChosenPlace } | null = null;
	for (const r of regions)
		for (const c of r.comuni) {
			const d = distanceKm(p, c);
			if (d <= km && (!best || d < best.d)) best = { d, place: comunePlace(c, r) };
		}
	return best?.place ?? null;
}

/**
 * Luogo ricavato dagli eventi di una città non (ancora) presente nella copertura: centro medio dei punti attendibili.
 * Null senza eventi o senza coordinate in Italia.
 */
export function placeFromEvents(slug: string, events: { city: string; region?: string; lat: number; lng: number; approxLocation?: boolean }[]): ChosenPlace | null {
	const exact = events.filter((e) => !e.approxLocation && inItaly(e.lat, e.lng));
	const at = exact.length ? exact : events.filter((e) => inItaly(e.lat, e.lng));
	if (!at.length) return null;
	const mean = (k: 'lat' | 'lng') => at.reduce((n, e) => n + e[k], 0) / at.length;
	return { lat: mean('lat'), lng: mean('lng'), label: at[0].city, slug, region: at[0].region };
}

// --- URL della home: ?luogo=<slug> oppure ?nome=&lat=&lng= ---

const ITALY = { lat: [35, 48], lng: [6, 19.5] };
const inItaly = (lat: number, lng: number) =>
	Number.isFinite(lat) && Number.isFinite(lng) && lat >= ITALY.lat[0] && lat <= ITALY.lat[1] && lng >= ITALY.lng[0] && lng <= ITALY.lng[1];

/** Luogo indicato nell'URL, o null se manca o non è valido (la home usa allora il predefinito o quello salvato). */
export function placeFromParams(p: URLSearchParams, regions: CoverageRegion[]): ChosenPlace | null {
	const slug = p.get('luogo');
	if (slug) {
		if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
		for (const r of regions) {
			const c = r.comuni.find((x) => x.slug === slug);
			if (c) return comunePlace(c, r);
		}
		const r = regions.find((x) => x.slug === slug || slugify(x.name) === slug);
		return r?.comuni.length ? regionPlace(r) : null;
	}
	const lat = Number(p.get('lat'));
	const lng = Number(p.get('lng'));
	if (p.get('lat') === null || p.get('lng') === null || !inItaly(lat, lng)) return null;
	return { lat, lng, label: (p.get('nome') ?? '').trim().slice(0, 80) || 'La tua posizione' };
}

/** Query della home per un luogo: lo slug se è coperto, altrimenti nome e coordinate (a ~1 km) di una località scelta. La posizione del dispositivo non mette mai le sue coordinate nell'URL. */
export function placeToParams(place: ChosenPlace): URLSearchParams {
	const p = new URLSearchParams();
	if (place.slug) p.set('luogo', place.slug);
	else if (!place.exact) {
		p.set('nome', place.label.slice(0, 80));
		p.set('lat', place.lat.toFixed(2));
		p.set('lng', place.lng.toFixed(2));
	}
	return p;
}

/** Indirizzo della home con luogo, filtri ed eventuale vista mappa. */
export function homeUrl(filter: Filter, place: ChosenPlace | null, view: 'list' | 'map' = 'list'): string {
	const p = place ? placeToParams(place) : new URLSearchParams();
	for (const [k, v] of filterToParams(filter)) p.set(k, v);
	if (view === 'map') p.set('vista', 'mappa');
	const qs = p.toString();
	return qs ? `/?${qs}` : '/';
}
