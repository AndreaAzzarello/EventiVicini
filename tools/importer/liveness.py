"""Prima di segnare un evento come sparito dalla fonte, controlla se la sua pagina risponde ancora (#56).

Il lettore di alcuni siti dei Comuni (Design Comuni) vede solo i primi eventi della lista: un evento che esce dai primi
resta online ma non è più «pubblicato» per l'importer. Qui si fa una richiesta alla sua pagina (robots.txt, 1 richiesta/s
per host, ETag come nell'adapter):
  - 200 sulla stessa pagina  → l'evento esiste ancora: non si segna come sparito;
  - 404 / 410 o redirect ad altra pagina → sparito davvero: si segna;
  - errore di rete, 5xx, altri 4xx, robots.txt, tetto di controlli raggiunto → non si sa: non si segna (nel dubbio visibile).
Eccezione: un doppione WordPress («…-copy») il cui originale è nella lista di oggi si nasconde comunque.
Le pagine delle fonti del Mac mini il runner GitHub non le raggiunge (403, timeout): le controlla il Mac (scarica.py,
`_liveness.json` nell'artifact) e qui si usa il suo esito, `online` o `gone`, al posto della richiesta (#70).
Per gli host delle fonti del Mac (`mac_hosts`) GitHub non fa MAI richieste: senza esito del Mac la pagina è «skipped», cioè
resta visibile. L'esito è neutro per la regola dei 2 giri: non conta come giro mancante e non azzera il contatore (#70).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from fetch import Blocked, Fetcher, RobotsUnknown
from registry import host_key

log = logging.getLogger("importer")
MAX_CHECKS = 300  # richieste di controllo per import: oltre, nel dubbio l'evento resta visibile
GONE = {404, 410}
SKIP_HOSTS = frozenset({"app.ticketmaster.com"})  # API con chiave nell'URL: nessuna richiesta (la chiave non finisce nei log); gli eventi scadono a endTime
COPY_SUFFIX = re.compile(r"(?:-copy)+/?$")


MAC_RESULTS_FILE = "_liveness.json"
MAC_RESULTS_MAX_AGE = timedelta(hours=36)  # più vecchio: la pagina potrebbe essere cambiata, nel dubbio la si richiede


def read_mac_results(directory: Path, now: datetime | None = None) -> dict[str, str]:
    """Esiti url → online|gone scritti dal Mac (scarica.py), se il file c'è, è leggibile e abbastanza recente; altrimenti {}."""
    try:
        doc = json.loads((directory / MAC_RESULTS_FILE).read_text(encoding="utf-8"))
        checked = datetime.fromisoformat(doc["checkedAt"])
        results = doc["results"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    if checked.tzinfo is None or (now or datetime.now(timezone.utc)) - checked > MAC_RESULTS_MAX_AGE or not isinstance(results, dict):
        return {}
    return {u: v for u, v in results.items() if isinstance(u, str) and v in ("online", "gone")}


def _norm(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc.lower()}{p.path.rstrip('/')}"


class LiveChecker:
    """Callable url → True se l'evento va tenuto visibile. Un'istanza per import: ricorda gli esiti."""

    def __init__(self, client: httpx.Client, seen_urls: set[str], cache_dir: Path | None = None, max_checks: int = MAX_CHECKS,
                 precomputed: dict[str, str] | None = None, mac_hosts: set[str] | frozenset[str] = frozenset(),
                 https_hosts: set[str] | frozenset[str] = frozenset()):
        self.fetcher = Fetcher(client, cache_dir=cache_dir, retries=1, backoff=3.0)
        self.seen = {_norm(u) for u in seen_urls}
        self.max_checks = max_checks
        self.done: dict[str, bool] = {}
        self.precomputed = {_norm(u): v for u, v in (precomputed or {}).items() if v in ("online", "gone")}  # esiti del Mac (#70)
        self.mac_hosts = {host_key(h) for h in mac_hosts}  # host serviti dal Mac: nessuna richiesta da GitHub (#70)
        self.https_hosts = {host_key(h) for h in https_hosts}  # host il cui sito nel registro è https: gli URL http si richiedono in https
        self.stats = {"online": 0, "gone": 0, "unknown": 0, "duplicates": 0, "skipped": 0, "mac": 0, "mac_missing": 0}
        self.unknown_by_host: dict[str, dict[str, int]] = {}  # host → motivo → quante pagine (#70)

    def _unknown(self, url: str, reason: str) -> bool:
        """Registra una pagina di cui non si sa nulla (resta visibile) con host e motivo, per vedere chi la causa (#70)."""
        self.stats["unknown"] += 1
        host = urlsplit(url).netloc.lower()
        by_reason = self.unknown_by_host.setdefault(host, {})
        by_reason[reason] = by_reason.get(reason, 0) + 1
        log.info("controllo pagina %s: nel dubbio resta visibile (%s)", url, reason)
        return True

    def unknown_summary(self) -> str:
        return "; ".join(f"{h}: " + ", ".join(f"{r} {n}" for r, n in sorted(rs.items()))
                         for h, rs in sorted(self.unknown_by_host.items()))

    def __call__(self, url: str) -> bool:
        if url in self.done:
            return self.done[url]
        keep = self._check(url)
        self.done[url] = keep
        return keep

    def _check(self, url: str) -> bool:
        return self.verdict(url) in ("online", "unknown", "skipped")

    def verdict(self, url: str) -> str:
        """online | gone | duplicate | unknown | skipped. «gone» e «duplicate» si segnano come spariti, il resto resta visibile."""
        if COPY_SUFFIX.search(urlsplit(url).path) and _norm(COPY_SUFFIX.sub("", url)) in self.seen:
            self.stats["duplicates"] += 1
            return "duplicate"  # doppione di un evento che la lista mostra
        if urlsplit(url).netloc.lower() in SKIP_HOSTS:
            self.stats["skipped"] += 1
            return "skipped"
        pre = self.precomputed.get(_norm(url))
        if pre:  # lo ha già controllato il Mac, da un IP che il sito non blocca
            self.stats["mac"] += 1
            return pre
        if host_key(url) in self.mac_hosts:  # fonte del Mac senza esito: nessuna richiesta, nel dubbio visibile
            self.stats["mac_missing"] += 1
            log.info("controllo pagina %s: fonte del Mac senza esito, resta visibile (nessuna richiesta)", url)
            return "skipped"
        if url.startswith("http://") and host_key(url) in self.https_hosts:
            url = "https://" + url[len("http://"):]  # il sito risponde in https: in http dà 400 (Trecenta)
        if self.fetcher.requests >= self.max_checks:
            self.stats["skipped"] += 1
            return "skipped"
        try:
            res = self.fetcher.get(url)
        except (Blocked, RobotsUnknown, httpx.HTTPError) as e:
            self._unknown(url, type(e).__name__)
            return "unknown"
        if res.status_code in GONE:
            self.stats["gone"] += 1
            return "gone"
        if res.status_code == 200 or res.status_code == 304:
            final = getattr(res, "url", None)
            if res.history and final is not None and _norm(str(final)) != _norm(url):
                self.stats["gone"] += 1  # rimanda a un'altra pagina (di solito l'elenco)
                return "gone"
            self.stats["online"] += 1
            return "online"
        self._unknown(url, f"HTTP {res.status_code}")
        return "unknown"
