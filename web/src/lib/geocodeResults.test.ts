import { describe, expect, it } from 'vitest';
import { DUPLICATE_KM, shapeResults, type Hit } from './geocodeResults';

// Risposte reali di Nominatim (search, jsonv2, addressdetails=1, accept-language=it, countrycodes=it) del 24/11/2026, accorciate.
const IT = { country: 'Italia', country_code: 'it' };
const MO = { county: 'Modena', 'ISO3166-2-lvl6': 'IT-MO', state: 'Emilia-Romagna', ...IT };
/** «modena»: la provincia (rank 12, senza comune) e il comune (rank 16). Prima: due righe «Modena, Emilia-Romagna, Italia». */
const MODENA: Hit[] = [
	{ lat: '44.5384728', lon: '10.9359609', name: 'Modena', display_name: 'Modena, Emilia-Romagna, Italia', addresstype: 'county', place_rank: 12, address: { ...MO } },
	{ lat: '44.6458885', lon: '10.9255707', name: 'Modena', display_name: 'Modena, Emilia-Romagna, Italia', addresstype: 'city', place_rank: 16, address: { city: 'Modena', ...MO } }
];
const VIA: Hit = {
	lat: '44.64594', lon: '10.92745', name: '', display_name: '100, Via Emilia Centro, Quartiere Albareto, Cittadella, Centro storico, Modena, Emilia-Romagna, 41121, Italia',
	addresstype: 'place', place_rank: 30, address: { house_number: '100', road: 'Via Emilia Centro', neighbourhood: 'Quartiere Albareto', suburb: 'Cittadella', city: 'Modena', postcode: '41121', ...MO }
};
/** «cittanova modena»: il paese (village) e il quartiere con lo stesso nome a ~0,7 km, più una strada con quel nome. */
const CITTANOVA: Hit[] = [
	{ lat: '44.6464', lon: '10.84302', name: 'Cittanova', display_name: 'Cittanova, Modena, Emilia-Romagna, 41011, Italia', addresstype: 'village', place_rank: 19, address: { village: 'Cittanova', city: 'Modena', postcode: '41011', ...MO } },
	{ lat: '44.64113', lon: '10.83686', name: 'Cittanova', display_name: 'Cittanova, San Faustino-Madonnina-Quattroville, Cittanova, Modena, Emilia-Romagna, Italia', addresstype: 'neighbourhood', place_rank: 22, address: { neighbourhood: 'Cittanova', suburb: 'San Faustino-Madonnina-Quattroville', village: 'Cittanova', city: 'Modena', ...MO } },
	{ lat: '44.64717', lon: '10.84368', name: 'Cittanova', display_name: 'Cittanova, Strada Pomposiana, Cittanova, Modena, Emilia-Romagna, Italia', addresstype: 'highway', place_rank: 30, address: { highway: 'Cittanova', road: 'Strada Pomposiana', village: 'Cittanova', city: 'Modena', postcode: '41011', ...MO } }
];

describe('shapeResults: indirizzo', () => {
	it('«modena»: la provincia non è un risultato, resta il comune con provincia e tipo', () => {
		const r = shapeResults(MODENA, 'address', 'modena');
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({ label: 'Modena (MO)', detail: 'comune', lat: 44.6458885 });
		expect(r[0].place?.city).toBe('Modena');
	});
	it('via con civico: strada e numero, poi comune, provincia e CAP', () => {
		expect(shapeResults([VIA], 'address', 'via emilia centro 100 modena')[0]).toMatchObject({ label: 'Via Emilia Centro 100', detail: 'Modena (MO) 41121' });
	});
	it('stesso nome entro 1 km: un solo risultato, il più specifico; la frazione si presenta come tale', () => {
		const r = shapeResults(CITTANOVA, 'address', 'cittanova modena');
		expect(r.map((x) => `${x.label} | ${x.detail}`)).toEqual(['Cittanova | frazione di Modena (MO)', 'Cittanova | Strada Pomposiana, in Modena (MO) 41011']);
		expect(r[0].lat).toBeCloseTo(44.64113, 4); // dei due duplicati resta il quartiere (rank 22 > 19)
	});
	it('gli omonimi lontani restano distinti: stesso nome, comuni diversi', () => {
		const altro: Hit = { ...CITTANOVA[0], lat: '38.36', lon: '16.08', display_name: 'Cittanova, Reggio Calabria', address: { town: 'Cittanova', 'ISO3166-2-lvl6': 'IT-RC', state: 'Calabria', ...IT }, addresstype: 'town' };
		const r = shapeResults([CITTANOVA[0], altro], 'address', 'cittanova');
		expect(r.map((x) => x.detail)).toEqual(['comune', 'frazione di Modena (MO)']); // il comune che si chiama come il testo viene prima della frazione
		expect(r[0].label).toBe('Cittanova (RC)');
	});
	it('duplicato a 400 m: uno solo; a oltre 1 km: due', () => {
		const near: Hit = { ...MODENA[1], lat: '44.6495', lon: '10.9256', place_rank: 18 }; // ~400 m a nord
		expect(shapeResults([MODENA[1], near], 'address', 'modena')).toHaveLength(1);
		const far: Hit = { ...MODENA[1], lat: '44.66', lon: '10.9256' }; // ~1,6 km
		expect(shapeResults([MODENA[1], far], 'address', 'modena')).toHaveLength(2);
		expect(DUPLICATE_KM).toBe(1);
	});
	it('un nome diverso dal comune in cui cade il punto: nome vero e comune vero', () => {
		const strano: Hit = { lat: '44.69', lon: '10.99', name: 'Modena Nord', display_name: 'Modena Nord, Campogalliano', addresstype: 'amenity', place_rank: 25, address: { town: 'Campogalliano', 'ISO3166-2-lvl6': 'IT-MO', state: 'Emilia-Romagna', ...IT } };
		expect(shapeResults([strano], 'address', 'modena')[0]).toMatchObject({ label: 'Modena Nord', detail: 'in Campogalliano (MO)' });
	});
	it('ordine: il comune che si chiama come il testo, poi frazioni, poi vie e luoghi', () => {
		const r = shapeResults([VIA, CITTANOVA[1], MODENA[1]], 'address', 'modena');
		expect(r.map((x) => x.label)).toEqual(['Modena (MO)', 'Cittanova', 'Via Emilia Centro 100']);
	});
	it('senza risultati più specifici di un comune: nessun risultato', () => {
		expect(shapeResults([MODENA[0]], 'address', 'modena')).toEqual([]);
	});
});

describe('shapeResults: città (home)', () => {
	it('etichetta «Comune (PR)» come prima, senza scartare nulla; il comune per primo', () => {
		const r = shapeResults(MODENA, 'city', 'modena');
		// come prima non si scarta nulla (la provincia, senza comune nell'indirizzo, ha l'etichetta di display_name); il comune viene per primo
		expect(r.map((x) => x.label)).toEqual(['Modena (MO)', 'Modena, Emilia-Romagna, Italia']);
	});
});
