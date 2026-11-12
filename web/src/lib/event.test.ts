import { describe, expect, it } from 'vitest';
import { romeTime } from './dates';
import { PRICE_TYPES, compareEvents, eventSource, eventPath, fromData, runningLabel, idFromSlug, parseTags, safeUrl, slugify, ticketLabel, ticketVendor, ticketsOffSale, validateEvent, type EventInput } from './event';

const sample = (over: Partial<EventInput> = {}): EventInput => ({
	title: 'Concerto in piazza',
	shortDescription: '',
	category: 'music',
	priceType: 'free',
	startTime: 1_800_000_000_000,
	endTime: 1_800_003_600_000,
	venueName: 'Piazza Grande',
	address: 'Piazza Grande, Modena',
	lat: 44.6458,
	lng: 10.9256,
	imageUrl: '',
	ticketUrl: '',
	tags: [],
	geohash: 'srbj4w1t0q',
	city: 'Modena',
	citySlug: 'modena',
	province: 'MO',
	region: 'Emilia-Romagna',
	...over
});

describe('validateEvent', () => {
	it('evento completo valido', () => expect(validateEvent(sample())).toEqual({}));
	it.each([
		['title', { title: '  ' }, 'Campo obbligatorio'],
		['title', { title: 'x'.repeat(201) }, 'Massimo 200 caratteri'],
		['endTime', { endTime: 1_700_000_000_000 }, "La fine deve essere dopo l'inizio"],
		['ticketUrl', { ticketUrl: 'javascript:alert(1)' }, 'Inserisci un link che inizi con https://'],
		['imageUrl', { imageUrl: 'ftp://x.it/a.png' }, 'Inserisci un link che inizi con https://'],
		['tags', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, 'Massimo 10 tag']
	])('%s non valido', (field, over, msg) => {
		expect(validateEvent(sample(over as Partial<EventInput>))[field as keyof EventInput]).toBe(msg);
	});
	it('approxLocation: default false, true solo se booleano true', () => {
		expect(fromData('x', {}).approxLocation).toBe(false);
		expect(fromData('x', { approxLocation: 'true' }).approxLocation).toBe(false);
		expect(fromData('x', { approxLocation: true }).approxLocation).toBe(true);
	});
	it('coordinate mancanti o comune sconosciuto', () => {
		expect(validateEvent(sample({ lat: 0, lng: 0 })).place).toMatch(/posizione/);
		expect(validateEvent(sample({ geohash: '' })).place).toMatch(/posizione/);
		expect(validateEvent(sample({ city: '' })).place).toMatch(/comune/);
	});
});

describe('url e slug', () => {
	it('safeUrl accetta solo http(s)', () => {
		expect(safeUrl('https://a.it/x')).toBe('https://a.it/x');
		expect(safeUrl(' http://a.it ')).toBe('http://a.it/');
		expect(safeUrl('javascript:alert(1)')).toBe('');
		expect(safeUrl('data:text/html,x')).toBe('');
		expect(safeUrl('/relativo')).toBe('');
	});
	it('slugify toglie accenti e simboli', () => {
		expect(slugify("Sagra dell'Uva & Città Più Bella!")).toBe('sagra-dell-uva-citta-piu-bella');
		expect(slugify('Reggio nell’Emilia')).toBe('reggio-nell-emilia');
	});
	it('percorso evento e id', () => {
		const p = eventPath({ id: 'abc123XYZ', title: 'Festa di San Geminiano' });
		expect(p).toBe('/eventi/festa-di-san-geminiano-abc123XYZ');
		expect(idFromSlug(p.split('/')[2])).toBe('abc123XYZ');
	});
	it('parseTags', () => expect(parseTags('Live, outdoor , ,kids,live')).toEqual(['live', 'outdoor', 'kids']));
});

describe('fromData', () => {
	it('default come in Dart e campi interni ignorati', () => {
		const e = fromData('x', { title: 'T', startTime: 10, submittedBy: 'uid-segreto', ticketUrl: 'javascript:x' });
		expect(e).toMatchObject({ id: 'x', category: 'other', priceType: 'free', endTime: 10, source: 'manual', ticketUrl: '' });
		expect('submittedBy' in e).toBe(false);
	});
});

describe('longRunning e ordinamento', () => {
	const now = romeTime(2026, 10, 28, 12);
	const day = 86_400_000;
	const ev = (id: string, start: number, end: number, over: Record<string, unknown> = {}) =>
		fromData(id, { title: id, startTime: start, endTime: end, ...over });
	const order = (list: ReturnType<typeof ev>[]) => list.sort(compareEvents(now)).map((e) => e.id);

	it('longRunning dal flag o dalla durata', () => {
		expect(ev('a', now, now + 3600_000).longRunning).toBe(false);
		expect(ev('b', now, now + 3600_000, { longRunning: true }).longRunning).toBe(true);
		expect(ev('c', now, now + 15 * day).longRunning).toBe(true);
		expect(ev('d', now, now + 14 * day).longRunning).toBe(false);
	});
	it('mostra iniziata 3 settimane fa dopo il concerto di oggi', () => {
		const mostra = ev('mostra', now - 21 * day, now + 30 * day);
		const concerto = ev('concerto', romeTime(2026, 10, 28, 21), romeTime(2026, 10, 28, 23));
		expect(order([mostra, concerto])).toEqual(['concerto', 'mostra']);
	});
	it('stesso giorno: per inizio, poi titolo', () => {
		const a = ev('b', romeTime(2026, 10, 29, 20), romeTime(2026, 10, 29, 22));
		const b = ev('a', romeTime(2026, 10, 29, 20), romeTime(2026, 10, 29, 22));
		const c = ev('c', romeTime(2026, 10, 29, 18), romeTime(2026, 10, 29, 19));
		expect(order([a, b, c])).toEqual(['c', 'a', 'b']);
	});
	it('evento futuro lungo: per il suo giorno, non sempre in fondo', () => {
		const lungo = ev('lungo', romeTime(2026, 10, 30, 9), romeTime(2026, 12, 30, 9));
		const prima = ev('prima', romeTime(2026, 10, 29, 20), romeTime(2026, 10, 29, 22));
		const dopo = ev('dopo', romeTime(2026, 10, 30, 20), romeTime(2026, 10, 30, 22));
		expect(order([dopo, lungo, prima])).toEqual(['prima', 'dopo', 'lungo']);
	});
	it('runningLabel', () => {
		const end = romeTime(2026, 11, 12, 18);
		expect(runningLabel(ev('x', now, now + 2 * day))).toBeNull();
		expect(runningLabel(ev('x', now - 20 * day, end))).toBe('In corso fino al 12 nov');
		expect(runningLabel(ev('Mostra di foto', now - 20 * day, end, { category: 'culture' }))).toBe('Mostra');
		expect(runningLabel(ev('x', now - 20 * day, end, { category: 'culture', tags: ['mostra'] }))).toBe('Mostra');
	});
});

describe('PRICE_TYPES', () => {
	it('un prezzo sconosciuto non diventa "Gratis"', () => {
		expect(PRICE_TYPES.unknown).toBe('Prezzo sul sito');
		expect(fromData('x', { priceType: 'unknown' }).priceType).toBe('unknown');
	});
});

describe('ticketsOffSale', () => {
	it('riconosce i biglietti fuori vendita dal tag offsale', () => {
		expect(ticketsOffSale({ tags: ['offsale'] })).toBe(true);
		expect(ticketsOffSale({ tags: ['kids'] })).toBe(false);
		expect(ticketsOffSale({ tags: [] })).toBe(false);
	});
});

describe('ticketLabel', () => {
	it('nomina il venditore solo se è Ticketmaster', () => {
		expect(ticketLabel('https://www.ticketmaster.it/event/1')).toBe('Acquista i biglietti su Ticketmaster');
		expect(ticketVendor('https://www.ticketmaster.com/e/2')).toBe('Ticketmaster');
		expect(ticketLabel('https://www.eticketmaster.it.evil.example/x')).toBe('Biglietti');
		expect(ticketLabel('https://www.comune.modena.it/biglietti')).toBe('Biglietti');
		expect(ticketLabel('non un url')).toBe('Biglietti');
	});
});

describe('eventSource', () => {
	it('cita Open Data Hub col suo nome e la licenza dei dati', () => {
		expect(eventSource({ source: 'scraper', sourceUrl: 'https://tourism.opendatahub.com/v1/Event/ABC' })).toEqual({
			text: 'Open Data Hub Alto Adige / Südtirol',
			href: 'https://opendatahub.com/',
			license: { text: 'CC0', href: 'https://creativecommons.org/publicdomain/zero/1.0/deed.it' }
		});
	});

	it('cita Emilia Romagna Turismo col nome, il link all’evento e la licenza CC BY 4.0', () => {
		const url = 'https://emiliaromagnaturismo.it/it/eventi/cento-sagra-del-tartufo';
		expect(eventSource({ source: 'scraper', sourceUrl: url })).toEqual({
			text: 'Emilia Romagna Turismo',
			href: url,
			license: { text: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/deed.it' }
		});
	});

	it('cita Ticketmaster per i concerti importati dalla sua API', () => {
		expect(eventSource({ source: 'scraper', sourceUrl: 'https://app.ticketmaster.com/discovery/v2/events/G5v0Z' })).toEqual({
			text: 'Ticketmaster',
			href: 'https://www.ticketmaster.it/'
		});
	});

	it('i comuni restano Comune di …, le proposte e gli eventi senza fonte hanno la loro dicitura', () => {
		expect(eventSource({ source: 'scraper', sourceUrl: 'https://www.comune.san-giorgio.mo.it/e/1' }).text).toMatch(/^Comune di San/);
		expect(eventSource({ source: 'user', sourceUrl: '' }).text).toMatch(/utente/);
		expect(eventSource({ source: 'manual', sourceUrl: '' }).text).toBe('Redazione di Eventi Vicini');
	});
});
