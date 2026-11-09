"""Download cortese: robots.txt (protego), 1 richiesta al secondo per host, retry con backoff,
cache HTTP su disco (ETag / Last-Modified). Condiviso da detect_cms, licenses e dagli adapter HTML."""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
from protego import Protego

from netcluster import NetGate
from registry import USER_AGENT

log = logging.getLogger("importer")
CACHE_DIR = Path(__file__).parent / ".httpcache"
RETRY_STATUS = {429, 500, 502, 503, 504}
CONNECT_FAILED = (httpx.ConnectError, httpx.ConnectTimeout)  # l'host non risponde: ritentare subito non serve
#: limiti per IP e subnet condivisi da tutti i Fetcher (ogni adapter ne crea uno suo); li imposta run.py, i comandi a mano non ne hanno
DEFAULT_GATE: NetGate | None = None


class Blocked(Exception):
    """robots.txt vieta l'URL."""


class RobotsUnknown(Exception):
    """robots.txt non raggiungibile (5xx o rete): per prudenza non si visita nulla."""


class Fetcher:
    def __init__(self, client: httpx.Client, min_interval: float = 1.0, cache_dir: Path | None = None,
                 retries: int = 3, backoff: float = 1.0, gate: NetGate | None = None):
        self.gate = gate if gate is not None else DEFAULT_GATE
        self.client, self.min_interval = client, min_interval
        self.cache_dir, self.retries, self.backoff = cache_dir, retries, backoff
        self._robots: dict[str, Protego | None] = {}
        self._why: dict[str, str] = {}  # origine → motivo dell'ultimo fallimento di robots.txt
        self._next: dict[str, float] = {}
        self._lock = threading.Lock()
        self.hits = self.requests = 0

    def _wait(self, host: str) -> None:
        with self._lock:
            now = time.monotonic()
            at = max(now, self._next.get(host, 0.0))
            self._next[host] = at + self.min_interval
        if at > now:
            time.sleep(at - now)

    def _send(self, url: str, **kw) -> httpx.Response:
        """Una richiesta HTTP, attraverso i limiti per IP e subnet (se ci sono) e con l'esito riportato al gate."""
        if self.gate is None:
            return self.client.get(url, **kw)
        host = urlsplit(url).netloc
        with self.gate.slot(host):
            try:
                res = self.client.get(url, **kw)
            except CONNECT_FAILED:
                self.gate.report(host, False)
                raise
            self.gate.report(host, True)  # qualunque risposta HTTP: l'host è raggiungibile
            return res

    def _robots_for(self, origin: str) -> Protego | None:
        with self._lock:
            if origin in self._robots:
                return self._robots[origin]
        rp: Protego | None = None
        why = ""
        for attempt in range(self.retries + 1):  # un errore momentaneo non deve spegnere la fonte per tutto l'import
            try:
                self._wait(urlsplit(origin).netloc)
                res = self._send(origin + "/robots.txt")
            except CONNECT_FAILED as e:
                why = type(e).__name__
                break
            except httpx.HTTPError as e:
                res, why = None, type(e).__name__
                if isinstance(e, httpx.TimeoutException) and attempt >= 1:
                    break  # un timeout di lettura costa 30 s a tentativo: al massimo 1 retry (i 5xx rispondono subito e si ritentano)
            else:
                why = f"HTTP {res.status_code}"
            if res is not None and res.status_code < 400:
                rp = Protego.parse(res.text)
            elif res is not None and res.status_code < 500 and res.status_code != 429:
                rp = Protego.parse("")  # nessun robots.txt (4xx): tutto permesso (RFC 9309); 429 = troppe richieste, per prudenza non si sa
            if rp is not None:
                break
            time.sleep(self.backoff * 2 ** attempt)
        with self._lock:
            self._robots[origin] = rp
            self._why[origin] = why
        return rp

    def why_unknown(self, url: str) -> str:
        p = urlsplit(url)
        return self._why.get(f"{p.scheme}://{p.netloc}", "")

    def allowed(self, url: str) -> bool | None:
        """True/False secondo robots.txt, None se non raggiungibile."""
        p = urlsplit(url)
        rp = self._robots_for(f"{p.scheme}://{p.netloc}")
        return None if rp is None else rp.can_fetch(url, USER_AGENT)

    def sitemaps(self, origin: str) -> list[str]:
        """Indirizzi "Sitemap:" dichiarati nel robots.txt (già scaricato per i controlli)."""
        rp = self._robots_for(origin)
        return [urljoin(origin + "/", sm) for sm in rp.sitemaps] if rp else []  # alcuni siti dichiarano "Sitemap: /SiteMap.aspx"

    def get_api(self, url: str, **kw) -> httpx.Response | None:
        """get() per gli adapter API (Plone, WordPress): robots.txt vietato → None (zero eventi), non raggiungibile → ConnectError,
        come fa l'adapter HTML, così run.py lo conta tra le fonti saltate e non tra quelle vuote."""
        try:
            return self.get(url, **kw)
        except Blocked as e:
            log.warning("robots.txt non permette %s", e)
            return None
        except RobotsUnknown as e:
            raise httpx.ConnectError(f"robots.txt non raggiungibile ({e})") from e

    def get(self, url: str, params: dict | None = None, headers: dict | None = None,
            timeout: httpx.Timeout | float | None = None) -> httpx.Response:
        if params:
            url = str(httpx.URL(url).copy_merge_params(params))
        ok = self.allowed(url)
        if ok is None:
            raise RobotsUnknown(f"{url} [{self.why_unknown(url)}]")
        if not ok:
            raise Blocked(url)
        host = urlsplit(url).netloc
        meta = self._cached(url)
        headers = dict(headers or {})
        extra = {} if timeout is None else {"timeout": timeout}
        if meta:
            if meta.get("etag"):
                headers["If-None-Match"] = meta["etag"]
            if meta.get("last_modified"):
                headers["If-Modified-Since"] = meta["last_modified"]
        for attempt in range(self.retries + 1):
            self._wait(host)
            self.requests += 1
            try:
                res = self._send(url, headers=headers, **extra)
            except httpx.TransportError as e:
                if attempt == self.retries or isinstance(e, CONNECT_FAILED):
                    raise
            else:
                if res.status_code not in RETRY_STATUS or attempt == self.retries:
                    break
            time.sleep(self.backoff * 2 ** attempt)
        if res.status_code == 304 and meta:
            self.hits += 1
            return httpx.Response(200, text=meta["body"], request=res.request)
        if res.status_code == 200 and self.cache_dir and (res.headers.get("etag") or res.headers.get("last-modified")):
            self._store(url, res)
        return res

    def _path(self, url: str) -> Path:
        return self.cache_dir / (hashlib.sha1(url.encode()).hexdigest() + ".json")

    def _cached(self, url: str) -> dict | None:
        if not self.cache_dir:
            return None
        try:
            return json.loads(self._path(url).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _store(self, url: str, res: httpx.Response) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._path(url).write_text(json.dumps({
            "url": url, "etag": res.headers.get("etag", ""), "last_modified": res.headers.get("last-modified", ""),
            "body": res.text}), encoding="utf-8")
