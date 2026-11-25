// Pagine HTML: la cache all'edge (Cache API dell'adapter) non sa nulla dei deploy, quindi dopo un rilascio
// può servire HTML che punta a JS non più esistenti. 5 minuti al massimo; per azzerare subito: "Purge cache".
// Le letture Firestore restano contenute dalla cache in memoria di lib/server/firestore.ts.
export const HTML_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=60';

/** API delle liste (/api/events, /api/citta): breve, perché la chiave di cache porta già la versione dei dati (`v` nell'URL). */
export const API_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
