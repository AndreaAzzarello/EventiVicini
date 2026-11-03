"""Download cortese: robots.txt (protego), 1 richiesta al secondo per host, retry con backoff,
cache HTTP su disco (ETag / Last-Modified). Condiviso da detect_cms, licenses e dagli adapter HTML."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
from protego import Protego

from registry import USER_AGENT

CACHE_DIR = Path(__file__).parent / ".httpcache"
RETRY_STATUS = {429, 500, 502, 503, 504}
CONNECT_FAILED = (httpx.ConnectError, httpx.ConnectTimeout)  # l'host non risponde: ritentare subito non serve


class Blocked(Exception):
    """robots.txt vieta l'URL."""


class RobotsUnknown(Exception):
    """robots.txt non raggiungibile (5xx o rete): per prudenza non si visita nulla."""


class Fetcher:
    def __init__(self, client: httpx.Client, min_interval: float = 1.0, cache_dir: Path | None = None,
                 retries: int = 3, backoff: float = 1.0):
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

    def _robots_for(self, origin: str) -> Protego | None:
        with self._lock:
            if origin in self._robots:
                return self._robots[origin]
        rp: Protego | None = None
        why = ""
        for attempt in range(self.retries + 1):  # un errore momentaneo non deve spegnere la fonte per tutto l'import
            try:
                self._wait(urlsplit(origin).netloc)
                res = self.client.get(origin + "/robots.txt")
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
            elif res is not None and res.status_code < 500:
                rp = Protego.parse("")  # nessun robots.txt: tutto permesso (RFC 9309)
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

    def get(self, url: str) -> httpx.Response:
        ok = self.allowed(url)
        if ok is None:
            raise RobotsUnknown(f"{url} [{self.why_unknown(url)}]")
        if not ok:
            raise Blocked(url)
        host = urlsplit(url).netloc
        meta = self._cached(url)
        headers = {}
        if meta:
            if meta.get("etag"):
                headers["If-None-Match"] = meta["etag"]
            if meta.get("last_modified"):
                headers["If-Modified-Since"] = meta["last_modified"]
        for attempt in range(self.retries + 1):
            self._wait(host)
            self.requests += 1
            try:
                res = self.client.get(url, headers=headers)
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
