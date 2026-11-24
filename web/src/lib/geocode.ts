// Geocoding dal browser passando dal nostro /api/geocode (che aggiunge lo User-Agent richiesto da Nominatim).
// Qui: cache in memoria + localStorage e al massimo 1 richiesta al secondo per scheda.
import type { Place } from './geo';
import { KEYS, readJson, writeJson } from './storage';

export interface GeoResult {
	label: string;
	/** Dettaglio che distingue risultati con lo stesso nome (tipo di luogo, comune, provincia, CAP). */
	detail?: string;
	lat: number;
	lng: number;
	place: Place | null;
}

/**
 * Versione del formato della risposta di /api/geocode. Alzala quando il formato cambia: finisce nell'URL di ogni richiesta
 * (cambia la chiave della cache del bordo Cloudflare e di quella HTTP del browser, che indicizzano per URL) e nella chiave locale.
 * La 2 non basta più: la #100 chiedeva l'URL senza versione, riceveva dal bordo il formato vecchio e lo salvava sotto `v2:`.
 */
export const GEOCODE_FORMAT = 3;

const MAX_CACHE = 60;
let cache: Record<string, GeoResult[]> | null = null;
let last = 0;
let queue: Promise<unknown> = Promise.resolve();

function store() {
	cache ??= readJson<Record<string, GeoResult[]>>(KEYS.geocodeCache, {});
	return cache;
}

/** Serializza le chiamate e le distanzia di almeno 1 s. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
	const run = queue.then(async () => {
		const wait = last + 1000 - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		last = Date.now();
		return fn();
	});
	queue = run.catch(() => undefined);
	return run;
}

async function cachedCall(key: string, params: URLSearchParams): Promise<GeoResult[]> {
	const c = store();
	key = `v${GEOCODE_FORMAT}:${key}`;
	if (c[key]) return c[key];
	params.set('v', String(GEOCODE_FORMAT));
	const results = await throttled(async () => {
		const res = await fetch(`/api/geocode?${params}`);
		if (!res.ok) throw new Error(res.status === 429 ? 'Troppe ricerche, riprova tra poco' : 'Ricerca non disponibile');
		return (await res.json()) as GeoResult[];
	});
	const keys = Object.keys(c);
	if (keys.length >= MAX_CACHE) delete c[keys[0]];
	c[key] = results;
	writeJson(KEYS.geocodeCache, c);
	return results;
}

export function searchPlaces(q: string, kind: 'city' | 'address' = 'city') {
	const query = q.trim().replace(/\s+/g, ' ');
	return cachedCall(`${kind}:${query.toLowerCase()}`, new URLSearchParams({ q: query, kind }));
}

export async function reversePlace(lat: number, lng: number): Promise<GeoResult | null> {
	const [la, ln] = [lat.toFixed(4), lng.toFixed(4)];
	const [hit] = await cachedCall(`rev:${la},${ln}`, new URLSearchParams({ lat: la, lng: ln }));
	return hit ?? null;
}

/** Debounce per i campi di ricerca. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms = 450) {
	let t: ReturnType<typeof setTimeout>;
	return (...a: A) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...a), ms);
	};
}
