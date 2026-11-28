# Changelog

Formato ispirato a [Keep a Changelog](https://keepachangelog.com/it/). Le versioni sono ricostruite dalla cronologia dei commit.

## [Non rilasciato]

### Aggiunto
- Importer, ritento automatico: se `run.py` esce con 1 (nessun evento raccolto, come Molise il 27 e 28/11 con la lista dei Comuni vuota a intermittenza) `ci_report.py retry` lo ripete una volta dopo 300 s, nello stesso job; quota superata (2) e timeout non si ritentano. L'annotazione `::error` compare solo se anche il ritento fallisce. Input `forza_errore`/`forza_sempre` per provarlo con un dry-run. L'adapter `design_comuni_html` registra una riga di diagnosi (rete o cache, byte, titolo, card) quando la lista non dà link.
- Importer: fonte regionale «Eventi a Firenze» (dataset aperto del Comune di Firenze, CC BY 4.0, GeoJSON da datigis.comune.fi.it) con `FirenzeAdapter`; attribuzione «Comune di Firenze» nel dettaglio evento.
- Home mobile (#22, parte): selettore Lista/Mappa a controllo segmentato a tutta larghezza, con la metà attiva piena e l'altra neutra, agganciato sotto l'header (`--header-offset`); safe area di iPhone (header, margini laterali, scheda mappa) e `svh`/`dvh` al posto di `vh`; select della distanza alto quanto i chip e sfumatura di scorrimento a destra della riga dei filtri (maschera alfa, unica eccezione ai gradienti in `design.test.ts`); riquadro iniziale con la riga del luogo che va a capo solo tra «N eventi · entro X km» e «da luogo» e più basso sotto 400 px. e2e `home-mobile.spec.ts` su Pixel 7 e su un nuovo progetto WebKit (iPhone 15), screenshot di revisione `review-home-mobile.spec.ts`.
- Micro-movimento, senza librerie: battito del cuore quando si aggiunge un preferito (CSS), uscita e entrata della scheda mappa con `svelte/transition` (durate lette dai token da `lib/motion.ts`, nessuna animazione durante trascinamento o zoom), entrata dei toast con `@starting-style`. Con `prefers-reduced-motion` tutto a durata zero. Alla chiusura della scheda il focus torna al marker solo se era nella scheda. Controllo in `design.test.ts` contro le durate fisse nei parametri delle transizioni Svelte, ed e2e `motion.spec.ts`.
- Movimento: passaggio card → dettaglio evento con le View Transitions (il riquadro della card si allarga nella testata), senza librerie né cookie; solo da clic su un collegamento, con supporto del browser e senza `prefers-reduced-motion`. Token `--dur-view` (250 ms), voce «Movimento» in `DESIGN.md`, controllo delle durate in `design.test.ts` ed e2e `view-transition.spec.ts`.
- Ricerca su tutti i comuni italiani (~7.900, da ISTAT e Wikidata): file statico caricato al primo uso della barra, nomi bilingui, abbreviazioni (S. / San), omonimi con la sigla della provincia, `?luogo=` per qualsiasi comune senza letture Firestore.
- Raggio allargato in automatico (50 o 100 km) dove non ci sono eventi vicini, con avviso; senza eventi nemmeno a 100 km, messaggio e comuni più vicini.
- `tools/importer/build_comuni.py` e test del dataset.
- Importer: le fonti non raggiungibili si riprovano a fine giro e non azzerano più il comune in copertura (restano i dati di ieri); il riepilogo CI elenca le fonti saltate e avvisa (`::warning`) se superano il 5% o se salta un comune con più di 50 eventi.
- `scheduler/`: Worker Cloudflare gratuito (Cron Trigger 08:17 UTC) che avvia l'import via `workflow_dispatch`; il cron di GitHub passa alle 10:17 come riserva e il job `guard` (riconosce l'import dagli input nel nome del job, non dal titolo) salta l'avvio se l'import completo di oggi è già partito.
- Province sarde della riforma (OT, OG, VS) in `provinces.json`.
- Importer, resilienza di rete: limiti per IP e subnet (1 richiesta al secondo per IP, 2 in volo per /24, pausa di 60 s dopo 3 timeout), fonti scaricate a rotazione per subnet e **cluster di rete** gestiti con due sentinelle senza parcheggiare i singoli host (prima, un fornitore irraggiungibile teneva ferme per giorni decine di fonti). Opzioni `--ip-interval` e `--subnet-concurrency`, input `ip_interval` nel workflow.
- Importer, metriche di copertura nel riepilogo CI: eventi visibili, comuni con almeno un evento, fonti in errore/parcheggiate/in cluster, età dell'ultimo successo (`health.json`), subnet giù e attesa per i limiti.
- Test di caratterizzazione di `collect()` e di `unreachable.py` (#26, prima parte).

### Modificato
- Con `--dry-run` l'importer non scrive più `unreachable.json` né `health.json` (ticket #16, anche per le voci `net:<subnet>`).
- Dry-run dell'importer: geocoding limitato a 20 richieste nuove per regione, con budget valido anche per le richieste essenziali (`Geocoder(strict=True)`); `health.json` ha una cache separata, così le cache già salvate restano compatibili.

## [1.0.0] - 2026-10-30

Prima versione pubblica, su tutta Italia.

### Aggiunto
- **Bundle delle liste**: l'importer scrive liste precalcolate per cella geohash e per città (`bundles/*`), la webapp legge una sola volta per cella invece di una query per visita; regole in sola lettura pubblica.
- Cache a due livelli nel Worker (memoria e Cache API di Cloudflare), con copia vecchia se la quota Firestore è esaurita.
- Import giornaliero alle 08:17 UTC, dopo il reset della quota Firestore.
- File di progetto: README rifatto, licenza MIT, SECURITY, CONTRIBUTING, brand kit e documentazione tecnica in `docs/`.

### Modificato
- Repository rinominato in `EventiVicini`; User-Agent dell'importer e del geocoder aggiornati.

## [0.5.0] - 2026-10-28 · Redesign sobrio e statistiche

### Aggiunto
- Design system ([`DESIGN.md`](DESIGN.md)): carta calda e notte calda, accento terracotta, titoli in Fraunces, card a biglietto, lista per sezioni di tempo, mappa con pin per categoria e cluster, icone Lucide, controllo automatico dei token.
- Statistiche mensili per regione (`stats/*`) e confronto mensile nelle pagine regione.
- Ricerca unificata di eventi e luoghi con luogo nell'URL; comuni bilingui.

## [0.4.0] - 2026-10-27 / 28 · Tutta Italia

### Aggiunto
- Registro delle fonti per regione (ISTAT e IndicePA) per le 20 regioni, rilevamento del CMS e delle licenze, attivazione automatica con regola (adapter, licenza CC0/CC-BY, robots.txt, evento valido) e ricontrollo settimanale.
- Seconda e terza ondata: Piemonte, Valle d'Aosta, Liguria, Friuli-Venezia Giulia, Trentino-Alto Adige, Marche, Umbria, poi Lazio, Abruzzo, Molise, Campania, Puglia, Basilicata, Calabria, Sicilia, Sardegna. Adapter Open Data Hub Alto Adige.
- Import a matrice per regione su GitHub Actions, manifest locale degli hash, riconciliazioni scaglionate, geocoding con budget, filtro anti-avvisi.
- Scelta di regione e comune al primo accesso; copertura per regione.

## [0.3.0] - 2026-10-27 · Prima ondata e scritture minime

### Aggiunto
- Scrittura dei soli cambiamenti (`contentHash`), tetti di quota (`--max-writes`, `--max-reads`), pulizia automatica del database, eventi spariti dalla fonte nascosti.
- Adapter WordPress e HTML Design Comuni Italia; prima ondata Lombardia, Veneto, Toscana.

## [0.2.0] - 2026-10-26 / 27 · Webapp SvelteKit

### Cambiato
- Migrazione da Flutter a **SvelteKit su Cloudflare Pages**; l'app Flutter è archiviata nel tag `flutter-legacy`.

### Aggiunto
- Lista, mappa e filtri con SSR, pagine per città, PWA installabile con pagina offline.
- Account facoltativo (Google o link email), preferiti, proposte di eventi, area admin.
- Regole Firestore riscritte e testate; importer Python per i comuni di Modena, Formigine, Sassuolo e Mirandola (API Plone) con geocoding Nominatim.

## [0.1.0] - 2025-08 / 2026-10-26 · App Flutter

- Prima app Flutter (Firebase, mappa, calendario), poi archiviata.
