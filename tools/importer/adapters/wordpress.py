"""Siti comunali WordPress "Design Comuni Italia" (famiglia con endpoint custom /wp-json/wp/v2/eventi).

Una sola GET restituisce tutti gli eventi (nessuna paginazione né filtri): si filtra qui.
I siti DCI "nativi" (Cesena, Ravenna, Serramazzoni) non espongono eventi via REST: zero eventi e un warning.
shortcut: nessun fallback iCal/RSS ({base}/eventi/feed/ è un feed di commenti vuoto, ?ical=1 non esiste
sui siti provati); se un sito ne pubblicasse uno vero, scrivere qui il parser.
"""

from __future__ import annotations

import html
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Iterator

import httpx

from fetch import Fetcher
from mapping import (KIDS_RE, ROME, category_from_title, event_id, geocode_queries, html_to_text, map_price,
                     shorten, too_long)

log = logging.getLogger("importer")

ROUTE_RE = re.compile(r"^/wp/v2/(evento|eventi|event|events)$")
TAG_RE = re.compile(r"<[^>]+>")


def _text(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", s or ""))).strip()


def _local(ts) -> datetime:
    """Timestamp = ora locale scritta come UTC: si toglie il tzinfo e si localizza a Roma."""
    return datetime.fromtimestamp(int(ts), UTC).replace(tzinfo=None).replace(tzinfo=ROME)


def _coord(gps) -> tuple[float, float] | None:
    try:
        return float(gps["lat"]), float(gps["lng"])
    except (TypeError, KeyError, ValueError):
        return None


@dataclass(frozen=True)
class WordpressAdapter:
    name: str
    base: str
    city: str
    province: str
    region: str
    viewbox: str | None = None
    fetcher: Fetcher | None = field(default=None, compare=False)  # solo per i test

    def _items(self, client: httpx.Client) -> list[dict]:
        f = self.fetcher or Fetcher(client, retries=2, backoff=2.0)  # robots.txt, 1 richiesta/s, retry
        headers = {"Accept": "application/json"}
        res = f.get_api(f"{self.base}/wp-json/wp/v2/eventi", headers=headers)
        if res is None:  # robots.txt vieta le API
            return []
        if res.status_code == 404:
            index = f.get_api(f"{self.base}/wp-json/", headers=headers)
            routes = index.json().get("routes", {}) if index is not None and index.status_code == 200 else {}
            route = next((r for r in routes if ROUTE_RE.match(r)), None)
            if route is None:
                log.warning("%s: nessun endpoint eventi REST, zero eventi", self.name)
                return []
            res = f.get_api(f"{self.base}/wp-json{route}", headers=headers)
            if res is None:
                return []
        res.raise_for_status()
        data = res.json()
        return data if isinstance(data, list) else []

    def events(self, client: httpx.Client, now: datetime, horizon_days: int) -> Iterator[dict]:
        for item in self._items(client):
            ev = self._event(item, now, horizon_days)
            if ev is not None:
                yield ev

    def _event(self, item: dict, now: datetime, horizon_days: int) -> dict | None:
        title = _text(item.get("post_title"))
        try:
            start, end = _local(item["data_orario_inizio"]), _local(item["data_orario_fine"])
        except (KeyError, TypeError, ValueError):
            return None
        if not title or not item.get("post_name") or end < start:
            return None
        # URL canonico verificato su Bondeno, Copparo, Goro, Mesola (/eventi/<slug>/ a volte finisce altrove)
        url = f"{self.base}/vivere-il-comune/eventi/{item['post_name']}/"
        if end < now or start > now + timedelta(days=horizon_days) or too_long(start, end, url):
            return None
        luogo = item.get("luogo") if isinstance(item.get("luogo"), dict) else {}
        venue = _text(luogo.get("descrizione") or "")
        street = _text(luogo.get("indirizzo") or "")
        coord = _coord(luogo.get("gps"))
        description = shorten(html_to_text(item.get("descrizione_breve")) or html_to_text(item.get("sottotitolo"))
                              or html_to_text(item.get("descrizione_completa")))
        costs = " ".join(c.get("titolo_costo", "") for c in item.get("costi") or [] if isinstance(c, dict))

        return {
            "id": event_id(url),
            "title": title,
            "shortDescription": description,
            "category": category_from_title(title) or "other",
            "priceType": map_price(costs),
            "startTime": int(start.timestamp() * 1000),
            "endTime": int(end.timestamp() * 1000),
            "venueName": venue,
            "address": street or self.city,
            "lat": coord[0] if coord else None,
            "lng": coord[1] if coord else None,
            "imageUrl": item.get("immagine") or "",
            "ticketUrl": "",
            "tags": ["kids"] if KIDS_RE.search(f"{title} {_text(item.get('a_chi_e_rivolto'))}") else [],
            "source": "scraper",
            "sourceUrl": url,
            "approxLocation": False,
            "_geocode": geocode_queries(street, venue, self.city),
        }
