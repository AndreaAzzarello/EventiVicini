// Letture Firestore lato server via API REST pubblica: niente Admin SDK nel Worker.
// Credenziali: account di servizio di sola lettura (gauth.ts); finché il segreto non c'è si ripiega sulla lettura pubblica con la API key web.
import { env } from '$env/dynamic/private';
import { env as pub } from '$env/dynamic/public';
import { compareEvents, fromData, type Event } from '$lib/event';
import { SNAP_MARGIN_KM, distanceKm, radiusBounds, snapCoord, type LatLng } from '$lib/geo';
import { cellsAround, parseRows, rowToEvent } from './bundles';
import { firestoreAuthHeader } from './gauth';

type Value = {
	stringValue?: string;
	integerValue?: string;
	doubleValue?: number;
	booleanValue?: boolean;
	timestampValue?: string;
	nullValue?: null;
	arrayValue?: { values?: Value[] };
	mapValue?: { fields?: Record<string, Value> };
};
type Doc = { name: string; fields?: Record<string, Value> };

export function decode(v: Value): unknown {
	if ('stringValue' in v) return v.stringValue;
	if ('integerValue' in v) return Number(v.integerValue);
	if ('doubleValue' in v) return v.doubleValue;
	if ('booleanValue' in v) return v.booleanValue;
	if ('timestampValue' in v) return Date.parse(v.timestampValue!);
	if ('arrayValue' in v) return (v.arrayValue!.values ?? []).map(decode);
	if ('mapValue' in v) return decodeFields(v.mapValue!.fields);
	return null;
}
const decodeFields = (f: Record<string, Value> = {}) =>
	Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decode(v)]));
// removedAt: l'importer ha marcato l'evento come sparito dalla fonte (dopo 2 import); non si cancella subito.
const visible = (d: Doc) => !d.fields?.removedAt;
const toEvent = (d: Doc) => fromData(d.name.slice(d.name.lastIndexOf('/') + 1), decodeFields(d.fields));

function root() {
	const host = env.FIRESTORE_EMULATOR_HOST;
	const project = pub.PUBLIC_FIREBASE_PROJECT_ID;
	return {
		url: `${host ? `http://${host}` : 'https://firestore.googleapis.com'}/v1/projects/${project}/databases/(default)/documents`,
		name: `projects/${project}/databases/(default)/documents`,
		key: host ? '' : `key=${pub.PUBLIC_FIREBASE_API_KEY}`
	};
}

export let readCount = 0; // per i test e per la stima delle letture

async function call<T>(path: string, body?: unknown): Promise<T | null> {
	const r = root();
	// Con l'account di servizio si legge con il suo token (le regole non si applicano, i permessi sono quelli IAM);
	// senza (segreto assente) si ripiega sulla chiave web e sulla lettura pubblica delle regole. Mai entrambi.
	const authorization = await firestoreAuthHeader();
	const sep = path.includes('?') ? '&' : '?';
	const res = await fetch(`${r.url}${path}${!authorization && r.key ? sep + r.key : ''}`, {
		method: body ? 'POST' : 'GET',
		headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(authorization ? { authorization } : {}) },
		body: body ? JSON.stringify(body) : undefined
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return res.json() as Promise<T>;
}

// Due livelli di cache: memoria dell'isolate e Cache API di Cloudflare (per data center, sopravvive a isolate e deploy).
// I dati cambiano una volta al giorno (import) o a mano dall'admin: la maggior parte dei visitatori non tocca Firestore.
// Scaduta la freschezza si rilegge; se Firestore risponde 429 (quota esaurita) o fallisce, si serve l'ultima copia.
// shortcut: la Cache API è per data center, non globale (KV costerebbe un token e un binding); assente in Node e nel dev server.
type Entry = { at: number; value: unknown };
const memo = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const HOUR = 3_600_000;
const FRESH = { list: 6 * HOUR, one: HOUR, sitemap: 12 * HOUR };
const KEEP_S = 2 * 86_400; // quanto resta una copia nella Cache API, anche scaduta, per servirla in emergenza
const BLOCK_MS = 10 * 60_000; // dopo un 429 non si interroga Firestore per 10 minuti
let blockedUntil = 0;

const edge = () => (globalThis as { caches?: { default?: Cache } }).caches?.default;
const edgeReq = (key: string) => new Request(`https://cache.internal/fs-v1/${encodeURIComponent(key)}`);
async function edgeGet(key: string): Promise<Entry | undefined> {
	try {
		const res = await edge()?.match(edgeReq(key));
		return res ? ((await res.json()) as Entry) : undefined;
	} catch {
		return undefined;
	}
}
async function edgePut(key: string, entry: Entry) {
	try {
		await edge()?.put(edgeReq(key), new Response(JSON.stringify(entry), { headers: { 'cache-control': `public, max-age=${KEEP_S}` } }));
	} catch (err) {
		console.warn('Cache API non scrivibile:', err);
	}
}
function remember(key: string, entry: Entry) {
	if (memo.size > 300) memo.delete(memo.keys().next().value!);
	memo.set(key, entry);
}

async function cached<T>(key: string, load: () => Promise<T>, fresh: number = FRESH.one): Promise<T> {
	let hit = memo.get(key);
	if (hit && Date.now() - hit.at < fresh) return hit.value as T;
	const shared = await edgeGet(key);
	if (shared && (!hit || shared.at > hit.at)) hit = shared;
	if (hit && Date.now() - hit.at < fresh) {
		remember(key, hit);
		return hit.value as T;
	}
	if (Date.now() < blockedUntil) {
		if (hit) return hit.value as T;
		throw new Error('Firestore 429: quota esaurita, riprovo tra poco');
	}
	let run = inflight.get(key) as Promise<T> | undefined;
	if (!run) {
		run = load()
			.then(async (value) => {
				const entry = { at: Date.now(), value };
				remember(key, entry);
				await edgePut(key, entry);
				return value;
			})
			.finally(() => inflight.delete(key));
		inflight.set(key, run);
	}
	try {
		return await run;
	} catch (err) {
		if (String(err).includes('Firestore 429')) blockedUntil = Date.now() + BLOCK_MS;
		if (!hit) throw err;
		console.warn(`Firestore non risponde, servo la copia di ${Math.round((Date.now() - hit.at) / 60_000)} minuti fa:`, err);
		return hit.value as T;
	}
}

type Filter = { fieldFilter: { field: { fieldPath: string }; op: string; value: Value } };
const f = (field: string, op: string, value: Value): Filter => ({
	fieldFilter: { field: { fieldPath: field }, op, value }
});
const int = (n: number): Value => ({ integerValue: String(n) });

async function runQuery(where: Filter[], orderBy: string[], limit: number): Promise<Event[]> {
	const rows = await call<{ document?: Doc }[]>(':runQuery', {
		structuredQuery: {
			from: [{ collectionId: 'events' }],
			where: where.length === 1 ? where[0] : { compositeFilter: { op: 'AND', filters: where } },
			orderBy: orderBy.map((fieldPath) => ({ field: { fieldPath }, direction: 'ASCENDING' })),
			limit
		}
	});
	const docs = (rows ?? []).flatMap((r) => (r.document ? [r.document] : []));
	readCount += Math.max(docs.length, 1); // una query vuota costa comunque una lettura
	return docs.filter(visible).map(toEvent);
}

/** Minuto corrente: rende stabili le chiavi di cache. */
const nowMinute = () => Math.floor(Date.now() / 60_000) * 60_000;

/** Esportato per i test. */
export const PER_CELL_LIMIT = 150;

/** Celle per richiesta: 100 km + margine sono ~120 celle; di più è un abuso, non si legge nulla. */
export const MAX_CELLS = 150;
/** Id per richiesta di /api/events?ids=. */
export const MAX_IDS = 25;

/** Limite per la query dedicata agli eventi lunghi (mostre, rassegne): sono pochi rispetto ai puntuali. */
const LONG_LIMIT = 100;
const TRUE: Value = { booleanValue: true };

/**
 * Eventi longRunning: i limiti delle query ordinano per fine più vicina e in una cella densa taglierebbero
 * proprio le mostre che finiscono tardi. Query a parte; se l'indice non c'è ancora (firestore.indexes.json
 * non pubblicato) si degrada al comportamento precedente invece di rompere la lista.
 */
async function longRunningQuery(where: Filter[], orderBy: string[]): Promise<Event[]> {
	try {
		return await runQuery([...where, f('longRunning', 'EQUAL', TRUE)], orderBy, LONG_LIMIT);
	} catch (err) {
		if (String(err).includes('Firestore 429')) throw err; // quota esaurita: non è un indice mancante, niente lista vuota in cache
		console.warn('query longRunning non riuscita (indice mancante?):', err);
		return [];
	}
}

// Liste precalcolate dall'importer (collezione bundles, vedi bundles.ts): una lettura per cella o città invece di una per
// evento. Finché il primo import non li ha creati (bundles/coverage assente) si ricade sulle query sulla collezione events.
// bundles/coverage è scritto dallo stesso import: se c'è, ci sono anche le liste. Lo legge comunque ogni pagina (è la copertura).
const bundlesReady = async () => (await coverageBundle()) !== null;

/** Righe dei bundle richiesti (una richiesta; una seconda solo per quelli divisi in più documenti). Un bundle assente è vuoto. */
async function readBundles(names: string[]): Promise<unknown[][]> {
	if (!names.length) return [];
	const r = root();
	const batchGet = async (ids: string[]) => {
		readCount += ids.length;
		const rows = await call<{ found?: Doc }[]>(':batchGet', { documents: ids.map((n) => `${r.name}/bundles/${n}`) });
		return new Map((rows ?? []).flatMap((x) => (x.found ? [[x.found.name.slice(x.found.name.lastIndexOf('/') + 1), decodeFields(x.found.fields) as { json?: string; parts?: number }] as const] : [])));
	};
	const first = new Map<string, string[]>();
	const more: string[] = [];
	for (const [name, d] of await batchGet(names)) {
		first.set(name, [d.json ?? '[]']);
		for (let k = 1; k < (d.parts ?? 1); k++) more.push(`${name}~${k}`);
	}
	if (more.length) for (const [name, d] of await batchGet(more)) first.get(name.split('~')[0])?.push(d.json ?? '[]');
	return [...first.values()].flatMap(parseRows);
}

/** Più cache di liste ripetono lo stesso evento: id unico, finito escluso. */
const liveEvents = (rows: unknown[][], now: number) => {
	const seen = new Set<string>();
	return rows.map(rowToEvent).filter((e) => e.endTime >= now && !seen.has(e.id) && seen.add(e.id));
};

/** Eventi non finiti entro km dal centro: una query per intervallo di geohash, mai l'intera collezione. */
export function eventsNear(center: LatLng, km: number): Promise<Event[]> {
	return cached(`near:${center.lat},${center.lng},${km}`, async () => {
		const now = nowMinute();
		if (await bundlesReady()) {
			const cells = cellsAround(center, km);
			if (cells.length > MAX_CELLS) throw new Error(`Troppe celle: ${cells.length}`);
			const rows = await readBundles(cells);
			return liveEvents(rows, now).filter((e) => distanceKm(center, e) <= km).sort(compareEvents(now));
		}
		const batches = await Promise.all(
			radiusBounds(center, km).flatMap(([start, end]) => {
				const where = [
					f('geohash', 'GREATER_THAN_OR_EQUAL', { stringValue: start }),
					f('geohash', 'LESS_THAN_OR_EQUAL', { stringValue: end }),
					f('endTime', 'GREATER_THAN_OR_EQUAL', int(now))
				];
				return [
					// Cella densa: il limite taglia per fine più vicina (imminenti e in corso), non per geohash.
					// Richiede l'indice (endTime, geohash) in firestore.indexes.json.
					// shortcut: a parità di endTime vale il geohash, non la distanza vera dal centro.
					runQuery(where, ['endTime', 'geohash'], PER_CELL_LIMIT),
					// Indice (longRunning, endTime, geohash).
					longRunningQuery(where, ['endTime', 'geohash'])
				];
			})
		);
		const seen = new Set<string>();
		return batches
			.flat()
			.filter((e) => !seen.has(e.id) && seen.add(e.id) && distanceKm(center, e) <= km)
			.sort(compareEvents(now));
	}, FRESH.list);
}

/**
 * Eventi attorno a un luogo, dal punto della griglia di ~5 km più vicino (come /api/events): la home e il browser
 * condividono la stessa chiave di cache. Chi chiama rifiltra sulla distanza vera e `fetched` dice cosa è coperto.
 */
export function eventsAround(place: LatLng, radiusKm: number) {
	const center = { lat: snapCoord(place.lat), lng: snapCoord(place.lng) };
	const km = radiusKm + SNAP_MARGIN_KM;
	return eventsNear(center, km).then((events) => ({ events, fetched: { ...center, km } }));
}

export function eventsInCity(citySlug: string, limit = 100): Promise<Event[]> {
	return cached(`city:${citySlug}:${limit}`, async () => {
		if (/^[a-z0-9-]{1,80}$/.test(citySlug) && (await bundlesReady())) {
			// Niente controllo sulla copertura: una città può avere eventi (manuali, regionali) senza stare in coverage.
			return liveEvents(await readBundles([`c_${citySlug}`]), nowMinute()).sort(compareEvents(Date.now())).slice(0, limit);
		}
		const where = [f('citySlug', 'EQUAL', { stringValue: citySlug }), f('endTime', 'GREATER_THAN_OR_EQUAL', int(nowMinute()))];
		// Indice (citySlug, longRunning, endTime) per la seconda query.
		const [list, long] = await Promise.all([runQuery(where, ['endTime'], limit), longRunningQuery(where, ['endTime'])]);
		const seen = new Set<string>();
		return [...list, ...long].filter((e) => !seen.has(e.id) && seen.add(e.id)).sort(compareEvents(Date.now()));
	}, FRESH.list);
}

export function upcomingEvents(limit: number): Promise<Event[]> {
	return cached(
		`upcoming:${limit}`,
		async () =>
			(await bundlesReady())
				? liveEvents(await readBundles(['sitemap']), nowMinute()).sort((a, b) => a.endTime - b.endTime).slice(0, limit)
				: runQuery([f('endTime', 'GREATER_THAN_OR_EQUAL', int(nowMinute()))], ['endTime'], limit),
		FRESH.sitemap
	);
}

export interface CoverageComune {
	name: string;
	slug: string;
	province: string;
	lat: number;
	lng: number;
	events: number;
	/** Nome nell'altra lingua ufficiale (Bozen, Aoste), se il comune è bilingue. */
	alt?: string;
}
export interface Coverage {
	slug: string;
	name: string;
	comuni: CoverageComune[];
}

const toCoverage = (d: Doc): Coverage => {
	const f = decodeFields(d.fields) as Partial<Coverage>;
	return { slug: d.name.slice(d.name.lastIndexOf('/') + 1), name: f.name ?? '', comuni: f.comuni ?? [] };
};

/** Copertura di tutte le regioni in un documento (bundles/coverage): una lettura invece di una per regione. Null finché non esiste. */
const coverageBundle = (): Promise<Coverage[] | null> =>
	cached('coverage-bundle', async () => {
		readCount++;
		const doc = await call<Doc>('/bundles/coverage');
		const json = doc && (decodeFields(doc.fields) as { json?: string }).json;
		return json ? (JSON.parse(json) as Coverage[]) : null;
	});

/**
 * Regioni coperte e loro comuni (scritto ogni giorno dall'importer). Con il bundle una sola voce in cache (niente copia sotto un'altra
 * chiave: ogni voce costa una lettura dalla Cache API e un parse da ~110 KB a ogni avvio a freddo, #51); senza, una lettura per regione.
 */
export async function coverage(): Promise<Coverage[]> {
	const bundle = await coverageBundle();
	if (bundle) return bundle;
	return cached('coverage', async () => {
		const res = await call<{ documents?: Doc[] }>('/coverage?pageSize=50');
		const docs = res?.documents ?? [];
		readCount += Math.max(docs.length, 1);
		return docs.map(toCoverage).sort((a, b) => a.name.localeCompare(b.name, 'it'));
	});
}

export function regionCoverage(slug: string): Promise<Coverage | null> {
	if (!/^[a-z0-9-]{1,70}$/.test(slug)) return Promise.resolve(null);
	return cached(`region:${slug}`, async () => {
		const bundle = await coverageBundle();
		if (bundle) return bundle.find((r) => r.slug === slug) ?? null; // bundle presente: una regione assente non esiste, niente lettura
		readCount++;
		const doc = await call<Doc>(`/coverage/${slug}`);
		return doc ? toCoverage(doc) : null;
	});
}

export function getEvent(id: string): Promise<Event | null> {
	if (!/^[A-Za-z0-9_]{1,64}$/.test(id)) return Promise.resolve(null);
	return cached(`event:${id}`, async () => {
		readCount++;
		const doc = await call<Doc>(`/events/${id}`);
		return doc && visible(doc) ? toEvent(doc) : null;
	});
}

/** Più eventi per id in una richiesta (preferiti degli utenti non loggati): id unici e ordinati, in cache come il resto. */
export function getEvents(ids: string[]): Promise<Event[]> {
	const valid = [...new Set(ids.filter((id) => /^[A-Za-z0-9_]{1,64}$/.test(id)))].sort().slice(0, MAX_IDS);
	if (!valid.length) return Promise.resolve([]);
	return cached(`events:${valid.join(',')}`, async () => {
		const r = root();
		const rows = await call<{ found?: Doc }[]>(':batchGet', {
			documents: valid.map((id) => `${r.name}/events/${id}`)
		});
		readCount += valid.length;
		return (rows ?? []).flatMap((x) => (x.found && visible(x.found) ? [toEvent(x.found)] : []));
	});
}

export interface MonthStats {
	events: number;
	comuni: number;
}

/** Statistiche del mese corrente e del precedente di una regione (stats/{regione}_{AAAA-MM}, scritte dall'importer). */
export function monthStats(region: string, keys: { cur: string; prev: string }): Promise<{ cur: MonthStats | null; prev: MonthStats | null }> {
	if (!/^[a-z0-9-]{1,70}$/.test(region)) return Promise.resolve({ cur: null, prev: null });
	return cached(`stats:${region}:${keys.cur}`, async () => {
		const r = root();
		const names = [keys.cur, keys.prev].map((k) => `${r.name}/stats/${region}_${k}`);
		const rows = await call<{ found?: Doc }[]>(':batchGet', {
			documents: names,
			mask: { fieldPaths: ['events', 'comuni'] } // senza `ids`, che pesa decine di KB
		});
		readCount += names.length;
		const byName = new Map((rows ?? []).flatMap((x) => (x.found ? [[x.found.name, x.found] as const] : [])));
		const read = (n: string): MonthStats | null => {
			const f = byName.has(n) ? (decodeFields(byName.get(n)!.fields) as Partial<MonthStats>) : null;
			return f && typeof f.events === 'number' ? { events: f.events, comuni: f.comuni ?? 0 } : null;
		};
		return { cur: read(names[0]), prev: read(names[1]) };
	});
}
