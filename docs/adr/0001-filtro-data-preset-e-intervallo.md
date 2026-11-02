# 0001 — Filtro di data: preset relativi e intervallo nell'URL, tutto nel browser

Data: 2026-11-02

## Contesto
Serve filtrare per data lista, mappa, sezioni e pagine città senza consumare letture Firestore (Spark: 50.000 al giorno).

## Decisione
- Il filtro vive nell'URL: `quando=oggi|domani|weekend|7giorni` (relativo) oppure `dal`/`al` (date fisse, `al` facoltativo). `dal` vince su `quando`.
- Si applica nel browser su eventi già caricati (`applyFilter`), con la regola di sovrapposizione `inizio < fine finestra && fine > inizio finestra`: nessuna lettura in più (verificato da `npm run test:reads`).
- Il selettore usa due `input type=date` nativi, da oggi a 60 giorni (l'orizzonte di `run.py`; `activate.py` usa 45, da verificare quale vale in produzione). Un periodo già passato vale come oggi.
- «In corso» non è un chip: è già una sezione della lista. L'URL `inCorso=1` si ignora.
- Le pagine regione non hanno il filtro: non caricano eventi.

## Alternative scartate
- Calendario su misura: molto codice e test di accessibilità per poco guadagno.
- Solo date fisse: i link «weekend» condivisi scadrebbero.
