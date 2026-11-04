// Tetti delle regole raggiunti con il flusso reale del client, un'operazione alla volta (non con i contatori già impostati):
// 5 proposte in attesa, 200 preferiti, 100 modifiche al giorno. I casi al confine con contatori fissi sono in rules.test.js.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, increment, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch } from 'firebase/firestore';

let env;

const event = () => ({
  title: 'Concerto in piazza', shortDescription: 'Musica dal vivo', category: 'music', priceType: 'free',
  startTime: 1_800_000_000_000, endTime: 1_800_003_600_000, venueName: 'Piazza Grande',
  address: 'Piazza Grande, 41121 Modena', lat: 44.6458, lng: 10.9256, imageUrl: '',
  ticketUrl: 'https://example.org/biglietti', tags: ['live'], geohash: 'srbj4w1t0q',
  city: 'Modena', citySlug: 'modena', province: 'MO', region: 'Emilia-Romagna',
});

const db = (uid) => env.authenticatedContext(uid).firestore();
const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));
const newUser = (uid) => seed((fs) => setDoc(doc(fs, 'users', uid), { name: uid, city: '', createdAt: new Date(), pendingCount: 0 }));
/** Il giorno dopo: sposta all'indietro l'ultima modifica registrata, come farebbe il passare del tempo. */
const yesterday = (uid) => seed((fs) => updateDoc(doc(fs, 'limits', uid), { favAt: Timestamp.fromMillis(Date.now() - 2 * 86_400_000) }));

// Come il client: proposta + contatore nello stesso batch.
function submit(fs, uid, sid) {
  const b = writeBatch(fs);
  b.set(doc(fs, 'submissions', sid), { ...event(), ownerId: uid, status: 'pending', createdAt: serverTimestamp() });
  b.update(doc(fs, 'users', uid), { pendingCount: increment(1), lastSubmissionId: sid });
  return b.commit();
}
function withdraw(fs, uid, sid) {
  const b = writeBatch(fs);
  b.delete(doc(fs, 'submissions', sid));
  b.update(doc(fs, 'users', uid), { pendingCount: increment(-1), lastSubmissionId: sid });
  return b.commit();
}
// Come il client: un preferito e i contatori (limits/{uid}) nello stesso batch.
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
  await newUser('alice');
  await newUser('bob');
});

describe('tetto di 5 proposte in attesa', () => {
  it('la 6ª è rifiutata, il ritiro libera un posto, il tetto è per utente', async () => {
    const a = db('alice');
    for (let i = 1; i <= 5; i++) await assertSucceeds(submit(a, 'alice', `s${i}`));
    await assertFails(submit(a, 'alice', 's6'));
    await assertSucceeds(submit(db('bob'), 'bob', 'b1')); // il tetto di alice non tocca bob
    await assertSucceeds(withdraw(a, 'alice', 's3'));
    await assertSucceeds(submit(a, 'alice', 's6'));
    await assertFails(submit(a, 'alice', 's7'));
  });
  it('il contatore non si abbassa a mano per aggirare il tetto', async () => {
    const a = db('alice');
    for (let i = 1; i <= 5; i++) await assertSucceeds(submit(a, 'alice', `s${i}`));
    await assertFails(updateDoc(doc(a, 'users', 'alice'), { pendingCount: 0 }));
    await assertFails(updateDoc(doc(a, 'users', 'alice'), { pendingCount: increment(-1), lastSubmissionId: 'fantasma' }));
  });
});

describe('100 modifiche al giorno e 200 preferiti, un preferito alla volta', () => {
  it('la 101ª modifica del giorno è rifiutata; il giorno dopo si arriva a 200; il 201º no', async () => {
    const a = db('alice');
    for (let i = 1; i <= 100; i++) await assertSucceeds(addFav(a, 'alice', `e${i}`, i, i));
    await assertFails(addFav(a, 'alice', 'e101', 101, 101));
    await assertFails(addFav(a, 'alice', 'e101', 101, 1)); // azzerare da soli il contatore del giorno
    await yesterday('alice');
    for (let i = 101; i <= 200; i++) await assertSucceeds(addFav(a, 'alice', `e${i}`, i, i - 100));
    await yesterday('alice');
    await assertFails(addFav(a, 'alice', 'e201', 201, 1)); // tetto di 200 preferiti
  });
});

describe('azzerare i contatori cancellando e ricreando il profilo', () => {
  // Il profilo si cancella con 0 proposte in attesa e si ricrea vuoto, ma i contatori stanno in limits/{uid}, che il client
  // non cancella: tetto di 200 e 100 modifiche al giorno non ripartono da zero. (Prima di limits/{uid} questo test
  // era it.fails: la falla è stata verificata il 4/11/2026.)
  it('dopo 100 modifiche oggi, cancellare e ricreare il profilo non permette altre modifiche', async () => {
    const a = db('alice');
    for (let i = 1; i <= 100; i++) await assertSucceeds(addFav(a, 'alice', `e${i}`, i, i));
    await assertSucceeds(deleteDoc(doc(a, 'users', 'alice')));
    await assertSucceeds(setDoc(doc(a, 'users', 'alice'), { createdAt: serverTimestamp(), pendingCount: 0 }));
    await assertFails(addFav(a, 'alice', 'x1', 1, 1)); // contatori da zero: rifiutato
    await assertFails(addFav(a, 'alice', 'x1', 101, 101)); // oltre il tetto del giorno
    await assertFails(deleteDoc(doc(a, 'limits', 'alice')));
  });
});
