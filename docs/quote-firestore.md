# Quote e letture Firestore

Quote del piano Spark al giorno: 50.000 letture, 20.000 scritture, 20.000 cancellazioni, 1 GB.

### Misure sull'emulatore (`npm run test:reads`, dati di seed)

A freddo (cache vuota). «Reali» = massimo con dati veri (somma dei `limit` delle query). Il test fallisce se una rotta supera il suo budget.

| rotta | prima (query): seed / reali al massimo | dopo (bundle): letture | richieste |
|---|---|---|---|
| `/` senza luogo | 4 / 4 | 1 | 1 |
| `/?luogo=modena` (25 km) | 11 / 504 | 11 (1 copertura + 10 celle) | 2 |
| `/?luogo=bologna&r=100` | 20 / 1.504 | 84 (celle) | 2 |
| `/?luogo=sconosciuto` | 6 / 124 | 2 | 2 |
| `/api/events` (stessa chiave della home) | 7 / 500 | 11 | 2 |
| `/api/places` | 4 / 4 | 1 | 1 |
| `/citta/modena` | 4 / 201 | 2 (copertura + città) | 2 |
| `/regione/emilia-romagna` | 3 / 3 | 3 | 2 |
| `/eventi/[slug]` | 1 / 1 | 1 | 1 |
| `/sitemap.xml` | 14 / 504 | 2 | 2 |
| ripetizione, o stessa cella ~5 km | 0 | 0 | 0 |

Con i bundle le letture non dipendono più dal numero di eventi ma dalle celle (28×19 km) che toccano il cerchio: la home a 25 km ne legge 9-10 (più la copertura), 50 km circa 25, 100 km circa 85. Quest'ultima è l'unico caso lontano da «≤ 10»: costa una volta ogni 6 ore per punto della griglia, poi zero. Una cella con molti eventi si divide in più documenti (700 KB l'uno) e conta una lettura per documento.

**Bundle** (`tools/importer/bundles.py`, collezione `bundles`): a fine import l'importer scrive `g_<geohash4>` (celle), `c_<città>`, `sitemap` (i 500 eventi che finiscono prima) e `coverage` (tutte le regioni). Contengono solo i campi di card e mappa (non descrizione né link), ripartono dal bundle già scritto (un import parziale non cancella le altre regioni) e si riscrivono solo se l'hash cambia. La webapp li usa se esiste `bundles/coverage`; finché manca ripiega sulle query come prima. Limiti: gli eventi creati o approvati dall'admin entrano al prossimo import (al massimo 24 ore); la ricerca testuale non vede la descrizione degli eventi; un evento che cambia cella resta anche in quella vecchia fino alla fine.

**Scritture dei bundle, tutta Italia (stima, non misurata).** Circa 650 celle con eventi e fino a 3.000 città: nel giorno peggiore (tutti i bundle cambiano) 650-800 + 3.000 + 2 ≈ 3.800 scritture; in un giorno tipico solo i bundle con eventi nuovi o scaduti, 1.000-2.000. L'importer le conta nel tetto `--max-writes` (15.000, eventi inclusi) e, se non bastano, salta prima le città, poi le celle. Documenti totali circa 4.000; peso circa 300 byte per evento (un import da 40.000 eventi attivi pesa 12 MB in tutto).

**Cache a due livelli** (`lib/server/firestore.ts`): memoria dell'isolate e Cache API di Cloudflare (per data center, vale anche tra isolate e deploy). Liste 3 ore, evento/copertura 1 ora, sitemap 12 ore. Le chiavi delle liste portano la `version` di `bundles/coverage` (scritta dall'importer per ultima a ogni giro): dopo un import le liste si rileggono comunque, e il TTL protegge solo da modifiche fuori import. **Mai in cache liste incomplete** (parte `~k` di un bundle mancante, query longRunning fallita, lista vuota mentre la copertura dice che lì ci sono eventi): né memo né Cache API, risposta `no-store`. Una cella senza bundle è normale (nessun evento) e si memorizza. Scaduta la freschezza si rilegge; se Firestore risponde 429 (quota esaurita) o è giù si serve l'ultima copia (fino a 2 giorni) e per 10 minuti non lo si richiama. Home e `/api/events` interrogano lo stesso punto della griglia di ~5 km, quindi condividono la chiave. Le pagine HTML restano a 5 minuti all'edge (vedi il punto 7 del deploy): costano zero letture perché i dati sono già in cache.

Limite noto: la Cache API è per data center, non globale. Rischio non verificato: il tempo di CPU del Worker (10 ms nel piano gratuito) per leggere in JSON le celle più dense di Roma e Milano.

### Import a regime (dry-run di Emilia-Romagna, Lombardia, Veneto, Toscana)

| regione | comuni attivi | eventi | 1° import: letture / scritture | 2° giorno: letture / scritture |
|---|---|---|---|---|
| Emilia-Romagna | 66 | 505 | 506 / 506 | 506 / 1 |
| Lombardia | 255 | 1.405 | 1.406 / 1.406 | 1.407 / 1 |
| Veneto | 157 | 738 | 739 / 739 | 739 / 1 |
| Toscana | 54 | 220 | 221 / 221 | 221 / 1 |
| **Totale** | **532** | **2.868** | **2.872 / 2.872** | **2.873 / 4** |

Le scritture del secondo giorno sono il documento `coverage/{regione}` (una per regione); in pratica si aggiungono gli eventi nuovi o modificati del giorno (qualche punto percento). Le letture dell'import sono gli eventi scraper della regione già presenti, compresi quelli finiti da meno di 7 giorni (circa +30%). Con la pulizia (alcune centinaia di letture e cancellazioni) siamo sotto il 10% della quota di letture e sotto il 5% di quella di scritture e cancellazioni. Il primo import di una regione grande va fatto a tappe (vedi `FINAL_REPORT.md`).

### Stima dalle formule (traffico)

Stima ricavata dal codice (`web/src/lib/server/firestore.ts`, `cache.ts`, `geo.ts`, `api/events`).

**Come si legge una ricerca per raggio.** `eventsNear(centro, km)` chiama `radiusBounds`, che usa `geohashQueryBounds` di `geofire-common`. Questa funzione genera 9 punti (centro, quattro lati, quattro angoli) e li trasforma in intervalli di geohash, poi rimuove i duplicati. Quindi una ricerca fa da 1 a 9 query, ciascuna con `where geohash in [inizio, fine]` e `endTime >= ora`, limitata a `PER_CELL_LIMIT = 150` documenti.

**Formula per una cache miss:**

```
letture_miss(eventsNear) = somma su Q query di max(1, documenti_restituiti)
                         ~= eventi futuri nei riquadri di geohash  (+ 1 per ogni query vuota)
```

Dove `Q` è il numero di intervalli dopo deduplica (da 1 a 9). Il `max(1, …)` segue l'ipotesi del codice: una query vuota costa comunque una lettura.

**Cache.** Più livelli, tutti per isolate (il Worker può avere più isolate, non condivisi):

- **Memoria del Worker**: TTL di 5 minuti. Chiavi: `near:lat,lng,km` (home e `/api/events`), `city:slug`, `upcoming:n`, `event:id`. Il limite di 300 voci è gestito per eliminazione della più vecchia.
- **Cache HTTP delle pagine**: `public, max-age=60, s-maxage=300, stale-while-revalidate=60` (`HTML_CACHE`) su home, città ed evento.
- **Cache HTTP di `/api/events`**: `max-age=60, s-maxage=300, stale-while-revalidate=600` (`no-store` se la lista è incompleta; gli errori sono 5xx e non si memorizzano). Il browser aggiunge `v=<version dei dati>` all'URL, così bordo e browser cambiano voce a ogni import e il conteggio dell'HTML coincide con la lista. Le coordinate sono arrotondate a 0,05° (circa 5 km), quindi molti utenti condividono la stessa chiave.
- **Cache HTTP di `/api/citta/<slug>` e di `/citta/<slug>`**: come `/api/events` (`API_CACHE` e `HTML_CACHE`, `no-store` se la lista è incompleta). La pagina porta la `version` dei dati e «Mostra altri» chiede `/api/citta/<slug>?v=<version>`. Un import con `--source` riscrive i bundle delle liste e aggiorna solo `version` su `bundles/coverage` (1 scrittura), così la webapp non serve la lista vecchia fino a 3 ore.

**Visita con cache hit: 0 letture.** Una visita alla home nella stessa finestra di 5 minuti di un isolate già caldo non legge Firestore. Lo stesso vale per la cache HTTP dell'edge, se Cloudflare la applica alle risposte SSR (da verificare in produzione).

**Visita con cache miss.** Costa `letture_miss` per la chiave di quell'isolate. Per il dettaglio di un evento, una lettura per id (`getEvent`), con il tetto di 1 lettura per miss. Per una città, fino a 100 letture (`limit` di `eventsInCity`).

**Ordine di grandezza.** Dipende da due numeri che non si conoscono (eventi futuri nell'area, traffico per finestra):

- Per la home si ha, al massimo, una miss per finestra di 5 minuti per isolate attivo: fino a 288 miss al giorno per isolate. Con 60 eventi nei riquadri, un isolate sempre caldo costa circa 17.000 letture al giorno (288 × 60). Due isolate sempre caldi superano la metà della quota.
- Il caso realistico è molto più basso: una finestra costa letture solo se arriva almeno una richiesta. Con traffico modesto, il costo scala con il numero di finestre con traffico, non con il numero di visite.
- Quindi il limite sostenibile non sono le visite in sé: con cache calda, decine di migliaia di visite al giorno costano relativamente poco. I limiti più probabili sono le quote Cloudflare (richieste e CPU del piano gratuito, da verificare nella documentazione) e il numero di isolate.

**Incertezze:**

- Il numero di eventi nei riquadri non è misurato: dipende dai dati importati.
- Il numero di intervalli dopo deduplica (da 1 a 9) non è misurato.
- Non è verificato se Firestore addebita una lettura per query vuota (il codice lo assume).
- Non è verificato il comportamento della cache HTTP dell'edge di Cloudflare per le risposte SSR.
- Il ciclo di vita degli isolate (quanto restano caldi) è deciso da Cloudflare.
- Per misurare davvero: usare la console Firebase (uso delle letture) o aggiungere un log di `readCount` (oggi non esiste).

**Impatto di `FRESH.list` (6 h → 3 h) e della versione nella chiave.** Una miss costa le celle del cerchio (con il margine di 4 km: r10 ≈ 4-6, r25 ≈ 10-12, r50 ≈ 24-29, r100 ≈ 84 letture). Al massimo una miss per chiave attiva, data center e finestra di 3 h, più una per chiave a ogni cambio di versione (la copertura resta in cache 1 h, quindi più import ravvicinati valgono una sola rilettura). Caso pessimo con 30 chiavi sempre attive (media 20 letture) e 2 data center: 6 h ≈ 4.800, 3 h ≈ 9.600 letture al giorno, più le riletture dei giorni con più import. Sotto la quota di 50.000; da confrontare con la console Firebase dopo il rilascio. Le liste incomplete non memorizzate costano una lettura per richiesta, ma solo finché i dati sono davvero a metà.
