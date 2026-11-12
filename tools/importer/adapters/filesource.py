"""Fonte da file: eventi grezzi scaricati dal Mac mini (scarica.py, #54), riletti e rivalidati qui.

Il Mac è un dato non fidato: ha solo prodotto un file. Qui si controlla tutto come se arrivasse dalla rete:
- file presente, versione e nome della fonte coerenti, scaricato con successo e meno di 36 ore fa; altrimenti la fonte è in
  errore (come un sito irraggiungibile: nessun evento nascosto e nessun host parcheggiato);
- ogni evento è ricostruito con i soli campi attesi e controllato (tipi, lunghezze, categorie ammesse dalle regole di
  Firestore, https, coordinate); `source` è sempre «scraper»;
- `sourceUrl` deve stare sull'host del sito o della pagina eventi della fonte assegnata, e `id` deve essere event_id(sourceUrl);
- al massimo MAX_EVENTS eventi per fonte (i più vicini nel tempo), nella finestra di import.
Ciò che non passa si scarta e si conta nel log.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import ClassVar, Iterator
from urllib.parse import urlsplit

import httpx

from mapping import event_id
from registry import host_key

log = logging.getLogger("importer")
VERSION = 1
MAX_AGE = timedelta(hours=36)
MAX_SKEW = timedelta(minutes=10)  # orologio del Mac avanti rispetto al nostro
MAX_EVENTS = 400
MAX_FILE_BYTES = 5_000_000
CATEGORIES = {"music", "food", "sport", "culture", "kids", "market", "other"}  # come firestore.rules
PRICES = {"free", "low", "premium", "unknown"}
TAGS = {"kids"}
LIMITS = {"title": 300, "shortDescription": 2000, "venueName": 200, "address": 300}
URL_MAX = 2000
MIN_MS, MAX_MS = 1_577_836_800_000, 4_102_444_800_000  # 2020-01-01 … 2100-01-01
PLACE_KEYS = ("city", "citySlug", "province", "region", "locality")


def _str(v, limit: int, required: bool = False) -> str | None:
    if not isinstance(v, str):
        return None if required else ""
    v = v.strip()
    if required and not v:
        return None
    return v[:limit]


def _ms(v) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and MIN_MS <= v <= MAX_MS else None


def _https(v) -> str:
    return v if isinstance(v, str) and v.startswith("https://") and len(v) <= URL_MAX and " " not in v else ""


def _coord(v, lo: float, hi: float):
    """None se assente, il numero se valido, False se non valido."""
    if v is None:
        return None
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi else False


def clean_event(raw, hosts: set[str]) -> dict | None:
    """Evento ricostruito con i soli campi attesi, o None se non passa i controlli."""
    if not isinstance(raw, dict):
        return None
    url = _https(raw.get("sourceUrl"))
    title = _str(raw.get("title"), LIMITS["title"], required=True)
    start, end = _ms(raw.get("startTime")), _ms(raw.get("endTime"))
    if not url or title is None or start is None or end is None or end < start:
        return None
    if host_key(url) not in {host_key(h) for h in hosts} or raw.get("id") != event_id(url):
        return None
    if raw.get("category") not in CATEGORIES or raw.get("priceType") not in PRICES:
        return None
    lat, lng = _coord(raw.get("lat"), -90, 90), _coord(raw.get("lng"), -180, 180)
    if lat is False or lng is False or (lat is None) != (lng is None):
        return None
    queries = raw.get("_geocode")
    geocode = [q[:200] for q in queries if isinstance(q, str)][:5] if isinstance(queries, list) else []
    tags = raw.get("tags")
    ev = {"id": raw["id"], "title": title, "category": raw["category"], "priceType": raw["priceType"],
          "startTime": start, "endTime": end, "lat": lat, "lng": lng, "sourceUrl": url, "source": "scraper",
          "shortDescription": _str(raw.get("shortDescription"), LIMITS["shortDescription"]),
          "venueName": _str(raw.get("venueName"), LIMITS["venueName"]), "address": _str(raw.get("address"), LIMITS["address"]),
          "imageUrl": _https(raw.get("imageUrl")), "ticketUrl": _https(raw.get("ticketUrl")),
          "tags": [t for t in tags if t in TAGS] if isinstance(tags, list) else [],
          "approxLocation": raw.get("approxLocation") is True, "_geocode": geocode}
    place = raw.get("_place")
    if isinstance(place, dict):
        ev["_place"] = {k: _str(place.get(k), 100) or "" for k in PLACE_KEYS}
    return ev


@dataclass(frozen=True)
class FileSourceAdapter:
    name: str
    base: str
    city: str
    province: str
    region: str
    viewbox: str | None = None
    directory: Path = Path(".")
    url_eventi: str = ""
    #: niente richieste di rete: lo stato degli host (parcheggio, cluster) non la riguarda
    from_file: ClassVar[bool] = True

    def _load(self, now: datetime) -> dict:
        path = Path(self.directory) / f"{self.name}.json"
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                raise httpx.HTTPError(f"dati del Mac troppo grandi: {path.name}")
            doc = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise httpx.HTTPError(f"dati del Mac assenti: {path.name}") from None
        except (OSError, ValueError) as e:
            raise httpx.HTTPError(f"dati del Mac illeggibili: {path.name} ({type(e).__name__})") from None
        if not isinstance(doc, dict) or doc.get("version") != VERSION or doc.get("source") != self.name:
            raise httpx.HTTPError(f"dati del Mac non validi: {path.name}")
        if doc.get("ok") is not True or not isinstance(doc.get("events"), list):
            raise httpx.HTTPError(f"il Mac non ha raggiunto la fonte: {str(doc.get('error'))[:120]}")
        try:
            fetched = datetime.fromisoformat(str(doc.get("fetchedAt")))
        except ValueError:
            raise httpx.HTTPError(f"dati del Mac senza data valida: {path.name}") from None
        if fetched.tzinfo is None:
            fetched = fetched.replace(tzinfo=timezone.utc)
        age = now - fetched
        if age > MAX_AGE or age < -MAX_SKEW:
            raise httpx.HTTPError(f"dati del Mac non freschi ({age.total_seconds() / 3600:.0f} ore): {path.name}")
        return doc

    def events(self, client: httpx.Client, now: datetime, horizon_days: int) -> Iterator[dict]:
        doc = self._load(now)
        hosts = {urlsplit(u).netloc for u in (self.base, self.url_eventi) if u}
        now_ms, limit_ms = int(now.timestamp() * 1000), int((now + timedelta(days=horizon_days)).timestamp() * 1000)
        good, dropped = [], 0
        for raw in doc["events"]:
            ev = clean_event(raw, hosts)
            if ev is None:
                dropped += 1
            elif ev["endTime"] >= now_ms and ev["startTime"] <= limit_ms:
                good.append(ev)
        good.sort(key=lambda e: (e["startTime"], e["sourceUrl"]))
        if len(good) > MAX_EVENTS:
            log.warning("%s: %d eventi dal Mac, tengo i primi %d", self.name, len(good), MAX_EVENTS)
        if dropped:
            log.warning("%s: %d eventi del Mac scartati (non validi o su un host non della fonte)", self.name, dropped)
        log.info("%s: dal Mac %d eventi validi (scaricati il %s)", self.name, min(len(good), MAX_EVENTS), str(doc["fetchedAt"])[:16])
        yield from good[:MAX_EVENTS]
