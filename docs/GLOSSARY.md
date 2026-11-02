# Glossario

Termini del dominio, come li usano codice, interfaccia e documenti. Usa questi, non sinonimi.

- **Evento**: una voce dell'agenda (`events`). Ha inizio e fine; se dura più di 14 giorni è **in corso** (mostra, rassegna).
- **Proposta** (`submissions`): evento inviato da un utente, in revisione fino all'approvazione o al rifiuto (con motivo). Dopo l'approvazione l'evento non resta collegato all'autore.
- **Segnalazione** (`reports`): avviso di chiunque su un evento (illegale, falso o ingannevole, dati personali, altro). Si decide una volta sola: **rimossa** o **respinta**, sempre con una motivazione.
- **Filtro di data**: finestra temporale scelta dall'utente. **Preset relativi** (`quando=oggi|domani|weekend|7giorni`, seguono il giorno corrente) oppure **periodo** (`dal=AAAA-MM-GG&al=AAAA-MM-GG`, date fisse). Include gli eventi che si **sovrappongono** alla finestra, anche se iniziati prima.
- **Orizzonte**: giorni in avanti per cui l'importer carica eventi (`run.py --horizon-days`, 60 di default; `activate.py` usa 45); il selettore di date arriva a 60 giorni.
- **Luogo**: comune o zona scelti dall'utente per cercare. La **posizione esatta** non lascia mai il dispositivo.
- **Punto di contatto**: l'indirizzo email pubblico per privacy, segnalazioni, autorità e sicurezza (DSA, artt. 11-12).
