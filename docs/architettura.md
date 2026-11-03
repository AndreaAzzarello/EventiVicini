# Architettura, configurazione e Firebase

Parti tecniche spostate dal README. Design system: [DESIGN.md](../DESIGN.md).

## Architettura

```
 Browser (PWA)
   |  HTML SSR, JSON /api/*        |  Firebase JS SDK, caricato solo quando serve
   |                               |  (login, preferiti, proposte, admin)
   v                               v
 Cloudflare Pages                 Firebase
 (Worker SvelteKit)               - Authentication
   - SSR: lib/server/firestore.ts - Cloud Firestore <------------+
     fetch REST, senza Admin SDK                                  |
   - /api/events  -> query per geohash, cache                     |
   - /api/geocode -> proxy verso Nominatim (OSM)                  |
          |                                                       |
          v                                                       |
 Nominatim (OSM)                                                  |
                                                                  |
 Importer Python (GitHub Actions, ogni giorno)  -- Admin SDK ----+
   - legge i siti dei comuni (API Plone)
   - geocoding Nominatim con cache

 Browser -> tile OpenStreetMap (Leaflet, mappa)
```

Punti chiave:

- **Lista e pagine pubbliche**: SSR sul Worker. La home carica gli eventi della zona predefinita (Modena, 25 km). I filtri si applicano nel browser.
- **Posizione**: se l'utente la concede, la webapp chiama `/api/events` con coordinate arrotondate a una griglia di circa 5 km. La posizione resta nel localStorage del dispositivo.
- **Query per raggio**: ogni raggio diventa un insieme di intervalli di geohash (`geofire-common`). Una query Firestore per intervallo, mai l'intera collezione.
- **Firebase lato client**: `web/src/lib/firebase/client.ts` importa `firebase/app`, `firebase/auth` e `firebase/firestore/lite` in modo dinamico. Chi naviga senza account non scarica l'SDK.
- **Cache**: in memoria per isolate (5 minuti), `Cache-Control` sulle risposte HTML e JSON (vedi [quote-firestore.md](quote-firestore.md)).

---

## Struttura delle cartelle

```
web/
  src/
    routes/            pagine e API: /, /eventi/[slug], /citta/[slug], /proponi,
                       /preferiti, /account, /accedi, /admin, /privacy, /termini,
                       /api/events, /api/geocode, sitemap.xml, robots.txt, /offline,
                       /admin/statistiche, /admin/stile
    lib/
      server/          firestore.ts (lettura REST), cache.ts (header di cache), legal.ts
      firebase/        caricamento lazy dell'SDK Firebase lato browser
      components/      componenti Svelte
      event.ts         modello Event, validazione, limiti dei campi
      geo.ts           raggi, geohash, griglia della cache, distanza
      geocode.ts       ricerca comuni e indirizzi via /api/geocode
      images.ts        srcset delle immagini di terze parti (scale Plone)
      styles/          tokens.css (design system) e design.test.ts (controllo automatico)
      *.test.ts        test unitari (Vitest)
    service-worker.ts  PWA: app shell e pagina offline
  e2e/                 test Playwright (desktop e mobile)
  scripts/seed-emulator.mjs   dati di prova per l'emulatore Firestore
  wrangler.toml        configurazione Cloudflare Pages e variabili pubbliche
  .env.example         variabili per `npm run dev` (emulatori)
  .dev.vars.example    variabili per `npm run preview` (wrangler, emulatori)

firebase/
  firebase.json        regole, indici, porte degli emulatori
  firestore.rules      regole di sicurezza (vedi "Regole Firestore")
  firestore.indexes.json
  test/rules.test.js   test delle regole sull'emulatore
  .firebaserc          progetto di default: appeventi-1e860

tools/importer/
  run.py               importer: raccolta, geocoding, deduplica, scrittura dei soli cambiamenti
  cleanup.py           pulizia giornaliera del database (eventi e proposte scaduti)
  activate.py          attivazione automatica delle fonti (regola approvata)
  ci_report.py         matrice per regione e riepilogo unico del workflow
  migrate.py           migrazione una tantum degli eventi esistenti
  adapters/            fonti: base.py (interfaccia), plone.py, wordpress.py, __init__.py (registro)
  sources/<regione>.csv   registro delle fonti, un file per regione (comuni, CMS, licenza, stato)
  provinces.json       riquadri delle province (generato da build_provinces.py)
  build_registry.py    genera il registro da ISTAT e IndicePA
  build_provinces.py   genera provinces.json da ISTAT e OpenStreetMap
  detect_cms.py        riconosce CMS, pagina eventi e licenza dei comuni
  geo.py, geocode.py, licenses.py, mapping.py, registry.py, db.py
  seed_demo.py         10 eventi demo (solo emulatore Firestore: vedi [importer.md](importer.md))
  tests/               test pytest con fixture

.github/workflows/
  ci.yml               controlli della webapp e test delle regole
  import-events.yml    import giornaliero dell'importer
```

---

## Variabili d'ambiente

I nomi con prefisso `PUBLIC_` sono esposti al browser da SvelteKit. Non sono segreti: la configurazione web di Firebase è pubblica per costruzione, e la sicurezza dei dati sta nelle regole Firestore e nelle regole di Authentication.

| Nome | Dove va | Valore / esempio | Note |
|---|---|---|---|
| `PUBLIC_SITE_URL` | `wrangler.toml` `[vars]`; `.env`; `.dev.vars` | `https://eventi-vicini.pages.dev`; in locale `http://localhost:5173` (`.env`) o `http://localhost:8788` (`.dev.vars`) | URL del sito, usato per canonical, Open Graph, sitemap e per il Referer verso Nominatim. |
| `PUBLIC_FIREBASE_API_KEY` | `wrangler.toml`; `.env` (`demo-key`) | chiave web del progetto `appeventi-1e860` (il valore è in `wrangler.toml`) | Pubblica. Non è una chiave segreta: non limita l'accesso ai dati. |
| `PUBLIC_FIREBASE_AUTH_DOMAIN` | `wrangler.toml`; `.env` (`localhost`) | `appeventi-1e860.firebaseapp.com` | Dominio dell'auth. |
| `PUBLIC_FIREBASE_PROJECT_ID` | `wrangler.toml`; `.env` / `.dev.vars` (`demo-eventi`) | `appeventi-1e860` | Anche per le letture REST del server. |
| `PUBLIC_FIREBASE_APP_ID` | `wrangler.toml`; `.env` / `.dev.vars` (`demo-app`) | `1:398100140878:web:...` | ID dell'app web Firebase. |
| `PUBLIC_USE_EMULATORS` | `wrangler.toml` (`"false"`); `.env` e `.dev.vars` (`"true"`) | `true` attiva gli emulatori Auth (127.0.0.1:9099) e Firestore (127.0.0.1:8080) nel browser | Il valore deve essere la stringa `true` per attivarli. |
| `FIRESTORE_EMULATOR_HOST` | `.env`; `.dev.vars` | `127.0.0.1:8080` | Solo lato server: le letture REST vanno all'emulatore e non usano né la API key né l'account di servizio. Non è in `wrangler.toml`. |
| `FIREBASE_READER_SA` | **segreto** di Cloudflare Pages (`wrangler pages secret put`); mai in `wrangler.toml`, `.env` o nel repo | JSON dell'account di servizio `eventi-vicini-reader` (ruolo Cloud Datastore Viewer) | Il Worker legge Firestore con il suo token OAuth (`web/src/lib/server/gauth.ts`). Se manca, ripiega sulla chiave web e sulla lettura pubblica delle regole. Vedi `docs/sicurezza-prossimi-passi.md` per permessi, rotazione e revoca. |
| `CONTACT_EMAIL` | `wrangler.toml` (`eventivicini.info@gmail.com`); `.env.example` (`privacy@example.org`) | indirizzo di contatto | Mostrato in `/privacy` e `/termini` (`web/src/lib/server/legal.ts`). Lato server. |
| `CONTROLLER_NAME` | `wrangler.toml` (`Andrea Azzarello`); `.env.example` (`Mario Rossi (esempio)`) | nome del titolare | Mostrato in `/privacy` e `/termini`. Lato server. |
| `FIREBASE_SERVICE_ACCOUNT` | GitHub: Settings → Secrets → Actions; locale: variabile d'ambiente | contenuto JSON della chiave del service account | **Segreto.** Usato dall'importer. Non committarlo. |
| `GOOGLE_APPLICATION_CREDENTIALS` | variabile d'ambiente sul PC | percorso di un file JSON fuori dal repository | Alternativa locale a `FIREBASE_SERVICE_ACCOUNT`, per l'importer. **Segreto**: il file non va in git. |

Note:

- `wrangler.toml` contiene le stesse variabili pubbliche di produzione. Per il deploy su Cloudflare impostale nella dashboard (vedi [sviluppo.md](sviluppo.md#deploy-su-cloudflare-pages)). Non dare per scontato che il build collegato a git le legga da `wrangler.toml`: va verificato al primo deploy.
- `CONTACT_EMAIL` e `CONTROLLER_NAME` hanno valori di esempio in `.env.example` e `.dev.vars.example`. In produzione devono essere quelli reali.

---

## Firebase Console

### Authentication

Console Firebase → progetto `appeventi-1e860` → **Authentication**:

1. **Metodo di accesso**: abilita **Google** e **Link via email** (accesso con link all'email).
2. **Impostazioni → Domini autorizzati**: aggiungi il dominio `pages.dev` del progetto (`eventi-vicini.pages.dev`) e il dominio proprio, se c'è.

### Regole e indici

Le regole e gli indici sono in `firebase/firestore.rules` e `firebase/firestore.indexes.json`. Il deploy avviene con:

```bash
cd firebase
npm run deploy:rules
```

Lo script esegue `firebase deploy --only firestore:rules,firestore:indexes --project appeventi-1e860`. Serve essere autenticati con Firebase CLI: il repository non contiene il comando di login.

### Admin

L'admin è **eventivicini.info@gmail.com**, con email verificata (`email_verified == true`). Il controllo vero è in `isAdmin()` nelle regole. La stessa email è in `web/src/lib/config.ts` (`ADMIN_EMAIL`) per mostrare l'interfaccia giusta. Per cambiare admin vanno modificate entrambe.

### Regole Firestore

Il modello dati e le motivazioni stanno in `firebase/firestore.rules`. Riassunto:

- **`events`**: lettura e scrittura (creazione, modifica, eliminazione) solo per l'admin. Il pubblico legge gli eventi solo dal Worker, che usa un account di servizio e salta le regole (`web/src/lib/server/gauth.ts`): la chiave web, che è pubblica, non permette di leggere nulla direttamente. L'importer scrive con Admin SDK, che non passa dalle regole, quindi per gli eventi `scraper` il controllo è nel codice dell'importer.
- Ogni evento deve avere i campi previsti, con tipi e limiti di lunghezza (coincidono con `LIMITS` in `web/src/lib/event.ts`). Le URL (immagine, biglietti, fonte) devono essere vuote o `http(s)`, per escludere `javascript:` e `data:`.
- **`submissions`** (proposte degli utenti): creazione da utente autenticato con `status: 'pending'`. Il contatore `pendingCount` dell'autore cambia nello stesso batch della proposta; massimo 5 proposte in attesa. Solo l'admin cambia lo stato, una volta sola (approvata con `eventId`, rifiutata con motivo). L'autore vede le proprie proposte e può ritirarle.
- **`reports`** (segnalazioni, DSA art. 16): creazione aperta a tutti (anche senza account) con campi validati (motivo da elenco chiuso, spiegazione 10-1.000 caratteri, email facoltativa, evento esistente); nessuna lettura pubblica. Solo l'admin legge e decide una volta (`removed` o `dismissed`) con motivazione; le chiuse si cancellano dopo 180 giorni (`tools/importer/cleanup.py`). Decisione: `docs/adr/0002-segnalazioni-create-only.md`.
- **`users/{uid}`**: lettura e modifica solo del proprietario, su pochi campi (nome, città, contatore). Il profilo non si cancella con proposte in attesa. Sotto `favorites/{eventId}` ci sono i preferiti dell'utente, al massimo 200 e 100 modifiche (aggiunte o rimozioni) per giorno UTC: ogni modifica è un batch con un solo preferito più i campi `favCount`, `favChanges`, `favAt` e `lastFavId` del profilo, che le regole confrontano tra loro (stesso schema di `pendingCount`). Un preferito non si aggiorna, si crea o si toglie; con "Elimina account e dati" il profilo sparisce nello stesso batch e i limiti non valgono. I preferiti nati prima dei contatori non sono contati e si possono togliere senza portare `favCount` sotto zero. Quelli che non entrano nel limite restano in `localStorage` (`ev:favorites`) e si sincronizzano ai prossimi accessi, prima gli eventi più vicini nel tempo (`web/src/lib/favLimits.ts`).
- **`coverage/{regione}`**, **`stats/{regione}_{AAAA-MM}`** e **`bundles/*`** (liste precalcolate): lettura solo admin (le pagine pubbliche le leggono dal Worker), scrittura negata a tutti i client (le scrive l'importer con l'Admin SDK).
- Tutto il resto è chiuso (`allow read, write: if false`).

Indici composti: `events` per `geohash` + `endTime`, per `endTime` + `geohash` e per `citySlug` + `endTime`; `submissions` per `ownerId` + `createdAt` e per `status` + `createdAt`.

**Ordine di pubblicazione.** L'indice `endTime` + `geohash` va pubblicato con `npm run deploy:rules` **prima** del deploy della webapp: la webapp lo usa per il limite per cella (`web/src/lib/server/firestore.ts`).
