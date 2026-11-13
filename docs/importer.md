# Importer

Il codice è in `tools/importer/`. Legge gli eventi pubblici dei comuni e li scrive nella collezione `events`.

### Come funziona

1. **Adapter per fonte**: ogni fonte attiva ha un adapter per il suo CMS. Plone (`adapters/plone.py`) legge la API paginata (`++api++/@search`), con una richiesta al secondo. WordPress "Design Comuni Italia" (`adapters/wordpress.py`, CMS `wordpress-dci`) legge `/wp-json/wp/v2/eventi` con una sola richiesta; se l'endpoint manca cerca la route eventi nell'indice `/wp-json/`. Cesena, Ravenna e Serramazzoni non espongono eventi via REST: zero eventi e un avviso. Design Comuni Italia senza API (CMS `design_comuni_html`) legge l'HTML: vedi la sezione seguente.
2. **Normalizzazione** (`mapping.py`): categoria dalla tipologia o dal titolo (parole chiave italiane: kids, food, sport, music, market, culture), prezzo dal testo, fuso `Europe/Rome`, prossima occorrenza per gli eventi ricorrenti, orario reale dal campo `orari` quando quello inserito è fittizio. Si importano gli eventi in corso o che iniziano entro 60 giorni (`--horizon-days`).
3. **Coordinate**: dal campo geolocalizzato della fonte. Se la fonte è fuori dalla provincia del comune, quelle coordinate vengono scartate. Altrimenti Nominatim sugli indirizzi, con comune e provincia nella query (es. "via X, Modena") e il riquadro della provincia come filtro. Se nessun indirizzo si trova, si usa il centro del comune con `approxLocation=true`: la webapp lo mostra come "Luogo da confermare". Cache in `geocache.json`, anche per i "non trovato".
4. **Località su ogni evento**: `enrich()` in `geo.py` scrive `geohash` (precisione 10, stesso algoritmo di `geofire-common`), `city`, `citySlug`, `province` e `region`. Il reverse geocoding è cachato a circa 100 metri. Se Nominatim non risponde, vale la località della fonte.
5. **Id e deduplica**: l'id è l'hash SHA-1 di `sourceUrl` (20 caratteri), quindi lo stesso evento aggiorna lo stesso documento. Due siti che pubblicano lo stesso evento si uniscono con la chiave titolo normalizzato (minuscole, senza accenti né punteggiatura) + giorno + comune.
6. **Scrittura dei soli cambiamenti**: ogni evento ha `contentHash` (sha256 dei campi normalizzati, senza `updatedAt` e campi di servizio) e `importRegion` (regione del registro). All'inizio dell'import una sola query di proiezione (`select`) legge id, `contentHash`, `removedAt`, `missingRuns` e pochi altri campi degli eventi `scraper` delle regioni in elaborazione. Si scrivono, in batch da 400, solo i documenti nuovi o con hash diverso (e quelli da ripristinare dopo un `removedAt`). `createdAt` si conserva. Gli eventi con `source: "manual"` (modificati a mano dall'admin) non vengono mai sovrascritti. A fine import il log riporta letture, scritti, invariati, nascosti. **Se le scritture stimate superano `--max-writes` (15.000) o le letture `--max-reads` (40.000) l'import si ferma prima di scrivere** (codice di uscita 2).

   **Manifest locale**: per non rileggere ogni giorno tutti gli eventi, il confronto parte da `tools/importer/manifests/<regione>.json` (id → campi della proiezione), salvato nella cache di GitHub Actions insieme a `geocache.json`. La lettura di proiezione da Firestore (riconciliazione) avviene solo se il manifest manca, ha più di 8 giorni, non coincide col `token` del documento `importState/<regione>` (scritto prima e dopo ogni import: un run interrotto o una cache persa lasciano un segnaposto) oppure con `--reconcile` (input `reconcile` del workflow). **Scaglionamento**: ogni regione si riconcilia in un giorno fisso della settimana (`ci_report.reconcile_days`, assegnazione deterministica bilanciata per fonti attive) e il budget di letture del job è proporzionale al peso della regione, ×7 nel suo giorno; `python ci_report.py simulate` stampa le quote per giorno (report in `tools/importer/reports/copertura_ondata3.md`). Nel confronto da manifest si rileggono solo gli eventi `manual` e gli id non presenti (nuovi). Se un documento è sparito (`NotFound`), l'import rifà il giro con la riconciliazione completa. Le scritture sono idempotenti, quindi il fallback non crea duplicati né cancellazioni. Il riepilogo indica per regione la fonte del confronto (`manifest` o `firestore`) e le letture effettive.
7. **Scadenza e pulizia**: vedi "Pulizia automatica" qui sotto.
8. **Eventi spariti dalla fonte**: un evento `scraper` che non compare più nella lista di una fonte letta con successo (e inizia entro l'orizzonte) riceve `missingRuns`. Al 2° import consecutivo senza l'evento riceve `removedAt`: la webapp lo nasconde (`web/src/lib/server/firestore.ts`), non lo cancella. Se la fonte non risponde, il conteggio non cambia.

Le fonti sono scaricate in parallelo (4 worker, `WORKERS` in `run.py`); geocoding e scrittura restano in sequenza.

### Ticketmaster (concerti e spettacoli): `adapters/ticketmaster.py`
Discovery API v2, solo Italia, eventi entro 60 giorni, **senza affiliazione**. La fonte esiste solo se `TICKETMASTER_API_KEY` è impostata (secret GitHub; in locale `$env:TICKETMASTER_API_KEY`, mai nel repository né nei log): senza chiave né l'import né i test cambiano. Una fonte per regione (`ticketmaster-<regione>`), regionale: nella deduplica vince quella comunale e prende il `ticketUrl`. Il recupero è nazionale, una volta per processo, a finestre di 7 giorni (si dividono se superano i 1.000 risultati), 2 richieste al secondo, al massimo 300 chiamate per giro (quota Ticketmaster: 5.000 al giorno, 5 al secondo); ogni job della matrice lo ripete, circa 25-30 chiamate a regione. Il comune è quello del luogo (nome e sigla in `web/src/lib/data/comuni.json`, altrimenti il più vicino entro 15 km); senza coordinate: centro del comune, `approxLocation`. `source` resta `scraper`; la webapp riconosce Ticketmaster dall'host di `sourceUrl`.
Termini (letti il 30/10/2026): nessun logo o dicitura obbligatori (e nessun diritto sui marchi: solo il nome in testo); contenuti conservati solo "for reasonable periods" (qui: finché futuri e restituiti dall'API, poi `cleanup.py`); se Ticketmaster chiede di togliere un contenuto, rimuoverlo entro 24 ore (dall'admin); vietato ricavarne ricavi (quindi niente affiliazione né pubblicità); la privacy deve dichiarare i terzi.

Dry-run delle sole fonti Ticketmaster: `python run.py --dry-run --solo-ticketmaster [--regione X]`. Eventi fuori vendita (`offsale`): restano, con il tag `offsale`, e il dettaglio mostra "Biglietti non in vendita" al posto del pulsante.
**Lavoro futuro**: le serie con molte date nella stessa sede (residency: Mengoni 26 date, Einaudi 17) sono una card per data; da raggruppare in una card "più date" con l'elenco nel dettaglio (campo serie nel modello, regole, `bundles.FIELDS`, lista, mappa, dettaglio). Le mostre a biglietto giornaliero sono già unite (`merge_daily`).

### Statistiche mensili: `stats/{regione}_{AAAA-MM}`

Ogni import scrive, per ogni regione elaborata, un documento del mese corrente (ora di Roma) con `events` (eventi attivi nel mese), `comuni` (comuni con almeno un evento), `upcoming` (eventi in corso o futuri oggi entro l'orizzonte, senza unione degli id: scende quando gli eventi finiscono), `cities` (le prime 10 città per eventi) e `name`. L'import vede solo eventi in corso o futuri, quindi il documento conserva anche gli id già contati nei giorni precedenti (campo `ids`, per comune) e li unisce a quelli del giorno: un evento finito a metà mese resta nel totale. Costo: 1 lettura e 1 scrittura per regione al giorno, contate in `reads`/`writes` delle statistiche dell'import. Non si scrivono con `--dry-run` né con `--source`. Il log ha una riga per regione (`Statistiche <regione> <mese>: …`).

La webapp li legge con una `batchGet` a maschera (esclude `ids`) per `/regione/[slug]` (mese corrente e precedente, 2 letture, cache 5 minuti) e con una query client-side per `/admin/statistiche` (solo il mese corrente: totale del mese, `upcoming` e `updatedAt`; niente variazione, perché i primi mesi di raccolta sono parziali). Se il mese corrente non ha dati non si mostra nulla; se manca il precedente si mostra solo il numero del mese. Il confronto è perciò disponibile dal secondo mese di raccolta.

### Adapter HTML `design_comuni_html`

Per i siti Design Comuni Italia senza API degli eventi (`adapters/design_comuni_html.py`). Analisi e fixture: `reports/design_comuni_analisi.md`, `tests/fixtures/html/`.

- **Lista**: `url_eventi` del registro, poi `/vivere-il-comune/eventi/`, `/novita/eventi/`, `/eventi/`, `/evento/`; paginazione `rel=next` (al massimo 5 pagine). Le liste caricate via AJAX ("Carica altri risultati") non si seguono: la sitemap dichiarata in `robots.txt` integra la lista quando mancano eventi.
- **Dettaglio**, in ordine di priorità: JSON-LD `schema.org/Event`, microdata, link "Aggiungi al calendario" (Google Calendar), `.point-list` e Dal/Al, testo libero.
- **Limite**: al massimo 40 dettagli per comune a ogni import (`MAX_DETAILS`).
- **Cortesia**: `robots.txt` prima di ogni richiesta, 1 richiesta al secondo per host, retry con backoff, cache ETag/Last-Modified in `tools/importer/.httpcache` (risposta 304 senza riscaricare).
- **Limiti**: i feed `.ics` non sono letti. Drupal, Joomla, Halley e Maggioli non sono nei campioni analizzati.

### Comandi

```powershell
cd tools\importer
python -m venv .venv
.venv\Scripts\activate            # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python -m pytest -q tests

python run.py --dry-run                 # stampa, non scrive, non servono credenziali
python run.py --dry-run --source modena # una sola fonte (nome = slug del comune)
python run.py --dry-run --regione lombardia --dump lombardia.json   # una regione, eventi in un file JSON
python run.py --regione veneto          # scrive su Firestore solo gli eventi cambiati di una regione
python run.py --stats-out stats.json    # statistiche dell'import (letture, scritture, invariati)
python run.py --max-geocode 1500        # richieste nuove a Nominatim per giro (default 3000)
python run.py --horizon-days 30         # orizzonte diverso (default 60)
python cleanup.py --dry-run             # conta cosa verrebbe eliminato
python cleanup.py                       # elimina eventi e proposte scaduti (al massimo 15.000 al giorno)
python geocode.py --clean               # ripulisce geocache.json, senza chiamare Nominatim
python copertura.py                     # reports/copertura_er.md: stima su campione (1 pagina, sitemap, max 10 dettagli per comune), senza geocoding e senza scrivere
python copertura.py --no-estimate       # solo i conteggi del registro
```

Le credenziali per la scrittura arrivano solo da variabili d'ambiente (vedi [variabili d'ambiente](architettura.md#variabili-dambiente)). Con `GOOGLE_APPLICATION_CREDENTIALS` il file sta fuori dal repository. `.gitignore` esclude i file `*serviceAccount*.json` e `*-firebase-adminsdk-*.json`.

**Migrazione degli eventi esistenti.** `migrate.py` è una tantum: aggiunge `geohash`, `city`, `citySlug`, `province` e `region` agli eventi che non li hanno. Legge l'intera collezione una volta sola e fa il reverse geocoding con la cache. Gli eventi senza coordinate valide vengono elencati: vanno sistemati a mano in `/admin`.

```powershell
python migrate.py --dry-run    # mostra cosa cambierebbe, non scrive
python migrate.py              # scrive
```

**`geocode.py --clean`** toglie da `geocache.json` i "non trovato" (si riprovano alla prossima esecuzione) e i risultati fuori dal riquadro della provincia nominata nella query. Serve dopo aver corretto un riquadro o una query.

**`seed_demo.py`** carica 10 eventi demo con id `demo-01`…`demo-10`; con `--delete` li rimuove. Funziona **solo con l'emulatore Firestore**: `FIRESTORE_EMULATOR_HOST` deve essere impostato su `127.0.0.1`, `localhost` o `[::1]`, altrimenti lo script si ferma con un errore. Usa il progetto `demo-eventi` e non legge le credenziali, quindi non può scrivere sul progetto reale. Con l'emulatore avviato (`npm run emulators`, da `web/`):

```powershell
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
python seed_demo.py
```

### GitHub Action

`.github/workflows/import-events.yml`:

- Esecuzione ogni giorno alle **08:17 UTC**, cioè 09:17 in Italia con l'ora solare e 10:17 con l'ora legale (senza `timezone`). L'avvio puntuale è il Cron Trigger di un Worker Cloudflare gratuito (`scheduler/`, `17 8 * * *`) che lancia il workflow con `workflow_dispatch` e `auto=true`; il cron di GitHub (`17 10 * * *`) è una riserva e un job `guard` salta l'avvio se l'import completo di oggi è già partito (vedi `scheduler/README.md`). Va dopo il reset della quota Firestore (mezzanotte del Pacifico = 07:00 o 08:00 UTC, 08:00/09:00 in Italia): così l'import non intacca le letture del giorno prima.
- Avvio manuale: **Actions → Import eventi → Run workflow**, con le opzioni `dry_run` e `regione` (slug, per esempio `lombardia`).
- Job `plan`: gira `pytest` e `ci_report.py matrix`, che elenca le regioni con almeno una fonte attiva e divide le soglie di quota tra i job.
- Job `import`: **una matrice per regione**, 4 in parallelo (`max-parallel: 4`), timeout 330 minuti (limite GitHub 360). Ogni job ha `NOMINATIM_INTERVAL=4`, cioè 0,25 richieste al secondo: quattro job insieme restano a 1 richiesta al secondo in tutto, come chiede la policy di Nominatim. `geocache.json` e `.httpcache` sono salvati con `actions/cache` **per regione** (chiave `importer-<regione>-<run>`).
- Job `cleanup`: gira dopo gli import, anche se una regione è fallita, ed esegue `cleanup.py`.
- Un solo riepilogo in `GITHUB_STEP_SUMMARY` (job `cleanup`): eventi per regione, letture, scritture, invariati, richieste di geocoding, e le quote Spark usate.
- Durata: i repository pubblici hanno minuti gratuiti sui runner standard; il limite di GitHub per job è 6 ore. Il tempo dominante sono le richieste ai siti dei comuni (1 al secondo per host) e il geocoding (vedi [quote-firestore.md](quote-firestore.md)).
- Il dry-run limita il geocoding a 20 richieste nuove per regione (`--max-geocode 20`) e `Geocoder(strict=True)` applica il budget anche alle richieste «essenziali» (centro del comune): nulla di ciò che chiede a Nominatim si salverebbe. Gli eventi senza posizione in cache restano senza coordinate, quindi il conteggio del dry-run può essere un po' più basso di un import vero.
- Concorrenza: gruppo `import-events`, senza annullare l'esecuzione in corso.
- Secret richiesto: **`FIREBASE_SERVICE_ACCOUNT`** (Settings → Secrets and variables → Actions). Il valore è l'intero JSON della chiave del service account.

Per generare la chiave: Console Firebase → Impostazioni progetto → Account di servizio → Firebase Admin SDK → Genera nuova chiave privata. Il file va spostato fuori dal repository. Per revocarla: Google Cloud Console → IAM → Account di servizio → scheda Chiavi → elimina la chiave, poi aggiorna il secret.

### Fonti che non rispondono
- A fine giro le fonti che non hanno risposto (timeout, `robots.txt` non raggiungibile) si **riprovano una volta** dopo 5 minuti (`--retry-wait`, 0 = subito, -1 = mai). L'esito è nella tabella per comune.
- Una fonte che resta muta **non azzera il comune**: `coverage/{regione}` mantiene i dati di ieri (`coverage_doc(previous, failed)`, una lettura per regione interessata) e i suoi eventi restano in Firestore (non vengono nascosti, vedi `ok_hosts`).
- **Scala per host** (`unreachable.py`): un host che non si connette si ricorda tra un run e l'altro (`unreachable.json`, nella cache di Actions) e si riprova dopo 1, 3, 7 giorni (poi ogni 7). Il parcheggio si applica solo ai siti dei Comuni, non alle fonti regionali.
- **Cluster di rete** (`clusters.py`, `netcluster.py`): molti siti dei Comuni stanno sullo stesso hosting e smettono di rispondere insieme (il 7/11/2026 tutte le 91 fonti su 93.56.55.0/24 dal runner, mentre da un PC italiano rispondevano). Per ogni subnet (/24 IPv4, /48 IPv6) con almeno **5 fonti** nel giro si provano **2 sentinelle** su host diversi (si preferiscono host senza fallimenti e con l'ultimo successo più recente). Se nessuna si connette il resto della subnet **non si tenta e non si parcheggia**: la scala dei singoli host non avanza e la voce `net:<subnet>` in `unreachable.json` ricorda da quando è giù. Alla prima sentinella che risponde la voce sparisce e si azzerano i parcheggi degli host del gruppo (anche, per lo stato di prima, se almeno 5 erano fermi); pochi host morti in una subnet sana tengono la loro scala. In `health.json` resta la durata di ogni interruzione.
- **Limiti per IP e subnet** (`NetGate`, condiviso da tutti i `Fetcher`): al massimo 1 richiesta al secondo per IP (`--ip-interval`, anche con host diversi sullo stesso IP), 2 richieste in volo per subnet (`--subnet-concurrency`) e una pausa di 60 secondi della subnet dopo 3 timeout di connessione consecutivi. Le fonti si scaricano a rotazione per subnet, così i 4 worker non si concentrano su un solo fornitore. Nel workflow l'input `ip_interval` (vuoto = 1,0) permette di confrontare due valori con due dry-run. Il log finale (`Rete: …`) e `--stats-out` riportano l'attesa totale per i limiti e il picco di richieste al minuto per IP.
- **Salute delle fonti** (`health.json`, in una cache a parte, `importer-health-<regione>-<run>`: l'elenco dei percorsi della cache principale non va cambiato, altrimenti le cache già salvate non si ripristinano più): `lastOkAt`, `lastEventsAt`, serie di fallimenti, ultimo errore e ultime interruzioni di rete. Come `unreachable.json` **non si salva nel dry-run** (ticket #16): il passo di cache del dry-run è solo di ripristino e `run.persist_state` non scrive nulla con `--dry-run`.
- Il riepilogo del workflow elenca le fonti saltate (comune, regione, eventi di ieri, errore) e il job emette un'annotazione `::warning` se sono **più del 5%** delle fonti o se salta un comune con **più di 50 eventi** (una fonte regionale vale il totale della regione). Il job resta verde: l'avviso compare in cima alla pagina dell'esecuzione.

### Metriche di copertura

Il riepilogo del job `cleanup` ha una sezione **Copertura** per regione (`ci_report.coverage_report`, dati da `run.coverage_metrics`, nessuna lettura Firestore in più):

| metrica | significato |
|---|---|
| eventi oggi | estratti in questo import (la colonna «eventi» della prima tabella) |
| eventi visibili | eventi dei comuni nel documento `coverage`, compresi quelli che le fonti saltate lasciano in Firestore. È una **stima**: il numero di una fonte ferma resta quello dell'ultimo giorno in cui ha risposto |
| comuni con eventi | comuni del documento `coverage` con almeno un evento, su quelli noti |
| fonti, in errore, parcheggiate, in cluster | stato delle fonti del giro |
| ultimo successo più vecchio | età in giorni del `lastOkAt` più vecchio, e quante fonti non sono mai riuscite |

Se una subnet è giù compare anche l'elenco dei cluster non raggiungibili, con la data di inizio. Confrontando due giorni si guarda **eventi visibili**: gli «eventi oggi» calano quando le fonti saltano, anche se i loro eventi restano in Firestore.

### Pulizia automatica

`cleanup.py` gira ogni giorno dopo l'import. Le query usano solo indici a campo singolo, con proiezione dei campi.

| cosa | quando si elimina |
|---|---|
| eventi `scraper` | finiti da più di 7 giorni |
| eventi con `removedAt` | da più di 30 giorni |
| eventi `manual` e `user` | finiti da più di 30 giorni |
| proposte rifiutate | `reviewedAt` da più di 90 giorni |
| proposte approvate | `reviewedAt` da più di 30 giorni |

Le cancellazioni sono a lotti da 400 e non superano `--max-deletes` (15.000 al giorno, la quota Spark è 20.000): il resto passa al giorno dopo. Le proposte `pending` non si toccano mai.

### Registro delle fonti: `sources/<regione>.csv`

Un file per regione (`emilia-romagna.csv`, `lombardia.csv`, …). `registry.read_rows()` li legge tutti; `write_rows()` li riscrive divisi per regione. Il file è in UTF-8 con BOM, separatore `;`, si apre in Excel. Colonne:

`regione;provincia;comune;codice_istat;sito;url_eventi;cms;fornitore;stato;licenza;robots_ok;note`

`fornitore` è la piattaforma riconosciuta da `detect_cms.py` (WordPress, Drupal, ComWeb, ASP.NET, ecc.), vuota se non si capisce. Compare nel riepilogo `--report` e in `copertura.py`.

Stati (colonna `stato`):

| stato | significato |
|---|---|
| `da_verificare` | riga nuova o dubbia. Gli script la analizzano, ma non è attiva. |
| `candidato` | CMS supportato, robots.txt consente l'accesso e la licenza è aperta. Serve la tua conferma. |
| `escluso` | robots.txt vieta l'accesso, oppure la licenza è restrittiva (NC/ND, riservata). |
| `attivo` | l'importer legge questa fonte. Lo imposta `activate.py` con la regola automatica (vedi sotto) o tu a mano. |
| `manuale` | gestita a mano. Gli script automatici non la toccano mai. |

Stato al momento della stesura (da `comuni.csv`, 330 comuni): 4 `attivo` (Formigine, Mirandola, Modena, Sassuolo, tutti Plone), 23 `candidato`, 274 `da_verificare`, 29 `escluso`. Per CMS: 52 `plone`, 21 `wordpress-dci`, 237 `altro`, 20 `irraggiungibile`.

**`build_registry.py`** genera o aggiorna il registro dagli open data:

- comuni da ISTAT, "Elenco dei comuni italiani" (CC BY 4.0);
- siti istituzionali da IndicePA, "Amministrazioni" (CC-BY 4.0).

Si indica `--regione <nome>` (ripetibile) oppure `--tutte`; senza argomenti dà errore. Le righe `attivo` e `manuale` non vengono toccate. Le altre aggiornano regione, provincia, comune e sito. I comuni nuovi entrano come `da_verificare`. Se il sito cambia, il rilevamento precedente viene azzerato.

**`detect_cms.py`** visita i siti del registro:

- Rispetta `robots.txt` prima di ogni richiesta. Se il robots.txt non è raggiungibile (errore 5xx o rete), non visita nulla.
- Al massimo 1 richiesta al secondo per sito. User-Agent identificativo (`EventiVicini-importer/1.0`).
- Riconosce il CMS: `plone` (design-comuni-plone), `wordpress-dci` (design-comuni-italia o design-comuni-wordpress), `design_comuni_html` (modello Design Comuni dai marcatori dell'HTML, senza API) oppure `altro`.
- Cerca la pagina eventi e la pagina delle note legali, e ricava la licenza dal loro testo (o dal piè di pagina, come ripiego).
- Non tocca mai le righe `attivo` o `manuale`. Non attiva nessuna fonte: al massimo propone `candidato`.

```powershell
cd tools\importer
python detect_cms.py                  # righe non ancora analizzate
python detect_cms.py --comune Modena  # una riga (ripetibile)
python detect_cms.py --force          # rianalizza anche le righe già fatte
python detect_cms.py --report         # solo il riepilogo, senza visitare nulla
python detect_cms.py --regione lombardia --regione veneto   # solo queste regioni
```

Usa la cache HTTP (`.httpcache`, risposte 304) e, a fine giro, riprova una volta i siti `irraggiungibili`.

Solo fonti con licenza che consente il riuso (CC0, CC-BY, CC-BY-SA, IODL). Mai testate giornalistiche o siti commerciali.

### Comuni per la ricerca: `build_comuni.py`
Genera `web/src/lib/data/comuni.json` (tutti i comuni: nome, nome nell'altra lingua, sigla, centro, popolazione, slug degli omonimi con la sigla). Elenco e nomi bilingui da ISTAT (CC BY 4.0); coordinate e popolazione da Wikidata (CC0, una query SPARQL), uniti per codice ISTAT e, dove i codici non coincidono (Sardegna dopo la riforma), per nome. `python build_comuni.py` usa la cache in `.httpcache/`, `--refresh` riscarica. Il test (`tests/test_build_comuni.py`) verifica il numero di comuni, gli slug unici e che ogni centro cada nel riquadro della sua provincia (per la Sardegna, in quello dell'isola). Il sito carica il file solo al primo uso della barra di ricerca.

### Licenze: `licenses.py`

`python licenses.py` verifica la licenza dei contenuti dei siti candidati (più Modena, Formigine, Sassuolo e Mirandola). Cerca le pagine di note legali e privacy, estrae la frase sulla licenza e scrive `reports/licenze_er.md`. Legge il `robots.txt` con `protego`, con 1 richiesta al secondo per sito. Aggiorna le colonne `licenza` e `note` dei CSV, mai `stato`; `--no-csv` non tocca i CSV. `--regione` limita a una regione. La nota comincia con `licenza[attivare|da|escludere]` (la raccomandazione) e, se il sito contiene "esclusiva proprietà" o "tutti i diritti riservati", con `conflitto`: `activate.py` legge questi marcatori. Le etichette `CC-BY-NC` e `CC-BY-ND` sono distinte. Le licenze "non chiara" o "non trovata" vanno lette a mano. Per tutti i comuni con un CMS: `python licenses.py --cms design_comuni_html --out reports/licenze_design_comuni.md` (non solo i candidati).

### Attivazione automatica: `activate.py`

Regola approvata, applicata a tutte le righe `da_verificare` e `candidato` (mai a `manuale`, `escluso` e `attivo`). Una riga diventa `attivo` **solo se**:

- a) esiste un adapter per il suo CMS (`plone`, `wordpress-dci`, `design_comuni_html`);
- b) `licenses.py` ha trovato la licenza dei **contenuti** (formula AGID sulle note legali): CC0 o CC-BY, senza NC, ND, SA, "esclusiva proprietà" o "tutti i diritti riservati";
- c) il `robots.txt` permette i percorsi usati (colonna `robots_ok` e controllo di `licenses.py`);
- d) il dry-run del comune produce almeno 1 evento futuro valido: titolo, date e coordinate dentro la provincia (se la fonte non dà le coordinate vale il centro del comune, una richiesta a Nominatim per comune).

Le altre restano `da_verificare` con il motivo all'inizio della colonna `note` (`attivazione: …`). Ordine dei comandi per una regione nuova:

```powershell
python build_registry.py --regione Lombardia
python detect_cms.py --regione lombardia
python licenses.py --regione lombardia --out reports/licenze_lombardia.md
python activate.py --regione lombardia --dry-run   # tabella senza scrivere
python activate.py --regione lombardia
```

### Ricontrollo settimanale: `recheck-sources.yml`

Molti comuni sono respinti con "nessun evento futuro valido" solo perché in quel momento non avevano eventi (fuori stagione). Ogni **domenica alle 23:00 ora italiana** il workflow riesegue `activate.py --tutte --only-reason "nessun evento futuro valido"`: rivaluta solo le righe `da_verificare` respinte per quel motivo e attiva quelle che ora rispettano **tutte** le condizioni a–d (le condizioni a–c sono quelle già registrate nel CSV, non vengono ricontrollate sui siti; il dry-run sì).

- Riepilogo in `GITHUB_STEP_SUMMARY`: per regione, comuni rivalutati, attivati (con i nomi) e ancora respinti.
- Se qualcosa cambia, il workflow fa il commit di `tools/importer/sources/*.csv` ("Ricontrollo settimanale: attivate N fonti…") e lo manda a `main` con `GITHUB_TOKEN` (permesso `contents: write`). L'import del lunedì mattina (08:17 UTC) trova le nuove fonti già attive. Se `main` ha una regola di protezione che vieta il push al bot, il passaggio di commit fallisce: consenti al bot o apri una PR a mano.
- Avvio manuale: Actions → Ricontrollo fonti → Run workflow (con `dry_run` non modifica nulla). Stessa cosa in locale: `python activate.py --tutte --only-reason "nessun evento futuro valido" --dry-run`.
- Durata stimata 1-2 ore con circa 1.000 comuni (12 in parallelo, 1 richiesta al secondo per sito); timeout 240 minuti. Il commit del bot non rilancia altri workflow.

### Attivare una fonte a mano

1. Verifica a mano la pagina eventi, le note legali (licenza, obbligo di citare la fonte, uso non commerciale se previsto) e il `robots.txt`.
2. Controlla che il CMS sia `plone`, `wordpress-dci` o `design_comuni_html`. L'importer legge solo i CMS con un adapter: una riga con un altro CMS viene saltata con un avviso.
3. Nel CSV imposta `stato` a `attivo` e compila le note con la verifica fatta.
4. Prova con `python run.py --dry-run --source <slug>`. Lo slug è il nome del comune in minuscolo con trattini (es. `modena`).

### Schema evento: file di parità

Lo schema dell'evento è scritto a mano in tre posti: l'importer (`mapping.py`, `geo.py`, adapter), il web (`web/src/lib/event.ts`) e le regole (`firebase/firestore.rules`). Il file `docs/schema/parity.json` li tiene allineati: elenca categorie, tipi di prezzo, valori di `source`, campi comuni (`eventKeys`), campi opzionali (`eventOptionalKeys`), campi scritti solo dall'importer (`importerOnlyKeys`), `HASH_SKIP`, tag «bambini» e una tabella di casi per `slugify` (almeno 20, identici in Python e TypeScript). Non è letto dal codice dell'app: lo leggono solo tre test, che falliscono se uno dei tre posti cambia e gli altri no.

| Test | Comando | Cosa confronta |
|---|---|---|
| `tools/importer/tests/test_schema_parity.py` | `python -m pytest -q tests` (da `tools/importer/`) | categorie e prezzi che l'importer può produrre, campi di un evento reale (fixture Plone + `enrich`), `HASH_SKIP`, `slugify` |
| `web/src/lib/schema-parity.test.ts` | `npm test` (da `web/`) | `CATEGORIES`, `PRICE_TYPES`, `EVENT_KEYS`, campi di `fromData`, `slugify`, `isForKids` |
| `firebase/test/parity.test.js` | `npm test` (da `firebase/`, Java 21) | testo di `firestore.rules` (`eventKeys()`, categorie, prezzi, `source`, `hasOnly`) e comportamento sull'emulatore |

Come aggiornarlo:
1. **Nuova categoria o tipo di prezzo**: aggiungila nello stesso commit a `parity.json`, `CATEGORIES`/`PRICE_TYPES` in `event.ts` (con l'etichetta), alle liste `d.category in [...]` / `d.priceType in [...]` di `firestore.rules` e al punto dell'importer che la produce (`CATEGORY_BY_TYPE`, `KEYWORDS`, adapter). Poi i tre comandi della tabella.
2. **Nuovo campo dell'evento**: `parity.json` (`eventKeys`, oppure `eventOptionalKeys` se facoltativo), `EventInput` e `EVENT_KEY_MAP` in `event.ts` (`npm run check` ricorda di tenerli uguali), `eventKeys()` o `hasOnly(...)` in `firestore.rules`, l'adapter o `run.py` che lo scrive. Se il campo cambia a ogni giro e non fa parte del contenuto, aggiungilo anche a `HASH_SKIP` e a `hashSkip`.
3. **Campo scritto solo dall'importer** (Admin SDK, senza passare dalle regole): mettilo in `importerOnlyKeys`. Oggi c'è `cityAlt` (vedi #46): l'admin non lo riscrive e le regole non lo ammettono.
4. **Nuovo caso di `slugify`**: aggiungi `{ "in": ..., "out": ... }` calcolando `out` con `geo.slugify` (Python); se TypeScript dà un risultato diverso, il test web fallisce e va allineata l'implementazione.

I test delle regole estraggono le liste dal testo con espressioni regolari: se riscrivi la forma di `eventKeys()` o dei controlli `in [...]` e un'espressione non trova più nulla, il test fallisce con un messaggio esplicito (aggiornala), non passa in silenzio.

### Aggiungere un adapter per un nuovo CMS

L'interfaccia è in `adapters/base.py`, un `Protocol` con gli attributi `name`, `city`, `province`, `region`, `viewbox` e il metodo `events(client, now, horizon_days)`. Il metodo restituisce dict nel modello dell'app, con almeno: `id`, `title`, `shortDescription`, `category`, `priceType`, `startTime`, `endTime` (ms), `venueName`, `address`, `lat`, `lng` (`None` se da geocodificare), `imageUrl`, `ticketUrl`, `tags`, `source` (`"scraper"`), `sourceUrl` e `_geocode` (indirizzi da provare con Nominatim, in ordine).

Passi:

1. Crea `adapters/<cms>.py` con una classe che implementa l'interfaccia. Imposta `id` (ad esempio `mapping.event_id(sourceUrl)`): `run.py` lo richiede. La docstring di `base.py` dice "senza id", ma `write()` usa `ev["id"]`.
2. In `adapters/__init__.py`, in `load_sources()`, aggiungi un ramo per il valore `cms` del CSV, oltre a quello di `plone`, e il nome in `CMS_ADAPTERS` (lo legge anche `activate.py`).
3. Scrivi un test con una fixture salvata, in `tests/`.

`mapping.to_event()` è specifico per il formato Plone. Un nuovo adapter non lo riusa: produce il suo dict. Geocoding, località, geohash, deduplica e scrittura restano in `run.py`.

**Stato attuale:** adapter per Plone (`plone`), WordPress Design Comuni Italia (`wordpress-dci`) e Design Comuni HTML senza API (`design_comuni_html`). Gli altri CMS non sono importabili.
