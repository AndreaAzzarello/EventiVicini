# Cronologia

- 2026-11-24: PR #96, immagini più leggere su /citta, /?luogo e dettaglio evento (variante piccola derivata in lettura, ripiego all'originale; seguito importer #95).
- 2026-11-24: PR #97, home più compatta sotto 400 px (una card intera a 360x640), lista renderizzata a blocchi (TBT 220 → 14 ms in locale), immagini sopra la piega in eager.
- 2026-11-24: PR (feat/web-segnala-evento-social), «Segnala un evento trovato sui social»: /proponi?da=social con il link al post (solo https, mai aperto) come `sourceUrl` della proposta e poi «Fonte» dell'evento; riga «Segnala un evento» dopo l'ottava card di home e città, nella scheda evento e nel footer; duplicati del link in admin. Regole Firestore da pubblicare prima della webapp.
