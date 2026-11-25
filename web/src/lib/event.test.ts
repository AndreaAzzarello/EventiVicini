import { describe, expect, it } from 'vitest';
import { romeTime } from './dates';
import { PRICE_TYPES, compareEvents, linkKey, normalizeLink, validateSourceLink, eventSource, eventPath, fromData, runningLabel, idFromSlug, parseTags, safeImageUrl, safeUrl, slugify, ticketLabel, ticketVendor, ticketsOffSale, validateEvent, type EventInput } from './event';

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
		['ticketUrl', { ticketUrl: 'javascript:alert(1)' }, 'Inserisci un link che inizi con http:// o https://'],
		['imageUrl', { imageUrl: 'ftp://x.it/a.png' }, 'Inserisci un link che inizi con https://'],
		['imageUrl', { imageUrl: 'http://x.it/a.png' }, 'Inserisci un link che inizi con https://'],
		['imageUrl', { imageUrl: 'data:image/png;base64,AAA' }, 'Inserisci un link che inizi con https://'],
		['tags', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, 'Massimo 10 tag']
	])('%s non valido', (field, over, msg) => {
		expect(validateEvent(sample(over as Partial<EventInput>))[field as keyof EventInput]).toBe(msg);
	});
	it('immagine https valida; il link ai biglietti ammette anche http (collegamento in uscita)', () => {
		expect(validateEvent(sample({ imageUrl: 'https://x.it/a.png' }))).toEqual({});
		expect(validateEvent(sample({ ticketUrl: 'http://biglietti.it/x' }))).toEqual({});
		expect(validateEvent(sample({ ticketUrl: 'https://biglietti.it/x' }))).toEqual({});
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
	it('safeUrl resta http(s) anche per i link in uscita: la CSP non li tocca e togliere «Fonte» perderebbe l’attribuzione', () => {
		expect(safeUrl('http://www.comune.x.it/eventi/1')).toBe('http://www.comune.x.it/eventi/1');
	});
	it('safeImageUrl: solo https, l’http viene portato a https, il resto sparisce', () => {
		expect(safeImageUrl('https://a.it/x.jpg')).toBe('https://a.it/x.jpg');
		expect(safeImageUrl(' http://a.it/x.jpg?w=1 ')).toBe('https://a.it/x.jpg?w=1');
		expect(safeImageUrl('HTTP://A.it/x.jpg')).toBe('https://a.it/x.jpg');
		expect(safeImageUrl('javascript:alert(1)')).toBe('');
		expect(safeImageUrl('data:image/png;base64,AAA')).toBe('');
		expect(safeImageUrl('ftp://a.it/x.jpg')).toBe('');
		expect(safeImageUrl('//cdn.a.it/x.jpg')).toBe('');
		expect(safeImageUrl('/relativo/x.jpg')).toBe('');
		expect(safeImageUrl('')).toBe('');
	});
	it('safeImageUrl: le virgolette nell’URL non escono dall’attributo (il parser le codifica)', () => {
		const u = safeImageUrl('http://example.org/x.jpg" onerror="alert(10)');
		expect(u.startsWith('https://example.org/x.jpg')).toBe(true);
		expect(u).not.toContain('"');
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
		expect(e).toMatchObject({ id: 'x', category: 'other', priceType: 'unknown', endTime: 10, source: 'manual', ticketUrl: '' });
		expect('submittedBy' in e).toBe(false);
	});
});

describe('fromData: immagini solo https, link invariati', () => {
	const raw = {
		title: 'T', startTime: 10,
		imageUrl: 'http://www.comune.x.it/.imaging/a.jpg',
		imageMiniUrl: 'http://www.comune.x.it/@@images/image-200-aaaa.jpeg',
		imagePreviewUrl: 'https://www.comune.x.it/@@images/image-400-bbbb.jpeg',
		ticketUrl: 'http://biglietti.it/x',
		sourceUrl: 'http://www.comune.x.it/eventi/1'
	};
	it('i tre campi immagine passano da http a https (anche per i dati già scritti)', () => {
		const e = fromData('x', raw);
		expect(e.imageUrl).toBe('https://www.comune.x.it/.imaging/a.jpg');
		expect(e.imageMiniUrl).toBe('https://www.comune.x.it/@@images/image-200-aaaa.jpeg');
		expect(e.imagePreviewUrl).toBe('https://www.comune.x.it/@@images/image-400-bbbb.jpeg');
	});
	it('ticketUrl e sourceUrl in http restano com’erano (sono link, non sottorisorse)', () => {
		const e = fromData('x', raw);
		expect(e.ticketUrl).toBe('http://biglietti.it/x');
		expect(e.sourceUrl).toBe('http://www.comune.x.it/eventi/1');
	});
	it('schemi ostili nelle immagini: vuoti (le scale restano undefined)', () => {
		const e = fromData('x', { ...raw, imageUrl: 'javascript:alert(6)', imageMiniUrl: 'data:text/html,x', imagePreviewUrl: 'ftp://x.it/p.jpg' });
		expect(e.imageUrl).toBe('');
		expect(e.imageMiniUrl).toBeUndefined();
		expect(e.imagePreviewUrl).toBeUndefined();
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
		expect(fromData('x', { priceType: 'strano' }).priceType).toBe('unknown'); // mai gratis per ripiego: il filtro «Gratis» resta affidabile
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
		expect(eventSource({ source: 'user', sourceUrl: '' }).text).toBe('Segnalato da un utente e approvato dalla redazione');
		expect(eventSource({ source: 'manual', sourceUrl: '' }).text).toBe('Redazione di Eventi Vicini');
	});
});

describe('eventSource: proposte degli utenti con link', () => {
	it('mostra l’host, il link e la nota «approvato», mai «verificato»', () => {
		const s = eventSource({ source: 'user', sourceUrl: 'https://www.instagram.com/p/AbC123/' });
		expect(s).toEqual({
			text: 'instagram.com',
			href: 'https://www.instagram.com/p/AbC123/',
			ugc: true,
			note: 'segnalato da un utente e approvato dalla redazione'
		});
		expect(JSON.stringify(s)).not.toMatch(/verificat/i);
	});

	it('un link non https o rovinato non diventa un href', () => {
		for (const sourceUrl of ['http://example.org/e', 'javascript:alert(1)', 'https://u:p@example.org/e'])
			expect(eventSource({ source: 'user', sourceUrl }).href).toBeUndefined();
	});
});

describe('normalizeLink', () => {
	it('accetta https, toglie gli spazi e porta l’host in minuscolo', () => {
		expect(normalizeLink('  https://WWW.Instagram.com/p/AbC123/?igsh=x  ')).toBe('https://www.instagram.com/p/AbC123/?igsh=x');
	});
	it.each(['http://example.org/e', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.org', '//example.org', 'example.org/e', '', 'https://', 'https://u:p@example.org/e', 'https://user@example.org/'])(
		'rifiuta %s',
		(s) => expect(normalizeLink(s)).toBeNull()
	);
});

describe('linkKey', () => {
	it('riconosce lo stesso link scritto in modi diversi', () => {
		const k = linkKey('https://www.instagram.com/p/AbC123/');
		expect(k).toBe('instagram.com/p/AbC123');
		expect(linkKey('https://instagram.com/p/AbC123?igsh=1#x')).toBe(k);
		expect(linkKey('https://INSTAGRAM.com/p/AbC123/')).toBe(k);
	});
	it('link diversi hanno chiavi diverse; un link non valido non ha chiave', () => {
		expect(linkKey('https://instagram.com/p/AAA')).not.toBe(linkKey('https://instagram.com/p/BBB'));
		expect(linkKey('http://instagram.com/p/AAA')).toBe('');
	});
});

describe('validateSourceLink', () => {
	it('vuoto: ammesso se facoltativo, obbligatorio altrimenti', () => {
		expect(validateSourceLink('  ', false)).toBeUndefined();
		expect(validateSourceLink('', true)).toBe('Campo obbligatorio');
	});
	it('solo https', () => {
		expect(validateSourceLink('https://example.org/post', true)).toBeUndefined();
		expect(validateSourceLink('http://example.org/post', true)).toBe('Inserisci un link che inizi con https://');
		expect(validateSourceLink('javascript:alert(1)', false)).toBe('Inserisci un link che inizi con https://');
	});
	it('massimo 500 caratteri, misurati sul link normalizzato', () => {
		const at = (n: number) => `https://example.org/${'a'.repeat(n - 'https://example.org/'.length)}`;
		expect(validateSourceLink(at(500), true)).toBeUndefined();
		expect(validateSourceLink(at(501), true)).toBe('Massimo 500 caratteri');
	});
});
