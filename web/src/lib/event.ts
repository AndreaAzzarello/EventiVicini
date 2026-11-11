// Modello Event: stessi campi della versione Flutter + geohash e località normalizzate.
// I limiti coincidono con firebase/firestore.rules (validEventFields).

import { romeParts, shortDate } from './dates';

export const CATEGORIES = {
	music: 'Musica',
	food: 'Cibo e sagre',
	sport: 'Sport',
	culture: 'Cultura',
	kids: 'Bambini',
	market: 'Mercati',
	other: 'Altro'
} as const;
export type Category = keyof typeof CATEGORIES;

// unknown: prezzo non dato dalla fonte (biglietti Ticketmaster senza fasce): si rimanda al sito del venditore
export const PRICE_TYPES = { free: 'Gratis', low: 'Economico', premium: 'A pagamento', unknown: 'Prezzo sul sito' } as const;
export type PriceType = keyof typeof PRICE_TYPES;

export const LIMITS = {
	title: 200,
	shortDescription: 1000,
	venueName: 200,
	address: 300,
	url: 500,
	tags: 10,
	tag: 30,
	city: 80
} as const;

/** Campi modificabili da form (admin e proposte). */
export interface EventInput {
	title: string;
	shortDescription: string;
	category: Category;
	priceType: PriceType;
	startTime: number; // ms epoch
	endTime: number;
	venueName: string;
	address: string;
	lat: number;
	lng: number;
	imageUrl: string;
	ticketUrl: string;
	tags: string[];
	geohash: string;
	city: string;
	citySlug: string;
	province: string; // sigla, es. "MO"
	region: string;
}

// Record<keyof EventInput, true>: un campo aggiunto a EventInput e non qui (o viceversa) rompe `npm run check`.
// Deve coincidere con eventKeys() in firestore.rules e con docs/schema/parity.json (schema-parity.test.ts).
const EVENT_KEY_MAP: Record<keyof EventInput, true> = {
	title: true, shortDescription: true, category: true, priceType: true, startTime: true, endTime: true,
	venueName: true, address: true, lat: true, lng: true, imageUrl: true, ticketUrl: true, tags: true,
	geohash: true, city: true, citySlug: true, province: true, region: true
};
export const EVENT_KEYS = Object.keys(EVENT_KEY_MAP) as (keyof EventInput)[];

export interface Event extends EventInput {
	id: string;
	source: 'manual' | 'scraper' | 'user';
	sourceUrl: string;
	/** true = posizione approssimata al centro del comune (scritta dall'importer). */
	approxLocation: boolean;
	/** Frazione (es. "Sant'Agostino"), scritta dall'importer; city resta il comune. Solo da mostrare: mai per URL o raggruppamenti. */
	locality: string;
	/** Nome nell'altra lingua ufficiale dei comuni bilingui (Bozen, Aoste); city resta il nome italiano. */
	cityAlt?: string;
	/** true = dura più di LONG_RUNNING_DAYS giorni (mostre, rassegne). Non è nel form: si ricava dalle date. */
	longRunning: boolean;
	createdAt?: number;
	updatedAt?: number;
}

export const LONG_RUNNING_DAYS = 14;

/** Elenchi e mappa leggono liste precalcolate dall'importer (bundle): un evento salvato dall'admin vi entra al prossimo import. */
export const LISTING_NOTE = 'Visibile in elenco e mappa dal prossimo aggiornamento (entro 24 ore); la pagina dell’evento è già online.';

const str = (v: unknown, fallback = '') => (v == null ? fallback : String(v));
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

/** Documento Firestore → Event. Ignora i campi interni (submittedBy). Default come Event.fromMap in Dart. */
export function fromData(id: string, m: Record<string, unknown>): Event {
	const start = num(m.startTime);
	const endMs = m.endTime == null ? start : num(m.endTime);
	const category = str(m.category, 'other');
	const priceType = str(m.priceType, 'free');
	const source = str(m.source, 'manual');
	return {
		id,
		title: str(m.title),
		shortDescription: str(m.shortDescription),
		category: (category in CATEGORIES ? category : 'other') as Category,
		priceType: (priceType in PRICE_TYPES ? priceType : 'free') as PriceType,
		startTime: start,
		endTime: endMs,
		venueName: str(m.venueName),
		address: str(m.address),
		lat: num(m.lat),
		lng: num(m.lng),
		imageUrl: safeUrl(str(m.imageUrl)),
		ticketUrl: safeUrl(str(m.ticketUrl)),
		tags: Array.isArray(m.tags) ? m.tags.map((t) => String(t)) : [],
		geohash: str(m.geohash),
		city: str(m.city),
		citySlug: str(m.citySlug),
		province: str(m.province),
		region: str(m.region),
		source: (['manual', 'scraper', 'user'].includes(source) ? source : 'manual') as Event['source'],
		sourceUrl: safeUrl(str(m.sourceUrl)),
		approxLocation: m.approxLocation === true,
		locality: str(m.locality),
		cityAlt: str(m.cityAlt) || undefined,
		longRunning: m.longRunning === true || endMs - start > LONG_RUNNING_DAYS * 86_400_000,
		createdAt: m.createdAt == null ? undefined : num(m.createdAt),
		updatedAt: m.updatedAt == null ? undefined : num(m.updatedAt)
	};
}

/** Solo link http(s) assoluti; tutto il resto diventa stringa vuota. */
export function safeUrl(s: string): string {
	try {
		const u = new URL(s.trim());
		return (u.protocol === 'https:' || u.protocol === 'http:') && u.host ? u.href : '';
	} catch {
		return '';
	}
}

export const isFree = (e: Pick<Event, 'priceType'>) => e.priceType === 'free';
export const isForKids = (e: Pick<Event, 'category' | 'tags'>) =>
	e.category === 'kids' || e.tags.includes('kids') || e.tags.includes('family');

export function slugify(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 70)
		.replace(/-+$/, '');
}

/** /eventi/titolo-dell-evento-<id>: l'id sta dopo l'ultimo "-" (gli id Firestore non ne contengono). */
export const eventPath = (e: Pick<Event, 'id' | 'title'>) =>
	`/eventi/${slugify(e.title) || 'evento'}-${e.id}`;
export const idFromSlug = (slug: string) => slug.slice(slug.lastIndexOf('-') + 1);
export const cityPath = (citySlug: string) => `/citta/${citySlug}`;

/** Fonte da mostrare nel dettaglio: la fonte regionale Open Data Hub è citata col suo nome e la licenza dei dati (CC0). */
export function eventSource(e: Pick<Event, 'source' | 'sourceUrl'>): { text: string; href?: string } {
	if (e.source === 'user') return { text: 'Segnalato da un utente e verificato dalla redazione' };
	if (!e.sourceUrl) return { text: 'Redazione di Eventi Vicini' };
	const host = new URL(e.sourceUrl).hostname.replace(/^www\./, '');
	if (host === 'app.ticketmaster.com') return { text: 'Ticketmaster', href: 'https://www.ticketmaster.it/' };
	if (host === 'tourism.opendatahub.com') return { text: 'Open Data Hub Alto Adige / Südtirol (dati CC0)', href: 'https://opendatahub.com/' };
	const m = /^comune\.([a-z-]+)\./.exec(host);
	const name = m ? `Comune di ${m[1].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')}` : host;
	return { text: name, href: e.sourceUrl };
}

/** Venditore del link d'acquisto, se è uno di quelli che nominiamo (oggi Ticketmaster): ne dipendono etichetta e nota. */
export function ticketVendor(url: string): string | null {
	try {
		return /(^|\.)ticketmaster\.[a-z.]+$/.test(new URL(url).hostname) ? 'Ticketmaster' : null;
	} catch {
		return null;
	}
}

/** Biglietti fuori vendita (esauriti o non ancora in vendita): l'importer lo segna con il tag "offsale". */
export const ticketsOffSale = (e: Pick<Event, 'tags'>) => e.tags.includes('offsale');

export const ticketLabel = (url: string) => {
	const vendor = ticketVendor(url);
	return vendor ? `Acquista i biglietti su ${vendor}` : 'Biglietti';
};

/** "Live, outdoor , ,kids" → [live, outdoor, kids], minuscoli e senza doppioni (come parseTags in Dart). */
export const parseTags = (raw: string) => [
	...new Set(
		raw
			.split(',')
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean)
	)
];

export type EventErrors = Partial<Record<keyof EventInput | 'place', string>>;

/** Validazione del form: messaggi in italiano, vuoto = valido. Rispecchia le regole Firestore. */
export function validateEvent(e: EventInput): EventErrors {
	const err: EventErrors = {};
	const required = (k: 'title' | 'address', max: number) => {
		const v = e[k].trim();
		if (!v) err[k] = 'Campo obbligatorio';
		else if (v.length > max) err[k] = `Massimo ${max} caratteri`;
	};
	required('title', LIMITS.title);
	required('address', LIMITS.address);
	if (e.shortDescription.length > LIMITS.shortDescription)
		err.shortDescription = `Massimo ${LIMITS.shortDescription} caratteri`;
	if (e.venueName.length > LIMITS.venueName) err.venueName = `Massimo ${LIMITS.venueName} caratteri`;
	if (!(e.category in CATEGORIES)) err.category = 'Scegli una categoria';
	if (!(e.priceType in PRICE_TYPES)) err.priceType = 'Scegli un prezzo';
	if (!Number.isInteger(e.startTime) || e.startTime <= 0) err.startTime = 'Data di inizio non valida';
	if (!Number.isInteger(e.endTime) || e.endTime <= 0) err.endTime = 'Data di fine non valida';
	else if (e.endTime < e.startTime) err.endTime = "La fine deve essere dopo l'inizio";
	for (const k of ['imageUrl', 'ticketUrl'] as const) {
		const v = e[k].trim();
		if (v && (!safeUrl(v) || v.length > LIMITS.url)) err[k] = 'Inserisci un link che inizi con https://';
	}
	if (e.tags.length > LIMITS.tags) err.tags = `Massimo ${LIMITS.tags} tag`;
	else if (e.tags.some((t) => t.length > LIMITS.tag)) err.tags = `Ogni tag al massimo ${LIMITS.tag} caratteri`;
	const badCoords =
		!Number.isFinite(e.lat) ||
		!Number.isFinite(e.lng) ||
		(e.lat === 0 && e.lng === 0) ||
		Math.abs(e.lat) > 90 ||
		Math.abs(e.lng) > 180;
	if (badCoords || e.geohash.length < 5) err.place = 'Imposta la posizione: cerca l’indirizzo o sposta il segnaposto';
	else if (!e.city.trim() || !e.citySlug) err.place = 'Non riesco a capire il comune: sposta il segnaposto';
	return err;
}

/** Badge per mostre e eventi lunghi: "Mostra" o "In corso fino al 12 nov"; null se l'evento non è lungo. */
export function runningLabel(e: Pick<Event, 'longRunning' | 'category' | 'title' | 'tags' | 'endTime'>): string | null {
	if (!e.longRunning) return null;
	if (e.category === 'culture' && (/mostra/i.test(e.title) || e.tags.includes('mostra'))) return 'Mostra';
	return `In corso fino al ${shortDate(e.endTime)}`;
}

const dayKey = (ms: number) => {
	const p = romeParts(ms);
	return p.year * 10_000 + p.month * 100 + p.day;
};

/** Ordine delle liste: giorno (Roma) di max(inizio, adesso), a parità prima i puntuali poi i lunghi, poi inizio e titolo. */
export const compareEvents =
	(now: number) =>
	(a: Pick<Event, 'startTime' | 'longRunning' | 'title'>, b: typeof a): number =>
		dayKey(Math.max(a.startTime, now)) - dayKey(Math.max(b.startTime, now)) ||
		Number(a.longRunning) - Number(b.longRunning) ||
		a.startTime - b.startTime ||
		a.title.localeCompare(b.title, 'it');
