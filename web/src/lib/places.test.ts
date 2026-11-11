import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER } from './filters';
import {
	autoRadius,
	fold,
	homeUrl,
	nearCovered,
	nearestComune,
	nearestEventsKm,
	nearestWithEvents,
	placeFromEvents,
	placeFromParams,
	placeToParams,
	popularPlaces,
	rankPlaces,
	regionCenter,
	regionsWithEvents,
	strongPlace,
	type CoverageRegion
} from './places';

const REGIONS: CoverageRegion[] = [
	{
		slug: 'emilia-romagna',
		name: 'Emilia-Romagna',
		comuni: [
			{ name: 'Modena', slug: 'modena', province: 'MO', lat: 44.6458, lng: 10.9256, events: 30 },
			{ name: 'Bologna', slug: 'bologna', province: 'BO', lat: 44.4939, lng: 11.3428, events: 10 },
			{ name: "Reggio nell'Emilia", slug: 'reggio-nell-emilia', province: 'RE', lat: 44.698, lng: 10.63, events: 5 },
			{ name: 'Forlì', slug: 'forli', province: 'FC', lat: 44.22, lng: 12.04, events: 0 }
		]
	},
	{
		slug: 'trentino-alto-adige',
		name: 'Trentino-Alto Adige',
		comuni: [
			{ name: 'Bolzano', slug: 'bolzano', alt: 'Bozen', province: 'BZ', lat: 46.4983, lng: 11.3548, events: 4 },
			{ name: 'Trento', slug: 'trento', province: 'TN', lat: 46.0679, lng: 11.1211, events: 0 }
		]
	}
];
const labels = (q: string) => rankPlaces(q, REGIONS).map((h) => h.place.label);

describe('fold', () => {
	it('toglie accenti, maiuscole, apostrofi e trattini', () => {
		expect(fold('Forlì')).toBe('forli');
		expect(fold("Reggio nell'Emilia")).toBe('reggio nell emilia');
		expect(fold('Reggio nell’Emilia')).toBe('reggio nell emilia');
		expect(fold('  Emilia-Romagna ')).toBe('emilia romagna');
	});
});

describe('rankPlaces', () => {
	it('non cerca sotto i due caratteri', () => expect(labels('b')).toEqual([]));
	it('è tollerante ad accenti e maiuscole', () => expect(labels('FORLI')).toEqual(['Forlì']));
	it('trova il nome bilingue: Bozen → Bolzano', () => {
		const [hit] = rankPlaces('bozen', REGIONS);
		expect(hit.place).toMatchObject({ label: 'Bolzano', slug: 'bolzano', region: 'Trentino-Alto Adige' });
		expect(hit.detail).toContain('Bozen');
	});
	it('gestisce gli apostrofi in entrambe le direzioni', () => {
		expect(labels("nell'emilia")).toContain("Reggio nell'Emilia");
		expect(labels('nell emilia')).toContain("Reggio nell'Emilia");
	});
	it('ordina: esatto, prefisso, contenuto; a parità più eventi', () => {
		expect(labels('emilia')[0]).toBe('Emilia-Romagna'); // prefisso batte il contenuto di "Reggio nell'Emilia"
		expect(labels('bo')).toEqual(['Bologna', 'Bolzano']); // stesso score: più eventi prima
		expect(labels('modena')[0]).toBe('Modena');
	});
	it('a pari punteggio il comune precede la regione', () => {
		const regions: CoverageRegion[] = [{ slug: 'lazio', name: 'Lazio', comuni: [{ name: 'Lazio', slug: 'lazio-c', province: '', lat: 41, lng: 12, events: 1 }] }];
		expect(rankPlaces('lazio', regions).map((h) => h.kind)).toEqual(['comune', 'regione']);
	});
	it('rispetta il limite', () => expect(rankPlaces('an', REGIONS, 1)).toHaveLength(1));
});

describe('strongPlace e popularPlaces', () => {
	it('strongPlace solo per esatto o prefisso', () => {
		expect(strongPlace('Bolzano', REGIONS)?.place.slug).toBe('bolzano');
		expect(strongPlace('olzan', REGIONS)).toBeNull(); // contenuto, non prefisso
		expect(strongPlace('concerto', REGIONS)).toBeNull();
	});
	it('popularPlaces ordina per eventi', () => {
		expect(popularPlaces(REGIONS, 2).map((h) => h.place.label)).toEqual(['Modena', 'Bologna']);
	});
});

describe('regionCenter e nearCovered', () => {
	it('regionCenter pesa sugli eventi e non si divide per zero', () => {
		const c = regionCenter(REGIONS[0]);
		expect(c.lat).toBeCloseTo(44.6, 0);
		expect(c.lng).toBeLessThan(11); // più vicino a Modena (30 eventi) che a Bologna
		const empty = regionCenter({ slug: 'x', name: 'X', comuni: [{ ...REGIONS[0].comuni[3] }, { ...REGIONS[0].comuni[3], lng: 14.04 }] });
		expect(empty.lng).toBeCloseTo(13.04, 1);
	});
	it('nearCovered ignora i comuni senza eventi', () => {
		expect(nearCovered({ lat: 44.65, lng: 10.93 }, REGIONS)).toBe(true);
		expect(nearCovered({ lat: 44.22, lng: 12.04 }, REGIONS)).toBe(false); // Forlì ha 0 eventi
		expect(nearCovered({ lat: 40.35, lng: 18.17 }, REGIONS)).toBe(false);
	});
});

describe('nearestComune', () => {
	it('sceglie il comune coperto più vicino entro 30 km', () => {
		expect(nearestComune({ lat: 44.6, lng: 10.9 }, REGIONS)).toMatchObject({ slug: 'modena', label: 'Modena' });
		expect(nearestComune({ lat: 44.5, lng: 11.3 }, REGIONS)?.slug).toBe('bologna');
	});
	it('niente oltre il raggio: nessun comune, nessun parametro', () => {
		expect(nearestComune({ lat: 40.35, lng: 18.17 }, REGIONS)).toBeNull(); // Lecce non è coperta
		expect(nearestComune({ lat: 44.9, lng: 10.0 }, REGIONS, 30)).toBeNull();
		expect(nearestComune({ lat: 44.6, lng: 10.9 }, [])).toBeNull();
	});
});

describe('luogo nell’URL', () => {
	const parse = (qs: string) => placeFromParams(new URLSearchParams(qs), REGIONS);
	it('risolve comuni e regioni coperti per slug', () => {
		expect(parse('luogo=bolzano')).toMatchObject({ label: 'Bolzano', slug: 'bolzano' });
		expect(parse('luogo=emilia-romagna')).toMatchObject({ label: 'Emilia-Romagna', slug: 'emilia-romagna' });
		expect(parse('luogo=sconosciuto')).toBeNull();
		expect(parse('luogo=../etc')).toBeNull();
	});
	it('accetta coordinate italiane e rifiuta il resto', () => {
		expect(parse('nome=Lecce&lat=40.35&lng=18.17')).toEqual({ lat: 40.35, lng: 18.17, label: 'Lecce' });
		expect(parse('lat=40.35&lng=18.17')?.label).toBe('La tua posizione');
		expect(parse('lat=0&lng=0')).toBeNull();
		expect(parse('lat=abc&lng=10')).toBeNull();
		expect(parse('lat=44')).toBeNull();
		expect(parse('')).toBeNull();
	});
	it('taglia il nome a 80 caratteri', () => expect(parse(`nome=${'a'.repeat(200)}&lat=44&lng=11`)?.label).toHaveLength(80));
	it('andata e ritorno', () => {
		const bz = parse('luogo=bolzano')!;
		expect(placeToParams(bz).toString()).toBe('luogo=bolzano');
		const free = { lat: 40.3529, lng: 18.1743, label: 'Lecce' };
		expect(placeToParams(free).toString()).toBe('nome=Lecce&lat=40.35&lng=18.17');
	});
	it('la posizione del dispositivo non mette mai le coordinate nell’URL', () => {
		const exact = { lat: 44.60123, lng: 10.90456, label: 'La tua posizione', exact: true };
		expect(placeToParams(exact).toString()).toBe('');
		expect(homeUrl(EMPTY_FILTER, exact)).toBe('/');
		// con un comune coperto vicino resta solo lo slug
		const withComune = { ...exact, label: 'Vicino a Modena', slug: 'modena' };
		expect(homeUrl(EMPTY_FILTER, withComune)).toBe('/?luogo=modena');
		expect(homeUrl(EMPTY_FILTER, withComune)).not.toMatch(/44\.6|10\.9|lat=|lng=/);
	});
	it('homeUrl unisce luogo, filtri e vista', () => {
		expect(homeUrl(EMPTY_FILTER, null)).toBe('/');
		const bz = parse('luogo=bolzano')!;
		expect(homeUrl({ ...EMPTY_FILTER, q: 'mercatino', radiusKm: 50 }, bz, 'map')).toBe('/?luogo=bolzano&q=mercatino&r=50&vista=mappa');
	});
});

describe('placeFromEvents', () => {
	const ev = (lat: number, lng: number, extra = {}) => ({ city: 'Lecce', region: 'Puglia', lat, lng, ...extra });
	it('centro medio dei punti attendibili, con nome e slug della città', () => {
		const p = placeFromEvents('lecce', [ev(40.3, 18.1), ev(40.4, 18.2), ev(41.9, 12.5, { approxLocation: true })]);
		expect(p).toMatchObject({ label: 'Lecce', slug: 'lecce', region: 'Puglia' });
		expect(p!.lat).toBeCloseTo(40.35);
		expect(p!.lng).toBeCloseTo(18.15);
	});
	it('senza eventi o con coordinate fuori Italia nessun luogo', () => {
		expect(placeFromEvents('lecce', [])).toBeNull();
		expect(placeFromEvents('lecce', [ev(0, 0)])).toBeNull();
	});
});

describe('raggio automatico', () => {
	const modena = { lat: 44.6458, lng: 10.9256 };
	const parma = { lat: 44.9, lng: 9.7 }; // ~75 km dal comune con eventi più vicino
	const pavullo = { lat: 44.33, lng: 10.84 }; // ~35 km da Modena
	const lontano = { lat: 46.5, lng: 8.0 }; // oltre 100 km da ogni comune con eventi
	it('comuni con eventi dal più vicino', () => {
		expect(nearestWithEvents(pavullo, REGIONS, 2).map((p) => [p.label, p.slug])).toEqual([
			['Modena', 'modena'],
			['Bologna', 'bologna']
		]);
		expect(nearestWithEvents(modena, REGIONS, 1)[0].km).toBe(0);
		expect(nearestWithEvents(modena, REGIONS).every((p) => p.label !== 'Forlì')).toBe(true); // Forlì non ha eventi
	});
	it('resta 25 km dove ci sono eventi vicini', () => {
		expect(autoRadius(modena, REGIONS)).toEqual({ radiusKm: 25, quiet: false });
	});
	it('allarga al più piccolo raggio che arriva a un comune con eventi', () => {
		expect(autoRadius(pavullo, REGIONS)).toEqual({ radiusKm: 50, quiet: true });
		expect(autoRadius(parma, REGIONS)).toEqual({ radiusKm: 100, quiet: true });
	});
	it('senza eventi nemmeno a 100 km resta 25 e segnala la quiete', () => {
		expect(autoRadius(lontano, REGIONS)).toEqual({ radiusKm: 25, quiet: true });
	});
	it('senza copertura non inventa nulla', () => {
		expect(autoRadius(modena, [])).toEqual({ radiusKm: 25, quiet: false });
	});
});

describe('stima veloce della distanza dal comune con eventi più vicino', () => {
	it('dà lo stesso numero di nearestWithEvents su una griglia di punti in tutta Italia', () => {
		// copertura sintetica ma sparsa come quella reale: ~700 comuni con eventi, altri senza
		const comuni = Array.from({ length: 1100 }, (_, i) => ({
			name: `C${i}`,
			slug: `c${i}`,
			province: 'XX',
			lat: 36.6 + ((i * 7919) % 1000) / 1000 * 10.4,
			lng: 6.7 + ((i * 104729) % 1000) / 1000 * 11.8,
			events: i % 3 ? i % 7 : 0
		}));
		const regions: CoverageRegion[] = [{ slug: 'x', name: 'X', comuni }];
		for (let lat = 36.5; lat <= 47.2; lat += 0.7)
			for (let lng = 6.5; lng <= 18.6; lng += 0.9) {
				const slow = nearestWithEvents({ lat, lng }, regions, 1)[0]?.km ?? null;
				expect(nearestEventsKm({ lat, lng }, regions), `${lat},${lng}`).toBe(slow);
			}
		expect(nearestEventsKm({ lat: 44, lng: 11 }, [])).toBeNull();
		expect(nearestEventsKm({ lat: 44, lng: 11 }, [{ slug: 'x', name: 'X', comuni: comuni.map((c) => ({ ...c, events: 0 })) }])).toBeNull();
	});
});

describe('memoizzazione per identità della copertura', () => {
	it('nearestEventsKm: stesso valore alla seconda chiamata e con copertura diversa ricalcola', () => {
		const p = { lat: 44.33, lng: 10.84 };
		const a = nearestEventsKm(p, REGIONS);
		expect(nearestEventsKm(p, REGIONS)).toBe(a);
		expect(nearestEventsKm(p, [])).toBeNull();
	});
	it('popularPlaces restituisce lo stesso risultato senza rifare il lavoro, e uno nuovo se cambia l’array', () => {
		const a = popularPlaces(REGIONS, 3);
		expect(popularPlaces(REGIONS, 3)).toBe(a);
		expect(popularPlaces(REGIONS, 2)).not.toBe(a);
		expect(a.map((h) => h.place.label)).toEqual(['Modena', 'Bologna', "Reggio nell'Emilia"]);
		expect(popularPlaces([...REGIONS], 3)).not.toBe(a);
	});
	it('con pochi comuni con eventi completa l’elenco come prima (anche quelli a zero, per nome)', () => {
		const out = popularPlaces(REGIONS, 6).map((h) => [h.place.label, h.events]);
		expect(out).toEqual([['Modena', 30], ['Bologna', 10], ["Reggio nell'Emilia", 5], ['Bolzano', 4], ['Forlì', 0], ['Trento', 0]]);
	});
	it('regionsWithEvents: totali, ordine e solo regioni con eventi', () => {
		const r = regionsWithEvents(REGIONS);
		expect(r).toEqual([
			{ slug: 'emilia-romagna', name: 'Emilia-Romagna', events: 45 },
			{ slug: 'trentino-alto-adige', name: 'Trentino-Alto Adige', events: 4 }
		]);
		expect(regionsWithEvents(REGIONS)).toBe(r);
	});
});
