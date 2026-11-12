"""Prima di segnare un evento come sparito dalla fonte, controlla se la sua pagina risponde ancora (#56).

Il lettore di alcuni siti dei Comuni (Design Comuni) vede solo i primi eventi della lista: un evento che esce dai primi
resta online ma non è più «pubblicato» per l'importer. Qui si fa una richiesta alla sua pagina (robots.txt, 1 richiesta/s
per host, ETag come nell'adapter):
  - 200 sulla stessa pagina  → l'evento esiste ancora: non si segna come sparito;
  - 404 / 410 o redirect ad altra pagina → sparito davvero: si segna;
  - errore di rete, 5xx, altri 4xx, robots.txt, tetto di controlli raggiunto → non si sa: non si segna (nel dubbio visibile).
Eccezione: un doppione WordPress («…-copy») il cui originale è nella lista di oggi si nasconde comunque.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from fetch import Blocked, Fetcher, RobotsUnknown

log = logging.getLogger("importer")
MAX_CHECKS = 300  # richieste di controllo per import: oltre, nel dubbio l'evento resta visibile
GONE = {404, 410}
COPY_SUFFIX = re.compile(r"(?:-copy)+/?$")


def _norm(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc.lower()}{p.path.rstrip('/')}"


class LiveChecker:
    """Callable url → True se l'evento va tenuto visibile. Un'istanza per import: ricorda gli esiti."""

    def __init__(self, client: httpx.Client, seen_urls: set[str], cache_dir: Path | None = None, max_checks: int = MAX_CHECKS):
        self.fetcher = Fetcher(client, cache_dir=cache_dir, retries=1, backoff=3.0)
        self.seen = {_norm(u) for u in seen_urls}
        self.max_checks = max_checks
        self.done: dict[str, bool] = {}
        self.stats = {"online": 0, "gone": 0, "unknown": 0, "duplicates": 0, "skipped": 0}

    def __call__(self, url: str) -> bool:
        if url in self.done:
            return self.done[url]
        keep = self._check(url)
        self.done[url] = keep
        return keep

    def _check(self, url: str) -> bool:
        if COPY_SUFFIX.search(urlsplit(url).path) and _norm(COPY_SUFFIX.sub("", url)) in self.seen:
            self.stats["duplicates"] += 1
            return False  # doppione di un evento che la lista mostra
        if self.fetcher.requests >= self.max_checks:
            self.stats["skipped"] += 1
            return True
        try:
            res = self.fetcher.get(url)
        except (Blocked, RobotsUnknown, httpx.HTTPError) as e:
            log.info("controllo pagina %s: nel dubbio resta visibile (%s)", url, type(e).__name__)
            self.stats["unknown"] += 1
            return True
        if res.status_code in GONE:
            self.stats["gone"] += 1
            return False
        if res.status_code == 200 or res.status_code == 304:
            final = getattr(res, "url", None)
            if res.history and final is not None and _norm(str(final)) != _norm(url):
                self.stats["gone"] += 1  # rimanda a un'altra pagina (di solito l'elenco)
                return False
            self.stats["online"] += 1
            return True
        self.stats["unknown"] += 1
        return True
