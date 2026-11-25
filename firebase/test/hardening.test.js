// Revisione di sicurezza del 25/11/2026 (aree non coperte da Strix): matrice degli URL, lunghezze del profilo, concorrenza dei
// contatori, mezzanotte UTC. Solo test: le regole non cambiano. Se un caso fallisce, il comportamento descritto è quello da correggere.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, increment, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch } from 'firebase/firestore';

let env;
const ADMIN = { email: 'eventivicini.info@gmail.com', email_verified: true };

const event = (over = {}) => ({
  title: 'Concerto in piazza', shortDescription: 'Musica dal vivo', category: 'music', priceType: 'free',
  startTime: 1_800_000_000_000, endTime: 1_800_003_600_000, venueName: 'Piazza Grande',
  address: 'Piazza Grande, 41121 Modena', lat: 44.6458, lng: 10.9256, imageUrl: '',
  ticketUrl: 'https://example.org/biglietti', tags: ['live'], geohash: 'srbj4w1t0q',
  city: 'Modena', citySlug: 'modena', province: 'MO', region: 'Emilia-Romagna', ...over,
});

const db = (uid, token) => env.authenticatedContext(uid, token).firestore();
const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));

function submit(fs, uid, sid, data = {}) {
  const b = writeBatch(fs);
  b.set(doc(fs, 'submissions', sid), { ...event(), ownerId: uid, status: 'pending', createdAt: serverTimestamp(), ...data });
  b.update(doc(fs, 'users', uid), { pendingCount: increment(1), lastSubmissionId: sid });
  return b.commit();
}
function addFav(fs, uid, id, count, changes) {
  const b = writeBatch(fs);
  b.set(doc(fs, `users/${uid}/favorites/${id}`), { addedAt: Date.now() });
  b.set(doc(fs, 'limits', uid), { favCount: count, favChanges: changes, favAt: serverTimestamp(), lastFavId: id });
  return b.commit();
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-eventi',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
afterAll(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await seed(async (fs) => {
    await setDoc(doc(fs, 'users', 'alice'), { name: 'Alice', city: '', createdAt: new Date(), pendingCount: 0 });
  });
});

// Link ostili o malformati: il sito li rende in <img src> o <a href>; le regole sono la seconda linea di difesa.
const BAD = {
  'javascript:': 'javascript:alert(1)',
  'data:': 'data:text/html,<script>alert(1)</script>',
  'file:': 'file:///etc/passwd',
  'ftp:': 'ftp://x.it/a.png',
  'senza schema': 'example.org/a.png',
  'protocollo relativo': '//example.org/a.png',
  'spazio': 'https://example.org/a b.png',
  'a capo': 'https://example.org/a\n.png',
  'tab': 'https://example.org/\ta.png',
  '501 caratteri': 'https://example.org/' + 'a'.repeat(481),
  'non stringa': 5,
};
const OK = {
  'https': 'https://example.org/a.png',
  'http (ammesso dalle regole: lo porta a https il sito)': 'http://example.org/a.png',
  '500 caratteri': 'https://example.org/' + 'a'.repeat(480),
  'con utente e password (ammesso: solo testo, il browser non lo usa come immagine)': 'https://utente:password@example.org/a.png',
};

describe('eventi: matrice URL (solo admin scrive)', () => {
  for (const field of ['imageUrl', 'ticketUrl']) {
    for (const [name, v] of Object.entries(BAD)) {
      it(`${field} ${name} rifiutato`, async () => {
        await assertFails(setDoc(doc(db('adm', ADMIN), 'events', 'n1'), { ...event({ [field]: v }), source: 'manual' }));
      });
    }
    for (const [name, v] of Object.entries(OK)) {
      it(`${field} ${name} accettato`, async () => {
        await assertSucceeds(setDoc(doc(db('adm', ADMIN), 'events', 'n1'), { ...event({ [field]: v }), source: 'manual' }));
      });
    }
  }
  it('un utente non admin non scrive eventi nemmeno con URL validi', async () => {
    await assertFails(setDoc(doc(db('alice'), 'events', 'n1'), { ...event(), source: 'manual' }));
  });
});

describe('proposte: matrice URL (imageUrl, ticketUrl, sourceUrl)', () => {
  for (const field of ['imageUrl', 'ticketUrl', 'sourceUrl']) {
    for (const [name, v] of Object.entries(BAD)) {
      it(`${field} ${name} rifiutato`, async () => {
        await assertFails(submit(db('alice'), 'alice', 's1', { [field]: v }));
      });
    }
  }
  it('sourceUrl delle proposte: solo https (diverso da imageUrl e ticketUrl)', async () => {
    await assertFails(submit(db('alice'), 'alice', 's1', { sourceUrl: 'http://example.org/post' }));
    await assertSucceeds(submit(db('alice'), 'alice', 's2', { sourceUrl: 'https://example.org/post' }));
  });
  it('imageUrl e ticketUrl in http: le regole li ammettono (la difesa è nel client e in lettura)', async () => {
    await assertSucceeds(submit(db('alice'), 'alice', 's3', { imageUrl: 'http://example.org/a.png', ticketUrl: 'http://example.org/t' }));
  });
});

describe('profilo: lunghezze e limiti', () => {
  const upd = (data) => updateDoc(doc(db('alice'), 'users', 'alice'), data);
  it.each([['name', 80, 81], ['city', 80, 81]])('%s: %d sì, %d no', async (k, ok, ko) => {
    await assertSucceeds(upd({ [k]: 'a'.repeat(ok) }));
    await assertFails(upd({ [k]: 'a'.repeat(ko) }));
  });
  it('name e city non stringa: rifiutati', async () => {
    await assertFails(upd({ name: 5 }));
    await assertFails(upd({ city: ['x'] }));
  });
  const place = (over = {}) => ({ label: 'Modena', lat: 44.6, lng: 10.9, ...over });
  it('homePlace: label 80 sì, 81 no, vuota no', async () => {
    await assertSucceeds(upd({ homePlace: place({ label: 'a'.repeat(80) }) }));
    await assertFails(upd({ homePlace: place({ label: 'a'.repeat(81) }) }));
    await assertFails(upd({ homePlace: place({ label: '' }) }));
  });
  it('homePlace: lat/lng ai limiti sì, fuori no, NaN-simili e stringhe no', async () => {
    await assertSucceeds(upd({ homePlace: place({ lat: 90, lng: 180 }) }));
    await assertSucceeds(upd({ homePlace: place({ lat: -90, lng: -180 }) }));
    await assertFails(upd({ homePlace: place({ lat: 90.0001 }) }));
    await assertFails(upd({ homePlace: place({ lng: -180.0001 }) }));
    await assertFails(upd({ homePlace: place({ lat: '44.6' }) }));
  });
  it('homePlace: chiavi in più, slug e region oltre 80, non mappa', async () => {
    await assertFails(upd({ homePlace: place({ extra: 'x' }) }));
    await assertFails(upd({ homePlace: place({ slug: 'a'.repeat(81) }) }));
    await assertFails(upd({ homePlace: place({ region: 'a'.repeat(81) }) }));
    await assertFails(upd({ homePlace: 'Modena' }));
  });
  it('campi non ammessi nel profilo (ruolo, email, uid, createdAt riscritto)', async () => {
    for (const data of [{ role: 'admin' }, { email: 'a@b.it' }, { uid: 'bob' }, { isAdmin: true }, { createdAt: new Date() }]) {
      await assertFails(upd(data));
    }
  });
});

describe('contatori: concorrenza e confini', () => {
  it('due proposte in parallelo dal 4° slot: al massimo una arriva a 5 e mai oltre', async () => {
    const fs = db('alice');
    for (const i of [1, 2, 3, 4]) await assertSucceeds(submit(fs, 'alice', `p${i}`));
    const res = await Promise.allSettled([submit(db('alice'), 'alice', 'p5'), submit(db('alice'), 'alice', 'p6')]);
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    const { getDoc } = await import('firebase/firestore');
    const n = (await getDoc(doc(db('alice'), 'users', 'alice'))).data().pendingCount;
    // Le regole confrontano il contatore con lo stato committato: se entrambe passano, il tetto di 5 è aggirato.
    if (ok > 1) throw new Error(`concorrenza: ${ok} proposte accettate in parallelo, pendingCount=${n}`);
    if (n > 5) throw new Error(`pendingCount=${n} oltre il tetto`);
  });
  it('proposta con il contatore a 5: rifiutata', async () => {
    for (const i of [1, 2, 3, 4, 5]) await assertSucceeds(submit(db('alice'), 'alice', `q${i}`));
    await assertFails(submit(db('alice'), 'alice', 'q6'));
  });
  it('due preferiti in parallelo con gli stessi contatori: la seconda scrittura non salta il conteggio', async () => {
    await assertSucceeds(addFav(db('alice'), 'alice', 'f0', 1, 1));
    const res = await Promise.allSettled([addFav(db('alice'), 'alice', 'f1', 2, 2), addFav(db('alice'), 'alice', 'f2', 2, 2)]);
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    // Entrambe dichiarano count=2 partendo da 1: se passano entrambe, i preferiti sono 3 ma il contatore dice 2.
    if (ok > 1) throw new Error(`concorrenza: ${ok} preferiti accettati con lo stesso contatore`);
  });
});

describe('limite giornaliero: confine UTC (dayNum)', () => {
  const setLimits = (favAt, favChanges) =>
    seed((fs) => setDoc(doc(fs, 'limits', 'alice'), { favCount: 1, favChanges, favAt: Timestamp.fromMillis(favAt), lastFavId: 'x' }));
  const midnightToday = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

  it('100 modifiche registrate oggi (UTC): la 101ª è rifiutata', async () => {
    await setLimits(midnightToday() + 1000, 100);
    await assertFails(addFav(db('alice'), 'alice', 'g1', 2, 101));
  });
  it('100 modifiche registrate ieri un attimo prima di mezzanotte UTC: oggi il conteggio riparte da 1', async () => {
    await setLimits(midnightToday() - 1000, 100);
    await assertSucceeds(addFav(db('alice'), 'alice', 'g2', 2, 1));
  });
  it('dopo il reset, dichiarare 101 (senza ripartire da 1) è rifiutato', async () => {
    await setLimits(midnightToday() - 1000, 100);
    await assertFails(addFav(db('alice'), 'alice', 'g3', 2, 101));
  });
});
