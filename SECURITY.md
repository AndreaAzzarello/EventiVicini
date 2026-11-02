# Sicurezza

## Come segnalare una vulnerabilità

Non aprire una issue pubblica. Scrivi a **eventivicini.info@gmail.com** con oggetto «Sicurezza EventiVicini», oppure usa [Security → Report a vulnerability](https://github.com/AndreaAzzarello/EventiVicini/security/advisories/new) del repository.

Indica: cosa hai trovato, come riprodurlo, quale impatto ha. Rispondo di norma entro 7 giorni; è un progetto personale e gratuito, quindi non ci sono SLA né ricompense.

## Cosa è nell'ambito

- webapp (`web/`), regole Firestore (`firebase/firestore.rules`), importer (`tools/importer/`) e workflow in `.github/workflows/`;
- accesso non autorizzato a dati, scritture non consentite su Firestore, XSS e injection, esposizione di segreti.

Fuori ambito: attacchi di tipo DoS, esaurimento delle quote gratuite, problemi dei servizi di terze parti (Firebase, Cloudflare, OpenStreetMap) e dei siti dei comuni da cui si importa.

## Cose da sapere

- La configurazione web di Firebase (`PUBLIC_FIREBASE_*`) è pubblica per costruzione: la sicurezza dei dati sta nelle regole Firestore e in Authentication.
- Il segreto `FIREBASE_SERVICE_ACCOUNT` è solo in GitHub Actions; non va mai committato.
- Versioni supportate: solo l'ultima su `main`.
