# appEventi (Eventi Vicini)

Agenda gratuita di eventi pubblici locali (partita da Modena). Dettagli completi in `README.md`; stato e ondate in `FINAL_REPORT.md`.

## Stack
- `web/`: SvelteKit + `adapter-cloudflare`, deploy su Cloudflare Pages. Lettura Firestore via REST nel Worker (niente Admin SDK).
- `firebase/`: regole e indici Firestore, test delle regole. Progetto `appeventi-1e860`.
- `tools/importer/`: importer Python (Plone, WordPress DCI, Design Comuni HTML) lanciato da GitHub Actions.

## Vincoli
- Firebase resta sul piano Spark (solo Auth + Firestore; niente Storage, Functions, Hosting). Quote al giorno: 50.000 letture, 20.000 scritture, 20.000 cancellazioni.
- Scrivi su Firestore solo i documenti cambiati (`contentHash`); l'importer si ferma oltre `--max-writes` (15.000) / `--max-reads` (40.000).
- Gli import reali vanno a tappe, una regione alla volta (`--regione`), dopo un `--dry-run`.
- I cron di GitHub funzionano solo in UTC e la chiave `timezone` si è rivelata inaffidabile: scrivili in UTC, dopo il reset della quota Firestore, senza `timezone`. Avvio puntuale 08:17 dal Worker `scheduler/` (Cloudflare Cron Trigger → `workflow_dispatch` con `auto=true`); il cron di GitHub (10:17) è riserva; il job `guard` evita il doppio import.
- Cloudflare: flusso Pages, non Workers. Root `web`, build `npm run build`, output `.svelte-kit/cloudflare`, `NODE_VERSION=24`.
- Rispetta robots.txt e licenze dei siti comunali; attiva una fonte solo con licenza sui contenuti (CC0/CC-BY).
- OpenStreetMap/Nominatim: User-Agent identificativo, max 1 richiesta/s.
- Design: le regole sono in `DESIGN.md`, i valori in `web/src/lib/styles/tokens.css`, il controllo automatico in `design.test.ts`.

## Comandi (da `web/` salvo diversa indicazione)
- Dev: `npm run dev` (legge `.env`); anteprima Cloudflare: `npm run preview` (porta 8788).
- Controlli: `npm run check`, `npm run lint`, `npm test`, `npm run build`.
- E2E: `npm run test:e2e` (usa `emulators:exec`, chiude da solo). Regole: `npm test` in `firebase/`.
- Importer (`tools/importer/`): `python -m pytest -q tests`, `python run.py --dry-run [--regione X]`.
- Deploy regole/indici (prima della webapp): `npm run deploy:rules` in `firebase/`.

## Finito quando
- In `web/` passano `npm run check`, `npm run lint`, `npm test` e `npm run build`. Se tocchi le regole passa anche `npm test` in `firebase/`; se tocchi l'importer, `python -m pytest -q tests`.
- Per il frontend controlla a 360 px (vedi `DESIGN.md`).
- Dichiara se non hai eseguito `test:e2e`, il `--dry-run` dell'importer o il controllo visivo. Un import reale lo esegui solo con la mia conferma.

## Cartelle importanti
`web/src/lib/server/firestore.ts` (letture REST; legge i bundle `bundles/*` scritti da `tools/importer/bundles.py`, ripiega sulle query per cella), `web/src/lib/styles/`, `firebase/firestore.rules`, `tools/importer/sources/*.csv` (registro fonti), `.github/workflows/`.

## Da non fare
- Nei test usa `emulators:exec` (chiude da solo), non `emulators:start`.
- Gli emulatori Firebase vogliono Java 21 (`C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`), nel PATH di sistema ma dopo il Java 8 Oracle. Se `java -version` mostra 1.8, imposta `JAVA_HOME` e `Path` solo per il comando (vedi `ClaudeVault\lezioni\emulatori-firebase-richiedono-java-21.md`). Se una run interrotta lascia un emulatore vivo, chiudi solo quel PID.
- Tieni fuori dai commit `.env`, `.dev.vars` e le chiavi service account: `FIREBASE_SERVICE_ACCOUNT` è un segreto.
- Modifica `reports/` e `sources/*.csv` solo tramite gli script (`activate.py`, `licenses.py`), non a mano.
- Le tile OSM pubbliche non sono adatte a traffico intenso; niente analytics né cookie di profilazione.

## Flusso per funzioni nuove
- `/grill-me` prima di ogni piano: le ambiguità emergono prima del codice, non durante.
- Specifica e ticket con `/to-spec` e `/to-tickets` su GitHub Issues. Il repo è pubblico: niente dati personali nei ticket.
- `/handoff` quando il contesto supera circa il 60%, salvato in `ClaudeVault\prompt\eventivicini-handoff-AAAA-MM-GG.md`: la sessione dopo riparte senza rileggere tutto.
- Decisioni e ADR in `docs/adr/` e copiate in `ClaudeVault\decisioni\`: il vault è la memoria tra i progetti.

## Checklist legale (in ogni progettazione)
- Privacy aggiornata per ogni dato nuovo, chiave locale o richiesta a terzi dal browser.
- Niente cookie o strumenti non tecnici; se servissero, prima il banner con consenso preventivo.
- Link a termini e privacy accanto all'invio di ogni modulo.
- Posizione solo se serve, mai salvata esatta fuori dal dispositivo.
- Diritti: cancellazione ed esportazione coprono anche i dati nuovi.
- WCAG 2.1 AA (axe negli e2e) e testi chiari.
- Seed e dati di esempio solo sull'emulatore.
- Contenuti degli utenti: segnalazione, decisione motivata, punto di contatto (DSA).
- Dati legali mai inventati: se mancano, chiedi.

## Agent skills

### Issue tracker
GitHub Issues di `AndreaAzzarello/EventiVicini` (repo pubblico, `gh`). Vedi `docs/agents/issue-tracker.md`.

### Triage labels
Etichette predefinite (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Vedi `docs/agents/triage-labels.md`.

### Domain docs
Single-context: `docs/GLOSSARY.md` e `docs/adr/`. Vedi `docs/agents/domain.md`.
