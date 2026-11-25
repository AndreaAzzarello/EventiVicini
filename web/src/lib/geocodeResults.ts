// Risposta di Nominatim → risultati che l'utente sa distinguere. Puro: lo usa /api/geocode (nel Worker, al massimo 5 elementi) e i test.
import { fold } from './comuni';
import { distanceKm, placeFromNominatim, type Place } from './geo';

export interface Hit {
	lat: string;
	lon: string;
	name?: string;
	display_name: string;
	addresstype?: string;
	place_rank?: number;
	address?: Record<string, string>;
}

export interface Shaped {
	label: string;
	/** Dettaglio che distingue risultati con lo stesso nome: tipo di luogo, comune, provincia, CAP. */
	detail: string;
	lat: number;
	lng: number;
	place: Place | null;
}

/** Sotto questo `place_rank` (16 = comune) c'è un'area più grande: provincia (12), regione (8), stato (4). Non colloca un evento. */
const MIN_RANK = 16;
/** Due risultati con la stessa etichetta e dettaglio entro questa distanza sono lo stesso luogo (confine e nodo del paese stanno entro ~1 km). */
export const DUPLICATE_KM = 1;

const TOWN = new Set(['city', 'town', 'village', 'municipality']);
const SUBURB = new Set(['hamlet', 'suburb', 'neighbourhood', 'quarter', 'isolated_dwelling', 'locality', 'city_district', 'borough', 'farm']);

type Kind = 'comune' | 'frazione' | 'via' | 'luogo';
const kindOf = (h: Hit): Kind => {
	const t = h.addresstype ?? '';
	if (TOWN.has(t)) return 'comune';
	if (SUBURB.has(t)) return 'frazione';
	if (t === 'road' || t === 'house' || t === 'building' || h.address?.house_number || (h.address?.road && !h.name)) return 'via';
	return 'luogo';
};

/** «village» o «town» che cade dentro un altro comune (Cittanova in Modena) per l'utente è una frazione di quel comune. */
const effectiveKind = (h: Hit, place: Place | null): Kind => {
	const k = kindOf(h);
	return k === 'comune' && place && fold(h.name || '') !== fold(place.city) ? 'frazione' : k;
};

const where = (place: Place | null, postcode?: string) =>
	place ? `${place.city}${place.province ? ` (${place.province})` : ''}${postcode ? ` ${postcode}` : ''}` : (postcode ?? '');

function describe(h: Hit, place: Place | null): { label: string; detail: string } {
	const a = h.address ?? {};
	const name = (h.name || '').trim();
	const kind = effectiveKind(h, place);
	const sameTown = !!place && fold(name) === fold(place.city);
	if (kind === 'comune' && (sameTown || !place)) {
		const base = name || place?.city || h.display_name.split(', ')[0];
		return { label: place?.province ? `${base} (${place.province})` : base, detail: 'comune' };
	}
	if (kind === 'frazione') return { label: name || a.hamlet || a.suburb || h.display_name.split(', ')[0], detail: `frazione di ${where(place)}`.trim() };
	if (kind === 'via' || (a.road && !name)) {
		const street = [a.road ?? name, a.house_number].filter(Boolean).join(' ');
		return { label: street || h.display_name.split(', ')[0], detail: where(place, a.postcode) };
	}
	// Luogo o comune dal nome diverso da quello in cui cade il punto (es. «Modena» che sta a Campogalliano): il nome vero e, sotto, dove si trova davvero.
	const label = name || h.display_name.split(', ')[0];
	const road = a.road ? [a.road, a.house_number].filter(Boolean).join(' ') : '';
	return { label, detail: [road, place ? (sameTown ? where(place, a.postcode) : `in ${where(place, a.postcode)}`) : ''].filter(Boolean).join(', ') };
}

const rankOf = (h: Hit) => h.place_rank ?? 0;

/** Seconda riga dei risultati della home: provincia (sigla) e regione, per distinguere i comuni omonimi. */
const provinceLine = (place: Place) => [place.province && `Prov. ${place.province}`, place.region].filter(Boolean).join(' · ');

/**
 * - `address`: scarta le aree più ampie di un comune (non possono collocare l'evento) e dà a ogni risultato etichetta + dettaglio.
 * - `city` (home): scarta le aree più ampie di un comune (la provincia «Modena, Emilia-Romagna, Italia» spostava la mappa sul suo
 *   centroide); l'etichetta è «Comune (PR)» e il dettaglio «Prov. PR · Regione».
 * - `reverse` (da coordinate): un solo risultato, etichetta «Comune (PR)», senza filtri né dettaglio.
 * Poi toglie i duplicati (stessa etichetta e dettaglio entro 1 km: resta il più specifico) e mette per primo il comune
 * che si chiama come il testo cercato, poi gli altri centri abitati, poi vie e luoghi (a parità, l'ordine di Nominatim).
 */
export function shapeResults(hits: Hit[], kind: 'city' | 'address' | 'reverse', query: string): Shaped[] {
	const q = fold(query.trim());
	const shaped = hits
		.filter((h) => kind === 'reverse' || h.place_rank === undefined || h.place_rank >= MIN_RANK)
		.map((h, order) => {
			const place = placeFromNominatim(h.address);
			const text =
				kind !== 'address' && place
					? { label: place.province ? `${place.city} (${place.province})` : place.city, detail: kind === 'city' ? provinceLine(place) : '' }
					: kind !== 'address'
						? { label: h.display_name.split(', ').slice(0, 4).join(', '), detail: '' }
						: describe(h, place);
			const k = effectiveKind(h, place);
			const rank = k === 'comune' && fold(h.name || place?.city || '') === q ? 0 : k === 'comune' || k === 'frazione' ? 1 : 2;
			return { hit: h, order, rank, shaped: { ...text, lat: Number(h.lat), lng: Number(h.lon), place } satisfies Shaped };
		});
	const kept: typeof shaped = [];
	for (const s of shaped) {
		const twin = kept.findIndex(
			(o) => fold(o.shaped.label) === fold(s.shaped.label) && fold(o.shaped.detail) === fold(s.shaped.detail) && distanceKm(o.shaped, s.shaped) < DUPLICATE_KM
		);
		if (twin < 0) kept.push(s);
		else if (rankOf(s.hit) > rankOf(kept[twin].hit)) kept[twin] = { ...s, order: kept[twin].order, rank: Math.min(s.rank, kept[twin].rank) };
	}
	return kept.sort((a, b) => a.rank - b.rank || a.order - b.order).map((s) => s.shaped);
}
