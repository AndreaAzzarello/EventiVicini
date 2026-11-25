// Popola l'emulatore Firestore con eventi di prova sparsi in Italia (solo sviluppo e test E2E).
// Uso: node scripts/seed-emulator.mjs   (con `npm run emulators` attivo)
import { geohashForLocation } from 'geofire-common';
import { H, makeAt, places, seedEvents } from './seed-events.mjs';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
if (!/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(HOST)) {
	console.error(`Rifiuto di scrivere su ${HOST}: il seed vale solo per l'emulatore locale.`);
	process.exit(1);
}
const PROJECT = process.env.PUBLIC_FIREBASE_PROJECT_ID || 'demo-eventi';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const now = Date.now();
const at = makeAt(now);

// Eventi: tutti in scripts/seed-events.mjs (date relative a oggi; provati per ogni giorno della settimana da src/lib/seed.test.ts).
//   SEED_XSS=1    eventi con contenuto ostile (scrittura Admin, quindi senza le regole): test di sicurezza dinamici (Strix) su HTML,
//                 JSON-LD e .ics. Fuori dal seed normale perché gli e2e non devono vederli nelle liste.
//   SEED_BIG=1    60 eventi a Torino (oltre 100 km da Modena, fuori dal raggio massimo): per gli e2e sulle liste lunghe.
//   SEED_BENCH=1  103 eventi in più attorno a Modena (114 in tutto, come in produzione) e una copertura sintetica di tutta Italia:
//                 serve a npm run bench:cpu / bench:workerd, non ai test.
const events = seedEvents(now, { xss: !!process.env.SEED_XSS, big: !!process.env.SEED_BIG, bench: !!process.env.SEED_BENCH });

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
			{ name: 'Modena', slug: 'modena', province: 'MO', lat: 44.6458, lng: 10.9256, events: 4 }
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
	[`emilia-romagna_${key(yy, mm)}`]: { region: 'emilia-romagna', name: 'Emilia-Romagna', month: key(yy, mm), events: 412, upcoming: 455, comuni: 3, cities: [{ slug: 'modena', name: 'Modena', n: 250 }, { slug: 'bologna', name: 'Bologna', n: 162 }], updatedAt: now },
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
	// «Questo weekend» (#22), come bundles/weekend dell'importer: righe sintetiche, senza documenti in events (nessun altro test
	// le vede), sempre dentro la finestra ven 18:00 – dom 23:59 e ancora in corso fino a domenica sera.
	const wd = new Date(at(0, 0)).getDay();
	const friday = wd === 0 ? -2 : wd === 6 ? -1 : 5 - wd;
	const weekendEvent = (id, title, place, day, hour, category) => {
		const p = places[place];
		return rowOf({ id, data: { ...p, title, category, priceType: 'free', venueName: 'Piazza del mercato', address: `Centro, ${p.city}`, startTime: at(friday + day, hour), endTime: at(friday + 2, 23) } });
	};
	buckets.weekend = [
		weekendEvent('we-1', 'Festa dei sapori d’autunno', 'modena', 1, 10, 'food'),
		weekendEvent('we-2', 'Concerto al tramonto', 'roma', 1, 16, 'music'),
		weekendEvent('we-3', 'Passeggiata nel borgo', 'lecce', 2, 11, 'culture'),
		weekendEvent('we-4', 'Mercatino del riuso', 'bolzano', 2, 15, 'market'),
		weekendEvent('we-5', 'Laboratorio di ceramica', 'bologna', 1, 20, 'kids')
	];
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
