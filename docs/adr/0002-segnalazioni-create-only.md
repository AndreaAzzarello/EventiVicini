# 0002 — Segnalazioni dei contenuti: create-only su Firestore, aperte a tutti

Data: 2026-11-02

## Contesto
Il DSA (art. 16) chiede un meccanismo di segnalazione accessibile a chiunque, e decisioni motivate (art. 17).

## Decisione
- Collezione `reports`, creazione aperta anche senza account, ma solo con campi validati dalle regole (motivo da elenco chiuso, spiegazione 10-1.000 caratteri, email facoltativa, evento esistente, `createdAt == request.time`). Nessuna lettura pubblica.
- Solo l'admin legge e decide (`removed` o `dismissed`, una volta, con motivazione 3-500). Le chiuse si cancellano dopo 180 giorni (`cleanup.py`).
- Difese del modulo: campo esca e una segnalazione per evento per dispositivo (`ev:reported`). Non sono una barriera contro abusi intenzionali.

## Dipendenza
La protezione completa dalle scritture abusive richiede App Check (A2 in `docs/sicurezza-prossimi-passi.md`).

## Alternative scartate
- Solo email: nessuna coda né tracciabilità.
- Solo utenti con account: contrasta con l'accessibilità del meccanismo richiesta dal DSA.
