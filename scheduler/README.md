# Scheduler: avvio puntuale dell'import e del download dal Mac mini

Il Worker ha **due** Cron Trigger: alle **06:45 UTC** avvia `scarica-fonti.yml` (fonti del Mac mini, #54, senza input) e alle **08:17 UTC** `import-events.yml` (vedi sotto). La riserva di `scarica-fonti.yml` è il cron di GitHub delle **07:30 UTC**; il suo job `guard` la salta se oggi esiste già un run riuscito, in corso o in coda (i dispatch del Worker passano sempre; `concurrency: scarica-fonti` serializza i resti). Dopo la modifica: `npx wrangler deploy` (il secret `GITHUB_TOKEN` resta; Actions: Read and write copre qualunque workflow del repo).

Worker Cloudflare gratuito che ogni giorno alle **08:17 UTC** (Cron Trigger) chiama l'API di GitHub e avvia `import-events.yml` con `workflow_dispatch` e `auto=true`. Serve perché il cron di GitHub Actions può ritardare di ore o saltare.

Tre avvii, una sola esecuzione al giorno:

| ora (UTC) | chi | ruolo |
|---|---|---|
| 08:17 | Worker (questa cartella) | avvio puntuale |
| 10:17 | cron di GitHub (`import-events.yml`) | riserva |
| a mano | `gh workflow run import-events.yml -f auto=true` | riserva manuale |

Il job `guard` del workflow (`python ci_report.py guard`) salta l'avvio se oggi (data UTC) esiste già un import completo (workflow `import-events.yml`, evento `schedule` o `workflow_dispatch`, né dry-run né regione singola), in corso o terminato; i run cancellati o saltati non contano. L'API dei run non espone gli input: `guard` li legge dal nome del proprio job (`guard (dry_run=false, regione=)`), indipendente dal titolo del run. Il `concurrency` serializza i tre avvii, quindi il secondo trova il primo. I lanci manuali senza `auto` non sono controllati (restano possibili dry-run e regioni singole).

## 1. Token GitHub (solo Actions: write su questo repo)
1. GitHub → foto profilo → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Nome `eventi-vicini-scheduler`, scadenza a scelta (massimo 1 anno: metti un promemoria per rinnovarlo; alla scadenza il Worker risponde 401 e restano le riserve).
3. **Repository access** → *Only select repositories* → `EventiVicini`.
4. **Permissions** → *Repository permissions* → **Actions: Read and write**. Nient'altro (Metadata: Read-only si aggiunge da solo).
5. **Generate token** e copialo subito (si vede una volta sola). Non metterlo in file del repo né in chat.

## 2. Worker Cloudflare (PowerShell)
Serve l'account Cloudflare gratuito che usi già per Pages (nessuna carta).

```powershell
cd C:\Users\Andrea\Desktop\App\appEventi\scheduler
npm test                          # 3 test, niente rete
npx wrangler login                # apre il browser, una volta
npx wrangler deploy               # crea il Worker e il Cron Trigger 17 8 * * *
npx wrangler secret put GITHUB_TOKEN   # incolla il token quando richiesto
```

Il token resta solo nei secret del Worker (cifrato su Cloudflare), mai nel repo. `wrangler.toml` contiene solo repo, workflow e ramo.

## 3. Verifica
- Dashboard Cloudflare → **Workers & Pages** → `eventi-vicini-scheduler` → **Settings → Triggers**: compare il cron `17 8 * * *`. Dopo la prima esecuzione i log sono in **Observability / Logs** (errore 401 = token scaduto o permessi sbagliati; 404 = repo o workflow sbagliato; 422 = il workflow su `main` non ha l'input `auto`).
- Prova senza aspettare: `gh workflow run import-events.yml -f auto=true` poi `gh run list --workflow import-events.yml --limit 3`. Se oggi un import completo è già partito, il job `guard` termina con "salto" e gli altri job risultano saltati.
- Se vuoi un import vero a mano, senza controllo: `gh workflow run import-events.yml` (senza `auto`).

## Limiti
- Il Cron Trigger di Cloudflare è puntuale al minuto ma, come ogni scheduler, non ritenta se GitHub è giù: per questo c'è il cron delle 10:17.
- Se un import completo di oggi è fallito (anche in parte), le riserve non lo rilanciano: per rilanciarlo usa `gh workflow run` senza `auto`.
