// Parità dello schema evento con web/src/lib/event.ts e l'importer Python (#18).
// Fonte condivisa: docs/schema/parity.json, letta anche da web/src/lib/schema-parity.test.ts e da
// tools/importer/tests/test_schema_parity.py. Come aggiornarla: docs/importer.md, sezione «Schema evento».
//
// Due livelli: (1) il testo di firestore.rules (liste estratte con regex: se una regex non trova nulla il test
// fallisce, non passa in silenzio); (2) il comportamento sull'emulatore (ogni categoria e prezzo ammessi,
// ogni campo obbligatorio, nessun campo estraneo).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

const PARITY = JSON.parse(readFileSync(new URL('../../docs/schema/parity.json', import.meta.url), 'utf8'));
const RULES = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const ADMIN = { email: 'eventivicini.info@gmail.com', email_verified: true };

/** Elenco di stringhe tra apici dentro le parentesi quadre trovate dalla regex (primo gruppo). */
function listFrom(re, text = RULES) {
  const m = re.exec(text);
  if (!m) throw new Error(`firestore.rules: non trovo ${re} (la regola è stata riscritta? aggiorna questo test)`);
  const items = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (items.length === 0) throw new Error(`firestore.rules: elenco vuoto per ${re}`);
  return items;
}
const sorted = (a) => [...a].sort();

const eventsBlock = RULES.slice(RULES.indexOf('match /events/{eventId}'), RULES.indexOf('match /coverage/'));

const base = () => ({
  title: 'Concerto in piazza', shortDescription: 'Musica dal vivo', category: 'music', priceType: 'free',
  startTime: 1_800_000_000_000, endTime: 1_800_003_600_000, venueName: 'Piazza Grande',
  address: 'Piazza Grande, 41121 Modena', lat: 44.6458, lng: 10.9256, imageUrl: '',
  ticketUrl: 'https://example.org/biglietti', tags: ['live'], geohash: 'srbj4w1t0q',
  city: 'Modena', citySlug: 'modena', province: 'MO', region: 'Emilia-Romagna',
  source: 'scraper',
});

describe('testo di firestore.rules contro parity.json', () => {
  it('eventKeys() coincide', () => {
    expect(sorted(listFrom(/function eventKeys\(\) \{\s*return \[([^\]]*)\]/))).toEqual(sorted(PARITY.eventKeys));
  });

  it('le categorie coincidono', () => {
    expect(sorted(listFrom(/d\.category in \[([^\]]*)\]/))).toEqual(sorted(PARITY.categories));
  });

  it('i tipi di prezzo coincidono', () => {
    expect(sorted(listFrom(/d\.priceType in \[([^\]]*)\]/))).toEqual(sorted(PARITY.priceTypes));
  });

  it('i valori di source coincidono', () => {
    expect(sorted(listFrom(/data\.source in \[([^\]]*)\]/, eventsBlock))).toEqual(sorted(PARITY.sources));
  });

  it('i campi ammessi da hasOnly negli eventi coincidono (comuni + opzionali, source compreso)', () => {
    const only = listFrom(/hasOnly\(eventKeys\(\)\.concat\(\s*\[([^\]]*)\]/, eventsBlock);
    expect(sorted([...PARITY.eventKeys, ...only])).toEqual(sorted([...PARITY.eventKeys, ...PARITY.eventOptionalKeys]));
  });

  it('i campi solo-importer non compaiono nelle regole', () => {
    for (const k of PARITY.importerOnlyKeys) expect(RULES, k).not.toContain(`'${k}'`);
  });
});

describe('comportamento delle regole (emulatore)', () => {
  let env;
  let admin;
  beforeAll(async () => {
    env = await initializeTestEnvironment({ projectId: 'demo-eventi', firestore: { rules: RULES } });
  });
  afterAll(() => env.cleanup());
  beforeEach(async () => {
    await env.clearFirestore();
    admin = env.authenticatedContext('admin', ADMIN).firestore();
  });

  const put = (data, id = 'p1') => setDoc(doc(admin, 'events', id), data);

  it('l’evento di base ha esattamente i campi comuni del file condiviso', () => {
    const { source: _s, ...common } = base();
    expect(sorted(Object.keys(common))).toEqual(sorted(PARITY.eventKeys));
  });

  it('ogni categoria del file condiviso è accettata', async () => {
    for (const category of PARITY.categories) await assertSucceeds(put({ ...base(), category }, `c-${category}`));
  });

  it('ogni tipo di prezzo del file condiviso è accettato', async () => {
    for (const priceType of PARITY.priceTypes) await assertSucceeds(put({ ...base(), priceType }, `p-${priceType}`));
  });

  it('ogni valore di source del file condiviso è accettato', async () => {
    for (const source of PARITY.sources) await assertSucceeds(put({ ...base(), source }, `s-${source}`));
  });

  it('una categoria o un prezzo fuori dal file condiviso è rifiutato', async () => {
    await assertFails(put({ ...base(), category: 'theatre' }));
    await assertFails(put({ ...base(), priceType: 'gratis' }));
  });

  it('senza uno qualsiasi dei campi comuni l’evento è rifiutato', async () => {
    for (const k of PARITY.eventKeys) {
      const { [k]: _gone, ...rest } = base();
      await assertFails(put(rest, `no-${k}`));
    }
  });

  it('un campo estraneo è rifiutato; i campi opzionali dichiarati sono accettati', async () => {
    await assertFails(put({ ...base(), campoInventato: 1 }));
    for (const k of PARITY.importerOnlyKeys) await assertFails(put({ ...base(), [k]: 'x' }, `io-${k}`));
    await assertSucceeds(put({ ...base(), sourceUrl: 'https://example.org/e/1', approxLocation: false, locality: 'Frazione',
      longRunning: false, createdAt: 1, updatedAt: 2, contentHash: 'abc', importRegion: 'emilia-romagna', missingRuns: 0, removedAt: 0 }, 'opt'));
  });
});
