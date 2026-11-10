# Prossimi passi di sicurezza

Dall'audit di sicurezza del 30 ottobre 2026 (run-1). Le correzioni a basso costo sono già fatte (limiti nel Worker, regole, intestazioni e CSP, privacy, `safeNext`, `submittedBy`). Restano questi punti.

## A2 — Chiudere la lettura diretta di Firestore (alta)
**Problema.** Le regole hanno `allow read: if true` su `events`, `bundles`, `coverage` e `stats`, e la chiave web Firebase è pubblica (`web/wrangler.toml`). Chiunque può interrogare Firestore via REST senza passare dal Worker, quindi i limiti e le cache del Worker non servono contro un abuso intenzionale: bastano poche richieste per esaurire le 50.000 letture giornaliere del piano Spark. Sito e importer (budget 40.000 letture) si fermano fino al reset; nessun dato va perso.

**Stato (3 novembre 2026).**
1. Il Worker sa leggere con un account di servizio (`web/src/lib/server/gauth.ts`, ticket #10): fatto nel codice. Senza il segreto `FIREBASE_READER_SA` ripiega sulla chiave web, quindi si può pubblicare prima di configurarlo.
2. Le regole chiudono la lettura pubblica di `events`, `bundles`, `coverage`, `stats` (ticket #11): pubblicate e **verificate in produzione il 3 novembre 2026**: REST anonimo su `events`, `bundles`, `coverage`, `stats` (con e senza chiave web) → HTTP 403 `PERMISSION_DENIED`; 19 pagine `/citta/` (una per regione, tutte in sitemap) → 200 con eventi; dettaglio evento → 200. Il Molise non ha città in sitemap (la sitemap è limitata a 500 eventi): non verificato, la pagina `/regione/molise` risponde 200. Rollback: `git revert` del commit delle regole e di nuovo `npm run deploy:rules`.
3. App Check sulle scritture del browser (ticket #12): attivo in produzione dal 3 novembre 2026 (commit `8746cef`, `PUBLIC_TURNSTILE_SITEKEY` in `wrangler.toml`), in osservazione dal 3 al 10 novembre 2026. **Enforcement su Firestore attivo dal 10 novembre 2026, ore 10:20** (ticket #13, vedi «Enforcement (T6)» sotto); Auth non applicato per scelta. Da solo non protegge le letture REST del Worker, per questo il punto 1 viene prima.

**Ordine.** Worker con il segreto → verifica delle letture in produzione → regole con lettura chiusa (`npm run deploy:rules` in `firebase/`) → App Check in monitoraggio → enforcement. Se si pubblicano le regole prima del Worker con il token, il sito smette di leggere.

### Account di servizio del Worker (`eventi-vicini-reader`)
- **Permessi minimi.** Un solo ruolo: *Cloud Datastore Viewer* (`roles/datastore.viewer`), sul progetto `appeventi-1e860`. Nessun ruolo di scrittura, nessun ruolo di proprietà. Per la creazione dei token App Check (ticket #12) serve in più un ruolo personalizzato con il solo permesso `firebaseappcheck.tokens.mint` (vedi sotto).
- **Cosa legge davvero.** Le regole non valgono per un account di servizio, quindi *Datastore Viewer* legge **ogni** collezione, compresi dati personali (`users`, `submissions`, `reports`, preferiti). Il codice del Worker legge solo `events`, `bundles`, `coverage`; il limite è nel codice, non nei permessi. Per questo la chiave va trattata come critica.
- **Dove sta la chiave.** Solo come segreto Cloudflare `FIREBASE_READER_SA` (JSON). Mai nel repository, in `wrangler.toml`, in `.env`, nei log o nei ticket. Il file scaricato dalla console si tiene fuori dal repo e si cancella appena caricato il segreto. Gli errori del modulo non riportano né chiave né risposte del server (coperto dai test).
- **Rotazione.** Ogni 12 mesi (promemoria: ottobre 2027, e comunque a ogni sospetto): creare una nuova chiave, aggiornare il segreto, verificare le letture, poi eliminare la chiave vecchia dalla console.
- **Revoca immediata (sospetto di fuga).** 1) Console Google Cloud → IAM e amministrazione → Account di servizio → `eventi-vicini-reader` → Chiavi → elimina la chiave: il token già emesso scade entro un'ora, nuovi token non se ne emettono. 2) Se serve fermare subito anche quello, disabilita l'account di servizio. 3) Crea una nuova chiave e aggiorna il segreto. Il sito, nel frattempo, serve le copie in cache fino a 2 giorni.
- **Costo.** Gratuito: l'account di servizio e il token OAuth non costano; le letture contano nella stessa quota di Firestore. CPU della firma RSA-2048: circa 1,5 ms a freddo e 0,5 ms a regime, una volta all'ora per istanza (misura su Node; il limite del piano gratuito è 10 ms per richiesta). Da confermare con le metriche di Cloudflare dopo il deploy.

### App Check con Cloudflare Turnstile (ticket #12)
**Come funziona.** Il browser carica il widget Turnstile (solo insieme all'SDK Firebase, mai per chi naviga e basta) → `POST /api/appcheck` con il token del widget → il Worker lo verifica con `siteverify` (Cloudflare lo accetta una sola volta; si controllano `action=appcheck` e `hostname`) → solo allora firma un token personalizzato con l'account di servizio e lo scambia con `exchangeCustomToken` (TTL 30 minuti, il minimo) → l'SDK allega il token a Firestore e Auth. Senza Turnstile valido: 400/403 e nessun token (coperto da `web/src/lib/server/appcheck.test.ts`). Gli errori non riportano mai token né chiavi.

**Cosa scrive nel browser.** IndexedDB `firebase-app-check-database` (dominio del sito) e `cf.turnstile.u` in localStorage dentro l'iframe di `challenges.cloudflare.com` (non nel dominio del sito). Nessun cookie, verificato con le chiavi di test pubbliche di Cloudflare. Dichiarato in `web/src/lib/cookies.ts`, `/cookie` e `/privacy` (mostrati solo se `PUBLIC_TURNSTILE_SITEKEY` è impostata).

**Limite di verifica.** L'emulatore Firestore non applica App Check: l'enforcement e lo scambio reale con Google si vedono solo in produzione.

**Attivazione (ogni passo con conferma).**
1. Dashboard Cloudflare → Turnstile → nuovo widget, hostname `eventi-vicini.pages.dev`, modalità **Managed**: è quella coerente con il codice (`web/src/lib/firebase/appcheck.ts` usa `appearance: 'interaction-only'`, render esplicito, azione `appcheck`): il widget resta invisibile e compare in basso solo se Cloudflare chiede un'interazione. *Non-interactive* mostrerebbe sempre un riquadro; *Invisible* non permette di rispondere a una sfida. Si ottengono chiave pubblica e segreto.
2. Segreto (da `web/`, interattivo): `npx wrangler pages secret put TURNSTILE_SECRET --project-name eventi-vicini`. La chiave pubblica `PUBLIC_TURNSTILE_SITEKEY` va in `[vars]` di `web/wrangler.toml` (è la fonte delle variabili), poi commit e push.
3. Google Cloud → IAM → ruolo personalizzato con il solo permesso `firebaseappcheck.tokens.mint` (confermato dalla [documentazione dei permessi Firebase](https://firebase.google.com/docs/projects/iam/permissions)), assegnato a `eventi-vicini-reader`. Abilitare l'API *Firebase App Check* sul progetto. Un account dedicato non serve: la chiave starebbe comunque nei segreti dello stesso Worker.
4. Console Firebase → App Check → app web → *Provider personalizzato* (nessuna chiave da inserire: i token sono firmati dall'account di servizio).
5. Push. Monitoraggio per 7 giorni in console App Check → Firestore: richieste verificate / non verificate / obsolete. **Inizio monitoraggio: 3 novembre 2026 · fine: 10 novembre 2026. Enforcement NON attivo.** Verificato il 3 novembre: `POST /api/appcheck` con token finto → 403, senza corpo → 400, GET → 405; deploy `8afde540` (`80d372c`) attivo con `console.warn('appcheck:')` nel chunk servito. **T5 attivo e verificato il 3 novembre 2026** per deploy, rotta, widget Turnstile e scambio `exchangeCustomToken`: in produzione (browser dell'utente, incognito, dopo il login) `firebase-app-check-database` → `firebase-app-check-store` contiene la voce con chiave dell'app web e `value` con token ed `expireTimeMillis`; l'SDK salva il token solo dopo una risposta 200 di `/api/appcheck`. Resta da confermare solo la crescita delle metriche «verificate» (App Check → API → Cloud Firestore), che l'utente controlla nei giorni del monitoraggio.
6. Enforcement (ticket #13) solo se le non verificate sono quasi zero: attivato il 10 novembre 2026 (vedi sotto). Rollback: «Unenforce» in console (propagazione fino a circa 15 minuti, tempo documentato per l'attivazione; per la disattivazione è una stima prudente). Per disattivare tutto: svuotare `PUBLIC_TURNSTILE_SITEKEY` e ripubblicare.

### Enforcement (T6, ticket #13) — fatto il 10 novembre 2026
**Stato.** Enforcement di App Check attivo su **Cloud Firestore** dalle 10:20 del 10 novembre 2026. **Auth non applicato, per scelta** (anteprima, possibile upgrade a Identity Platform irreversibile: nessuna modifica senza decisione esplicita).

**Verifiche dopo 15 minuti.**
- Worker: eventi visibili sul sito. Il Worker legge via REST con il token OAuth dell'account di servizio, senza token App Check.
- Browser: preferito salvato da utente loggato (scrittura con token App Check).
- Pagina città senza cache (`/citta/ancona?v=2`): eventi visibili. Esclude che la lettura del Worker venisse da una cache precedente all'enforcement.
- Importer, dry-run `molise` (run 42793698879): **non prova nulla su Firestore**, perché `run.py` stampa gli eventi e termina prima di `_write` (nessuna connessione al database).
- Importer, **import reale** `molise` dopo l'enforcement (run 42794673840, 09:54 UTC): success in tutti i job; 10 letture, 2 scritture, 0 cancellazioni (confronto `manifest`); nessun `PERMISSION_DENIED` nel log. Il client firebase-admin con `FIREBASE_SERVICE_ACCOUNT` funziona quindi con l'enforcement attivo.

**Metriche prima dell'enforcement** (console App Check, Firestore): 15 richieste su 15 verificate (100%), 0 non verificate. Il campione è piccolo (poco traffico in produzione).

**Nota sulla documentazione.** Quella ufficiale dice solo che «some services» accettano le credenziali dell'account di servizio senza token App Check ([EnforcementMode](https://firebase.google.com/docs/reference/appcheck/rest/v1/EnforcementMode)) e non nomina Firestore: l'esenzione per Worker (REST con token OAuth) e importer è confermata dai fatti sopra, non dal testo ufficiale. Il primo import completo con l'enforcement è quello automatico dell'11 novembre 2026 (08:17 UTC): controllare che il riepilogo non riporti errori Firestore.

**Se un import fallisce con `PERMISSION_DENIED`.** Console Firebase → Security → App Check → Cloud Firestore → togliere l'enforcement (fino a circa 15 minuti), poi rilanciare l'import. Non aprire Firestore ad altre scritture nel frattempo.

**Firebase Auth.** Il supporto di App Check per Auth è in anteprima e potrebbe richiedere l'upgrade a Identity Platform (irreversibile, con limiti diversi dallo Spark): **non applicato per scelta** (10 novembre 2026); non attivarlo senza decisione esplicita.

**Vincoli.** Tutto gratis, nessuna carta. Se la console impedisce di creare la chiave (criterio dell'organizzazione `iam.disableServiceAccountKeyCreation`), fermarsi e chiedere: non esistono alternative gratuite equivalenti senza cambiare approccio.

## Altri punti aperti
- Console Firebase/Google: provider attivi (solo Google e link email), domini autorizzati, restrizioni della chiave API (da lì dipende la sicurezza dell'admin, basata sull'email verificata).
- Token GitHub del Worker `scheduler/`: fine-grained, un solo repository, solo Actions: write.
- Rate limiting su `/api/*` e `/eventi/*`: richiede un dominio proprio sulla zona Cloudflare (non c'è su `pages.dev`).
- Importer: allowlist degli host di biglietteria, limite di dimensione delle risposte, `persist-credentials: false` nei checkout senza push, action GitHub fissate per commit, Dependabot.
- `/citta/<slug>`: costa una lettura per ogni slug nuovo (cache 6 ore); non validabile sulla copertura perché le città con eventi ma fuori da `coverage` devono restare raggiungibili.
- Dipendenze: dev di `web/` con 6 vulnerabilità basse risolvibili solo con aggiornamenti major; `pytest` 8.4.2 (PYSEC-2026-1845, solo test). Da rivedere al prossimo aggiornamento maggiore.
- Importer, Modena: 0 eventi per `timed out (anche al secondo tentativo)` nei run del 31 ottobre e del 2 novembre 2026 (client `httpx` con `timeout=30`, Plone con `fullobjects=1`). La fonte è raggiungibile e ha 256 eventi futuri (pagina da 25 in circa 3 s da qui). `/citta/modena` dà 404 perché non c'è alcun evento con città Modena, mentre `/?luogo=modena` mostra quelli nel raggio. Da aprire come ticket a parte, nessuna correzione fatta.
- Sitemap: senza città per il Molise (limite di 500 eventi); `/regione/molise` risponde 200. Da valutare insieme al ticket su Modena.
- Mappa (Leaflet), errore in produzione: `Uncaught TypeError: Cannot read properties of undefined (reading '_leaflet_pos')` da `getCenter` → `_getCenterLayerPoint`, durante un evento della mappa (segnalato il 3 novembre 2026). Ipotesi, non verificata: un handler di `moveend`/`zoomend` chiama `getCenter()` dopo `map.remove()` o durante un'animazione al cambio pagina. Probabilmente è la stessa causa del test e2e `desktop.spec.ts` (mappa) instabile (race con `draw()` su `zoomend`). Da aprire come ticket a parte, nessuna correzione fatta.
- Ping `apis.google.com/js/gen_204` bloccato dalla CSP in circa 1 caricamento su 40: telemetria dello script di Google, il login non ne dipende; volutamente non autorizzato (il test e2e lo ignora, vedi `web/e2e/headers.spec.ts`).
