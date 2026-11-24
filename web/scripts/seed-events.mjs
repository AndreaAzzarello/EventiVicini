// Eventi di prova dell'emulatore (solo sviluppo e test), puri: `now` si inietta, così i test provano ogni giorno della settimana.
// Usato da seed-emulator.mjs e da src/lib/seed.test.ts.
import { geohashForLocation } from 'geofire-common';

export const H = 3600_000;

/** @param {number} now */
export function makeAt(now) {
	const day0 = new Date(now);
	day0.setHours(0, 0, 0, 0);
	return (/** @type {number} */ days, /** @type {number} */ hour) => day0.getTime() + days * 24 * H + hour * H;
}

export const places = {
	modena: { city: 'Modena', citySlug: 'modena', province: 'MO', region: 'Emilia-Romagna', lat: 44.6458, lng: 10.9256 },
	formigine: { city: 'Formigine', citySlug: 'formigine', province: 'MO', region: 'Emilia-Romagna', lat: 44.5733, lng: 10.8466 },
	bologna: { city: 'Bologna', citySlug: 'bologna', province: 'BO', region: 'Emilia-Romagna', lat: 44.4939, lng: 11.3428 },
	// Città con eventi ma senza riga attiva nel registro CSV (come Bolzano da Open Data Hub): la copertura la ricava dagli eventi
	cesena: { city: 'Cesena', citySlug: 'cesena', province: 'FC', region: 'Emilia-Romagna', lat: 44.1391, lng: 12.2431 },
	roma: { city: 'Roma', citySlug: 'roma', province: 'RM', region: 'Lazio', lat: 41.8986, lng: 12.4769 },
	lecce: { city: 'Lecce', citySlug: 'lecce', province: 'LE', region: 'Puglia', lat: 40.3529, lng: 18.1743 },
	// Comuni bilingui: city col nome ufficiale italiano, alias in cityAlt (come scrive l'importer)
	bolzano: { city: 'Bolzano', citySlug: 'bolzano', cityAlt: 'Bozen', province: 'BZ', region: 'Trentino-Alto Adige', lat: 46.4983, lng: 11.3548 },
	aosta: { city: 'Aosta', citySlug: 'aosta', cityAlt: 'Aoste', province: 'AO', region: "Valle d'Aosta", lat: 45.7375, lng: 7.3203 }
};
places.torino = { city: 'Torino', citySlug: 'torino', province: 'TO', region: 'Piemonte', lat: 45.0703, lng: 7.6869 };

/**
 * @param {number} now
 * @param {{ xss?: boolean, big?: boolean, bench?: boolean }} [opts]
 * @returns {{ id: string, data: Record<string, any> }[]}
 */
export function seedEvents(now, { xss = false, big = false, bench = false } = {}) {
	const at = makeAt(now);
	const weekday = new Date(at(0, 0)).getDay(); // 0 = domenica
	/** Giorni da oggi al prossimo giorno della settimana dato (0 se è oggi). */
	const until = (/** @type {number} */ dow) => (dow - weekday + 7) % 7;
	/** Un evento di oggi che risulta sempre in corso (come seedJazz): i test non dipendono dall'ora in cui girano. */
	const running = (/** @type {number} */ d, /** @type {number} */ h1, /** @type {number} */ h2) =>
		d === 0 ? { startTime: Math.min(at(0, h1), now - H), endTime: Math.max(at(0, h2), now + 2 * H) } : { startTime: at(d, h1), endTime: at(d, h2) };

	/** @param {string} id @param {keyof typeof places} place @param {Record<string, any>} over */
	const ev = (id, place, over) => {
		const p = places[place];
		const lat = p.lat + (Math.random() - 0.5) * 0.01;
		const lng = p.lng + (Math.random() - 0.5) * 0.01;
		return {
			id,
			data: {
				title: 'Evento',
				shortDescription: '',
				category: 'other',
				priceType: 'free',
				venueName: '',
				address: `Centro, ${p.city}`,
				imageUrl: '',
				ticketUrl: '',
				tags: [],
				source: 'manual',
				sourceUrl: '',
				createdAt: now,
				updatedAt: now,
				...p,
				lat,
				lng,
				geohash: geohashForLocation([lat, lng]),
				...over
			}
		};
	};

	const events = [
		ev('seedJazz', 'modena', {
			title: 'Jazz in Piazza Grande',
			shortDescription: 'Quartetto dal vivo sotto la Ghirlandina. Porta una sedia pieghevole!',
			category: 'music',
			// sempre in corso o di stasera: i test non dipendono dall'ora in cui girano
			startTime: Math.min(at(0, 21), now - H),
			endTime: Math.max(at(0, 23), now + 2 * H),
			venueName: 'Piazza Grande',
			address: 'Piazza Grande, 41121 Modena',
			ticketUrl: 'https://example.org/biglietti',
			source: 'scraper',
			sourceUrl: 'https://www.comune.modena.it/eventi/jazz-in-piazza'
		}),
		ev('seedMercato', 'modena', {
			title: 'Mercato dell’antiquariato',
			category: 'market',
			startTime: at(1, 8),
			endTime: at(1, 18),
			venueName: 'Parco Novi Sad',
			priceType: 'free',
			// immagine volutamente irraggiungibile: e2e/broken-image.spec.ts verifica il ripiego sul motivo di categoria
			imageUrl: 'https://example.org/immagine-rotta.jpg'
		}),
		ev('seedBimbi', 'formigine', {
			title: 'Letture animate per bambini al castello',
			shortDescription: 'Storie e laboratori per bambini dai 4 agli 8 anni.',
			category: 'kids',
			startTime: at(2, 16),
			endTime: at(2, 18),
			venueName: 'Castello di Formigine',
			tags: ['kids']
		}),
		ev('seedSagra', 'formigine', {
			title: 'Sagra del gnocco fritto',
			category: 'food',
			priceType: 'low',
			startTime: at(3, 18),
			endTime: at(3, 23, 59),
			tags: ['family']
		}),
		ev('seedMostra', 'bologna', {
			title: 'Mostra: la Bologna dei portici',
			category: 'culture',
			priceType: 'premium',
			startTime: at(-2, 10),
			endTime: at(20, 19),
			venueName: 'Palazzo d’Accursio'
		}),
		ev('seedRoma', 'roma', { title: 'Concerto all’Auditorium', category: 'music', priceType: 'premium', startTime: at(4, 20), endTime: at(4, 23) }),
		ev('seedLecce', 'lecce', { title: 'Festa del barocco leccese', category: 'culture', startTime: at(5, 18), endTime: at(5, 23) }),
		ev('seedBolzano', 'bolzano', { title: 'Mercatino di Natale in Piazza Walther', category: 'market', startTime: at(2, 10), endTime: at(2, 20) }),
		ev('seedCesena', 'cesena', { title: 'Sagra della piadina', category: 'food', approxLocation: true, startTime: at(2, 12), endTime: at(2, 22) }),
		ev('seedAosta', 'aosta', { title: 'Concerto al Teatro Romano', category: 'music', startTime: at(3, 20), endTime: at(3, 22) }),
		ev('seedFinito', 'modena', { title: 'Evento già concluso', startTime: at(-3, 10), endTime: at(-3, 12) })
	];

	// Weekend: sempre almeno un evento nel prossimo sabato e uno nella prossima domenica (oggi, se oggi lo è). Mezzogiorno: lo scarto
	// tra il fuso del seed e quello di Roma non sposta il giorno.
	events.push(
		ev('seedSabato', 'modena', { title: 'Torneo di bocce al parco', category: 'sport', ...running(until(6), 12, 14), venueName: 'Parco Ferrari' }),
		ev('seedDomenica', 'modena', { title: 'Visita guidata al Duomo', category: 'culture', ...running(until(0), 12, 14), venueName: 'Duomo di Modena' })
	);

	if (xss) {
		/** @type {string[]} */
		const evil = ['<img src=x onerror=alert(1)>', '</script><script>alert(2)</script>', '"><svg onload=alert(3)>', '{{7*7}}${7*7}'];
		events.push(
			ev('xssUno', 'modena', {
				title: `Prova ${evil[0]} ${evil[1]}`,
				shortDescription: `${evil[2]} <b>grassetto</b> ${evil[3]} \u2028 \u0000 fine`,
				venueName: `<script>alert(4)</script>${evil[0]}`,
				address: `Via "Roma" 1, <i>Modena</i> ${evil[1]}`,
				tags: ['family', `<script>alert(5)</script>`],
				category: 'music',
				startTime: at(1, 20),
				endTime: at(1, 23),
				imageUrl: 'javascript:alert(6)',
				ticketUrl: 'javascript:alert(7)',
				source: 'scraper',
				sourceUrl: 'javascript:alert(8)'
			}),
			ev('xssDue', 'modena', {
				title: 'Titolo\r\nBEGIN:VEVENT\r\nSUMMARY:iniettato\r\nEND:VEVENT',
				shortDescription: 'Riga1\r\nATTENDEE:mailto:x@example.test\\;,;',
				venueName: 'Luogo; con, virgole\\e\nnuova riga',
				address: 'data:text/html,<script>alert(9)</script>',
				category: 'culture',
				startTime: at(1, 18),
				endTime: at(1, 19),
				imageUrl: 'https://example.org/x.jpg" onerror="alert(10)',
				ticketUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxMSk8L3NjcmlwdD4=',
				source: 'scraper',
				sourceUrl: 'https://example.org/a b"><script>alert(12)</script>'
			})
		);
	}

	const CATS = ['music', 'food', 'art', 'sport', 'family', 'theatre', 'market', 'other'];
	const bigEvent = (/** @type {string} */ prefix, /** @type {string} */ place, /** @type {number} */ i, /** @type {boolean} */ spread) =>
		ev(`${prefix}${i}`, place, {
			title: `Evento di prova numero ${i} con un titolo abbastanza lungo da occupare spazio`,
			shortDescription: 'Descrizione breve di esempio per riempire la scheda con un testo realistico di circa centocinquanta caratteri, come negli eventi veri.',
			category: CATS[i % CATS.length],
			priceType: i % 3 ? 'free' : 'paid',
			...(spread ? running(i % 7, 10 + (i % 8), 12 + (i % 8)) : { startTime: at(1 + (i % 6), 10 + (i % 8)), endTime: at(1 + (i % 6), 12 + (i % 8)) }),
			venueName: `Luogo ${i}`,
			address: `Via di prova ${i}, ${places[place].city}`,
			imageUrl: `https://example.org/img/${i}.jpg`,
			tags: i % 4 ? [] : ['kids'],
			source: 'scraper',
			sourceUrl: `https://example.org/eventi/${i}`
		});
	// Torino (spread): da oggi a +6, così in ogni giorno della settimana c'è almeno un evento nel weekend in corso o prossimo
	// (di domenica il weekend è ieri e oggi: serve un evento di oggi).
	if (big) for (let i = 0; i < 60; i++) events.push(bigEvent('torino', 'torino', i, true));
	if (bench) for (let i = 0; i < 103; i++) events.push(bigEvent('big', 'modena', i, false));

	return events;
}
