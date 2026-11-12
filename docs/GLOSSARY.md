# Glossario

Termini del dominio, come li usano codice, interfaccia e documenti. Usa questi, non sinonimi.

- **Evento**: una voce dell'agenda (`events`). Ha inizio e fine; se dura più di 14 giorni è **in corso** (mostra, rassegna).
- **Proposta** (`submissions`): evento inviato da un utente, in revisione fino all'approvazione o al rifiuto (con motivo). Dopo l'approvazione l'evento non resta collegato all'autore.
- **Segnalazione** (`reports`): avviso di chiunque su un evento (illegale, falso o ingannevole, dati personali, altro). Si decide una volta sola: **rimossa** o **respinta**, sempre con una motivazione.
- **Filtro di data**: finestra temporale scelta dall'utente. **Preset relativi** (`quando=oggi|domani|weekend|7giorni`, seguono il giorno corrente) oppure **periodo** (`dal=AAAA-MM-GG&al=AAAA-MM-GG`, date fisse). Include gli eventi che si **sovrappongono** alla finestra, anche se iniziati prima.
- **Orizzonte**: giorni in avanti per cui l'importer carica eventi (`run.py --horizon-days`, 60 di default e quello dell'import vero; `activate.py` usa 45 solo per l'attivazione dei comuni); il selettore di date arriva a 60 giorni.
- **Luogo**: comune o zona scelti dall'utente per cercare. La **posizione esatta** non lascia mai il dispositivo.
- **Cluster di rete**: più siti dei Comuni sullo stesso hosting (stessa subnet /24) che non rispondono al runner insieme. Si gestisce a livello di subnet con due **sentinelle**, senza parcheggiare i singoli host (`clusters.py`).
- **Parcheggio**: attesa di 1, 3 o 7 giorni per un host che non si connette (`unreachable.py`).
- **Eventi visibili**: stima degli eventi presenti sul sito per una regione: quelli estratti oggi più quelli che le fonti saltate lasciano in Firestore.
- **Punto di contatto**: l'indirizzo email pubblico per privacy, segnalazioni, autorità e sicurezza (DSA, artt. 11-12).
- **Fonte regionale**: API unica che copre più comuni (Open Data Hub Alto Adige, Emilia Romagna Turismo). Non è un comune: non ha scheda nella copertura e, nella deduplica su titolo, giorno e comune, vince la fonte comunale. Le immagini di Emilia Romagna Turismo non si importano finché l'ente non conferma le licenze (#37).
