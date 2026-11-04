import { error, isHttpError, json } from '@sveltejs/kit';
import { placeFromNominatim } from '$lib/geo';
import { siteUrl } from '$lib/config';
import type { GeoResult } from '$lib/geocode';
import type { RequestHandler } from './$types';

// Proxy verso Nominatim nel rispetto della policy OSM (https://operations.osmfoundation.org/policies/nominatim/):
// User-Agent identificativo, risposte in cache 1 giorno all'edge, massimo 1 richiesta al secondo per isolate.
// L'IP dell'utente non arriva a Nominatim; nulla viene salvato.
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'EventiVicini/1.0 (+https://github.com/AndreaAzzarello/EventiVicini)';

let last = 0;
let chain: Promise<unknown> = Promise.resolve();
// shortcut: limite per isolate, non globale; se il traffico cresce serve un geocoder self-hosted (Photon/Nominatim).
function throttle<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(async () => {
		const wait = last + 1000 - Date.now();
		if (wait > 2500) throw error(429, 'Troppe richieste');
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		last = Date.now();
		return fn();
	});
	chain = run.catch(() => undefined);
	return run;
}

type Hit = { lat: string; lon: string; name?: string; display_name: string; address?: Record<string, string> };

function label(h: Hit, kind: string): string {
	const place = placeFromNominatim(h.address);
	if (kind === 'city' && place) return place.province ? `${place.city} (${place.province})` : place.city;
	return h.display_name.split(', ').slice(0, 4).join(', ');
}

export const GET: RequestHandler = async ({ url, setHeaders }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	const kind = url.searchParams.get('kind') === 'address' ? 'address' : 'city';
	const lat = Number(url.searchParams.get('lat'));
	const lng = Number(url.searchParams.get('lng'));
	const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', 'accept-language': 'it' });
	let endpoint: string;
	if (q) {
		if (q.length < 2 || q.length > 120) error(400, 'Ricerca troppo corta o troppo lunga');
		endpoint = 'search';
		params.set('q', q);
		params.set('countrycodes', 'it');
		params.set('limit', '5');
		if (kind === 'city') params.set('featureType', 'settlement');
	} else if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
		endpoint = 'reverse';
		params.set('lat', lat.toFixed(4));
		params.set('lon', lng.toFixed(4));
		params.set('zoom', '14');
	} else error(400, 'Parametri mancanti');

	let body: Hit[] | Hit | { error: string };
	try {
		const res = await throttle(() =>
			fetch(`${NOMINATIM}/${endpoint}?${params}`, {
				headers: { 'User-Agent': USER_AGENT, Referer: siteUrl() }
			})
		);
		if (!res.ok) error(502, 'Geocoding non disponibile');
		body = (await res.json()) as Hit[] | Hit | { error: string };
	} catch (e) {
		if (isHttpError(e)) throw e; // 429 del limite interno e 502 di sopra restano quelli
		error(502, 'Geocoding non disponibile'); // rete assente, timeout o risposta non JSON: Nominatim non è raggiungibile
	}
	const hits = Array.isArray(body) ? body : 'lat' in body ? [body] : [];
	const results: GeoResult[] = hits.map((h) => ({
		label: label(h, kind),
		lat: Number(h.lat),
		lng: Number(h.lon),
		place: placeFromNominatim(h.address)
	}));
	setHeaders({ 'cache-control': 'public, max-age=86400, s-maxage=86400' });
	return json(results);
};
