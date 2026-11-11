// Popola l'emulatore Firestore con eventi di prova sparsi in Italia (solo sviluppo e test E2E).
// Uso: node scripts/seed-emulator.mjs   (con `npm run emulators` attivo)
import { geohashForLocation } from 'geofire-common';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

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

// SEED_XSS=1: eventi con contenuto ostile, come potrebbe arrivare da una fonte importata (scrittura Admin, quindi senza le
// regole). Servono ai test di sicurezza dinamici (Strix) sul rendering di HTML, JSON-LD e .ics. Solo emulatore: fuori dal
// seed normale perché gli e2e non devono vederli nelle liste.
if (process.env.SEED_XSS) {
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

const enc = (v) => {
	if (typeof v === 'string') return { stringValue: v };
	if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
	if (typeof v === 'boolean') return { booleanValue: v };
	if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
	if (v && typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
	return { nullValue: null };
};

// Dati «grandi», solo su richiesta (additivi: i test e2e di base non li vedono).
//   SEED_BIG=1    60 eventi a Torino (oltre 100 km da Modena, fuori dal raggio massimo): per gli e2e sulle liste lunghe.
//   SEED_BENCH=1  103 eventi in più attorno a Modena (114 in tutto, come in produzione) e una copertura sintetica di tutta Italia:
//                 serve a npm run bench:cpu / bench:workerd, non ai test.
places.torino = { city: 'Torino', citySlug: 'torino', province: 'TO', region: 'Piemonte', lat: 45.0703, lng: 7.6869 };
const CATS = ['music', 'food', 'art', 'sport', 'family', 'theatre', 'market', 'other'];
const bigEvent = (prefix, place, i) =>
	ev(`${prefix}${i}`, place, {
		title: `Evento di prova numero ${i} con un titolo abbastanza lungo da occupare spazio`,
		shortDescription: 'Descrizione breve di esempio per riempire la scheda con un testo realistico di circa centocinquanta caratteri, come negli eventi veri.',
		category: CATS[i % CATS.length],
		priceType: i % 3 ? 'free' : 'paid',
		startTime: at(1 + (i % 6), 10 + (i % 8)),
		endTime: at(1 + (i % 6), 12 + (i % 8)),
		venueName: `Luogo ${i}`,
		address: `Via di prova ${i}, ${places[place].city}`,
		imageUrl: `https://example.org/img/${i}.jpg`,
		tags: i % 4 ? [] : ['kids'],
		source: 'scraper',
		sourceUrl: `https://example.org/eventi/${i}`
	});
if (process.env.SEED_BIG) for (let i = 0; i < 60; i++) events.push(bigEvent('torino', 'torino', i));
if (process.env.SEED_BENCH) for (let i = 0; i < 103; i++) events.push(bigEvent('big', 'modena', i));

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
if (process.env.SEED_BIG)
	coverage.piemonte = { name: 'Piemonte', updatedAt: now, comuni: [{ name: 'Torino', slug: 'torino', province: 'TO', lat: 45.0703, lng: 7.6869, events: 60 }] };
if (process.env.SEED_BENCH) {
	// Copertura sintetica di tutta Italia dall'elenco ISTAT già nel repo (~1.100 comuni, ~80% con eventi), come in produzione.
	const { readFileSync } = await import('node:fs');
	const raw = JSON.parse(readFileSync(new URL('../src/lib/data/comuni.json', import.meta.url), 'utf8'));
	const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, '');
	const synthetic = {};
	let k = 0;
	for (const [name, alt, province, r, lat, lng, , s] of raw.c) {
		if (++k % 8 > 4) continue; // ~una ogni 1,6 comuni: ~1.100 su ~7.900, con regioni piene come nella copertura reale
		const regionName = raw.regioni[r];
		const rid = slug(regionName);
		(synthetic[rid] ??= { name: regionName, updatedAt: now, comuni: [] }).comuni.push({ name, slug: s || slug(name), province, lat, lng, events: k % 5, ...(alt ? { alt } : {}) });
	}
	// i luoghi veri del seed restano come sono (Modena ha 114 eventi)
	for (const [rid, data] of Object.entries(coverage)) {
		const target = (synthetic[rid] ??= { name: data.name, updatedAt: now, comuni: [] });
		target.comuni = target.comuni.filter((c) => !data.comuni.some((d) => d.slug === c.slug)).concat(data.comuni);
	}
	for (const c of synthetic['emilia-romagna'].comuni) if (c.slug === 'modena') c.events = 114;
	for (const key2 of Object.keys(coverage)) delete coverage[key2];
	Object.assign(coverage, synthetic);
}
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

// SEED_USERS=1: utenti finti solo nell'emulatore Auth, per i test di sicurezza dinamici (Strix). Mai in produzione:
// l'host Auth deve essere locale. Le password sono casuali a ogni run e vanno solo nel file SEED_USERS_OUT
// (fuori dal repo), mai nei log.
if (process.env.SEED_USERS) {
	const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
	if (!/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(AUTH_HOST) || !PROJECT.startsWith('demo-')) {
		console.error('Rifiuto di creare utenti: servono emulatore Auth locale e progetto demo-*.');
		process.exit(1);
	}
	const out = process.env.SEED_USERS_OUT;
	if (!out) {
		console.error('SEED_USERS_OUT obbligatorio: file fuori dal repo dove scrivere le credenziali.');
		process.exit(1);
	}
	const ID = `http://${AUTH_HOST}/identitytoolkit.googleapis.com`;
	const owner = { 'content-type': 'application/json', Authorization: 'Bearer owner' };
	const specs = [
		{ key: 'userA', email: 'utente.a@example.test' },
		{ key: 'userB', email: 'utente.b@example.test' },
		{ key: 'userNonVerificato', email: 'utente.nv@example.test', verify: false }, // email non verificata: le regole (isAdmin, ecc.) non devono fidarsi
		{ key: 'admin', email: 'eventivicini.info@gmail.com' } // l'email che le regole considerano admin: finta, solo nell'emulatore
	];
	const creds = {};
	for (const s of specs) {
		const password = randomBytes(12).toString('base64url');
		const res = await fetch(`${ID}/v1/accounts:signUp?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: s.email, password, returnSecureToken: false }) });
		if (!res.ok) throw new Error(`signUp ${s.key}: ${res.status}`);
		const { localId } = await res.json();
		if (s.verify !== false) {
			const up = await fetch(`${ID}/v1/projects/${PROJECT}/accounts:update`, { method: 'POST', headers: owner, body: JSON.stringify({ localId, emailVerified: true }) });
			if (!up.ok) throw new Error(`verifica ${s.key}: ${up.status}`);
		}
		creds[s.key] = { email: s.email, password, uid: localId };
	}
	const put = async (path, data) => {
		const res = await fetch(`${BASE}/${path}`, { method: 'PATCH', headers: owner, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v instanceof Date ? { timestampValue: v.toISOString() } : enc(v)])) }) });
		if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
	};
	const created = new Date();
	await put(`users/${creds.userA.uid}`, { createdAt: created, pendingCount: 1, favCount: 2, favChanges: 2, favAt: created, lastFavId: 'seedMercato' });
	await put(`users/${creds.userB.uid}`, { createdAt: created, pendingCount: 0 });
	await put(`users/${creds.admin.uid}`, { createdAt: created, pendingCount: 0 });
	await put(`users/${creds.userNonVerificato.uid}`, { createdAt: created, pendingCount: 0 });
	for (const id of ['seedJazz', 'seedMercato']) await put(`users/${creds.userA.uid}/favorites/${id}`, { addedAt: now });
	const p = places.modena;
	const lat = p.lat;
	const lng = p.lng;
	await put('submissions/seedProposta', {
		title: 'Proposta in attesa', shortDescription: 'Evento di prova da moderare', category: 'other', priceType: 'free',
		startTime: at(3, 18), endTime: at(3, 21), venueName: 'Sala di prova', address: 'Centro, Modena', lat, lng,
		imageUrl: '', ticketUrl: '', tags: [], geohash: geohashForLocation([lat, lng]), city: p.city, citySlug: p.citySlug,
		province: p.province, region: p.region, ownerId: creds.userA.uid, status: 'pending', createdAt: created
	});
	await put('reports/seedSegnalazione', { eventId: 'seedJazz', reason: 'other', text: 'Segnalazione di prova per il test', email: '', status: 'open', createdAt: created });
	writeFileSync(out, JSON.stringify(creds, null, 2), { mode: 0o600 });
	console.log(`Creati 4 utenti finti (uno con email non verificata), preferiti, 1 proposta e 1 segnalazione (credenziali in ${out})`);
}
