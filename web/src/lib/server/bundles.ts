// Formato dei bundle scritti dall'importer (tools/importer/bundles.py): liste di eventi precalcolate per cella
// geohash di 4 caratteri e per città. FIELDS deve coincidere con bundles.py (lo controlla test_bundles.py).
import { fromData, type Event } from '$lib/event';
import { distanceKm, type LatLng } from '$lib/geo';
import { geohashForLocation } from 'geofire-common';

export const FIELDS = [
	'id', 'title', 'startTime', 'endTime', 'category', 'priceType', 'venueName', 'address', 'locality', 'city',
	'citySlug', 'cityAlt', 'province', 'region', 'lat', 'lng', 'imageUrl', 'tags', 'longRunning', 'approxLocation',
	'imageMiniUrl', 'imagePreviewUrl' // in coda: le righe dei bundle scritti prima sono più corte e danno campi vuoti
];

/** Una riga del bundle → Event (i campi che non servono a liste e mappa restano ai default). */
export function rowToEvent(row: unknown[]): Event {
	const [id, ...rest] = row;
	return fromData(String(id), Object.fromEntries(rest.map((v, i) => [FIELDS[i + 1], v])));
}

/** Righe di un bundle (possono essere divise in più documenti: si concatenano). */
export const parseRows = (parts: string[]): unknown[][] => parts.flatMap((p) => JSON.parse(p) as unknown[][]);

// Una cella di 4 caratteri ha 10 bit per asse: 180/1024° di latitudine, 360/1024° di longitudine.
const CELL_LAT = 180 / 1024;
const CELL_LNG = 360 / 1024;

/** Nomi dei bundle (g_<geohash4>) delle celle che toccano il cerchio. */
export function cellsAround(c: LatLng, km: number): string[] {
	const dLat = km / 111.2;
	const dLng = km / (111.2 * Math.max(Math.cos((c.lat * Math.PI) / 180), 0.01));
	const out: string[] = [];
	for (let i = Math.floor((c.lat - dLat + 90) / CELL_LAT); i <= Math.floor((c.lat + dLat + 90) / CELL_LAT); i++) {
		for (let j = Math.floor((c.lng - dLng + 180) / CELL_LNG); j <= Math.floor((c.lng + dLng + 180) / CELL_LNG); j++) {
			const south = i * CELL_LAT - 90;
			const west = j * CELL_LNG - 180;
			// punto della cella più vicino al centro: se è oltre il raggio, la cella non ha eventi utili
			const near = {
				lat: Math.min(Math.max(c.lat, south), south + CELL_LAT),
				lng: Math.min(Math.max(c.lng, west), west + CELL_LNG)
			};
			if (distanceKm(c, near) <= km) out.push(`g_${geohashForLocation([south + CELL_LAT / 2, west + CELL_LNG / 2], 4)}`);
		}
	}
	return out;
}
