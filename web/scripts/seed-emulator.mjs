// Popola l'emulatore Firestore con eventi di prova sparsi in Italia (solo sviluppo e test E2E).
// Uso: node scripts/seed-emulator.mjs   (con `npm run emulators` attivo)
import { geohashForLocation } from 'geofire-common';

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
if (!/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(HOST)) {
	console.error(`Rifiuto di scrivere su ${HOST}: il seed vale solo per l'emulatore locale.`);
	process.exit(1);
}
const PROJECT = process.env.PUBLIC_FIREBASE_PROJECT_ID || 'demo-eventi';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const H = 3600_000;
const now = Date.now();
const day0 = new Date(now);
day0.setHours(0, 0, 0, 0);
const at = (days, hour) => day0.getTime() + days * 24 * H + hour * H;

const places = {
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
		priceType: 'free'
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

const enc = (v) => {
	if (typeof v === 'string') return { stringValue: v };
	if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
	if (typeof v === 'boolean') return { booleanValue: v };
	if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
	if (v && typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
	return { nullValue: null };
};

for (const { id, data } of events) {
	const res = await fetch(`${BASE}/events/${id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' },
		body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) })
	});
	if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`);
}
console.log(`Inseriti ${events.length} eventi in ${BASE}`);

// Come coverage/{regione} scritto dall'importer: comuni coperti con centro e numero di eventi.
const coverage = {
	'emilia-romagna': {
		name: 'Emilia-Romagna',
		updatedAt: now,
		comuni: [
			{ name: 'Bologna', slug: 'bologna', province: 'BO', lat: 44.4939, lng: 11.3428, events: 1 },
			{ name: 'Cesena', slug: 'cesena', province: 'FC', lat: 44.1391, lng: 12.2431, events: 1 },
			{ name: 'Formigine', slug: 'formigine', province: 'MO', lat: 44.5733, lng: 10.8466, events: 2 },
			{ name: 'Modena', slug: 'modena', province: 'MO', lat: 44.6458, lng: 10.9256, events: 2 }
		]
	},
	'trentino-alto-adige': {
		name: 'Trentino-Alto Adige',
		updatedAt: now,
		comuni: [
			{ name: 'Bolzano', slug: 'bolzano', alt: 'Bozen', province: 'BZ', lat: 46.4983, lng: 11.3548, events: 1 },
			{ name: 'Trento', slug: 'trento', province: 'TN', lat: 46.0679, lng: 11.1211, events: 0 }
		]
	},
	"valle-d-aosta": {
		name: "Valle d'Aosta",
		updatedAt: now,
		comuni: [{ name: 'Aosta', slug: 'aosta', alt: 'Aoste', province: 'AO', lat: 45.7375, lng: 7.3203, events: 1 }]
	},
	lombardia: {
		name: 'Lombardia',
		updatedAt: now,
		comuni: [
			{ name: 'Como', slug: 'como', province: 'CO', lat: 45.81, lng: 9.0852, events: 0 },
			{ name: 'Lecco', slug: 'lecco', province: 'LC', lat: 45.8566, lng: 9.3977, events: 0 }
		]
	}
};
for (const [id, data] of Object.entries(coverage)) {
	const res = await fetch(`${BASE}/coverage/${id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' },
		body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) })
	});
	if (!res.ok) throw new Error(`coverage/${id}: ${res.status} ${await res.text()}`);
}
console.log(`Inserite ${Object.keys(coverage).length} regioni in coverage`);

// Come stats/{regione}_{AAAA-MM} scritto dall'importer: mese corrente e precedente (a ora di Roma).
const rome = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit' }).formatToParts(new Date(now));
const [yy, mm] = [Number(rome[0].value), Number(rome[2].value)];
const key = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const stats = {
	[`emilia-romagna_${key(yy, mm)}`]: { region: 'emilia-romagna', name: 'Emilia-Romagna', month: key(yy, mm), events: 412, comuni: 3, cities: [{ slug: 'modena', name: 'Modena', n: 250 }, { slug: 'bologna', name: 'Bologna', n: 162 }], updatedAt: now },
	[`emilia-romagna_${mm === 1 ? key(yy - 1, 12) : key(yy, mm - 1)}`]: { region: 'emilia-romagna', name: 'Emilia-Romagna', month: mm === 1 ? key(yy - 1, 12) : key(yy, mm - 1), events: 374, comuni: 3, cities: [{ slug: 'modena', name: 'Modena', n: 230 }, { slug: 'bologna', name: 'Bologna', n: 144 }], updatedAt: now }
};
for (const [id, data] of Object.entries(stats)) {
	const res = await fetch(`${BASE}/stats/${id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' },
		body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) })
	});
	if (!res.ok) throw new Error(`stats/${id}: ${res.status} ${await res.text()}`);
}
console.log(`Inseriti ${Object.keys(stats).length} documenti in stats`);

// Come bundles/* scritti dall'importer (tools/importer/bundles.py): le liste lette dalla webapp. SEED_NO_BUNDLES=1 li salta
// (prova del ripiego sulle query, valido finché il primo import non li crea).
if (!process.env.SEED_NO_BUNDLES) {
	const FIELDS = ['id', 'title', 'startTime', 'endTime', 'category', 'priceType', 'venueName', 'address', 'locality', 'city',
		'citySlug', 'cityAlt', 'province', 'region', 'lat', 'lng', 'imageUrl', 'tags', 'longRunning', 'approxLocation'];
	const NUM = new Set(['startTime', 'endTime', 'lat', 'lng']);
	const rowOf = ({ id, data }) =>
		FIELDS.map((f) => {
			const v = id && f === 'id' ? id : data[f];
			if (f === 'tags') return (v ?? []).filter((t) => t === 'kids' || t === 'family');
			if (f === 'longRunning') return !!v || data.endTime - data.startTime > 14 * 24 * H;
			if (f === 'approxLocation') return !!v;
			return NUM.has(f) ? (v ?? 0) : (v ?? '');
		});
	const live = events.filter((e) => e.data.endTime >= now);
	const buckets = { sitemap: live.map(rowOf) };
	for (const e of live) {
		for (const name of [`g_${e.data.geohash.slice(0, 4)}`, `c_${e.data.citySlug}`]) (buckets[name] ??= []).push(rowOf(e));
	}
	buckets.coverage = Object.entries(coverage).map(([slug, c]) => ({ slug, name: c.name, comuni: c.comuni }));
	for (const [name, rows] of Object.entries(buckets)) {
		const doc = { json: JSON.stringify(rows), parts: 1, hash: name, updatedAt: now };
		const res = await fetch(`${BASE}/bundles/${name}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' },
			body: JSON.stringify({ fields: Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, enc(v)])) })
		});
		if (!res.ok) throw new Error(`bundles/${name}: ${res.status} ${await res.text()}`);
	}
	console.log(`Inseriti ${Object.keys(buckets).length} bundle`);
}
