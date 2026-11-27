"""Comune di Firenze: dataset aperto «Eventi a Firenze» (GeoJSON, nessuno scraping).

GET https://datigis.comune.fi.it/resources/open-data/eventi-a-firenze/destinationflorence_eventi.geojson, un file statico
(circa 200 KB) rigenerato ogni notte verso le 05:00 ora italiana: eventi da oggi a 30 giorni, programmazione ufficiale esposta
su destinationflorence.com. Nessuna chiave; una richiesta a import.
Pagina del dataset: https://opendata.comune.fi.it/page_dataset_show?id=eventi-a-firenze
Licenza dei dati: CC BY 4.0 (metadati del dataset, verificati il 27/11/2026), titolare «Comune di Firenze - Direzione Attività
Economiche e Turismo»; da citare come «Comune di Firenze» con il link alla scheda dell'evento (il `sourceUrl`).

robots.txt: datigis.comune.fi.it ammette tutto (`Disallow:` vuoto). Il portale dati data.comune.fi.it (link `datastore/download.php`
della pagina del dataset) ha invece `Disallow: /`: NON si usa, solo il file diretto su datigis.

Il record non ha immagine né categoria (imageUrl vuoto, categoria dal titolo). Le date sono solo giorni (AAAA-MM-GG); gli orari
stanno nel testo `appuntamenti` («GG/MM/AAAA dalle HH:MM alle HH:MM»), in ora di Roma. Le coordinate sono un MultiPoint (un punto
per sede, non associato ai comuni dell'elenco `comuni`): si usa il primo, se cade nella provincia di Firenze.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta
from typing import ClassVar, Iterator

import httpx

from geo import PROVINCES, in_viewbox, slugify
from mapping import KIDS_RE, ROME, category_from_title, event_id, geocode_queries, html_to_text, map_price, shorten, too_long

log = logging.getLogger("importer")

BASE = "https://www.destinationflorence.com"  # host dei sourceUrl: serve a ok_hosts e alla pulizia degli eventi tolti
API = "https://datigis.comune.fi.it/resources/open-data/eventi-a-firenze/destinationflorence_eventi.geojson"
REGION = "Toscana"
PROVINCE = "FI"
CITY = "Firenze"
MAX_FEATURES = 2000  # oggi circa 124: oltre qualcosa non va
MAX_BYTES = 5_000_000

DATE_RE = re.compile(r"\b(\d{2})/(\d{2})/(\d{4})(?:\s+dalle\s+(\d{1,2})[:.](\d{2})(?:\s+alle\s+(\d{1,2})[:.](\d{2}))?)?")


def _day(value) -> datetime | None:
    try:
        return datetime.combine(datetime.fromisoformat(str(value)[:10]).date(), dtime.min, tzinfo=ROME)
    except ValueError:
        return None


def _at(day: str, month: str, year: str, hour: str | None, minute: str | None) -> datetime | None:
    try:
        return datetime(int(year), int(month), int(day), int(hour or 0), int(minute or 0), tzinfo=ROME)
    except ValueError:
        return None


def _times(item: dict, first: datetime, last: datetime) -> tuple[datetime, datetime]:
    """Una sola data con orario nel testo → quel giorno e quell'ora; altrimenti tutto l'intervallo data_inizio…data_fine."""
    full = (first, last + timedelta(hours=23, minutes=59))
    text = str(item.get("appuntamenti") or "")
    if re.search(r"\bDa\s+\d{2}/\d{2}/\d{4}\s+a\s+\d{2}/\d{2}/\d{4}", text):
        return full  # intervallo con giorni della settimana
    found = DATE_RE.findall(text)
    if len(found) != 1 or not found[0][3]:
        return full
    d, mo, y, h1, m1, h2, m2 = found[0]
    start = _at(d, mo, y, h1, m1)
    if start is None or start.date() < first.date() or start.date() > last.date():
        return full
    end = _at(d, mo, y, h2, m2) if h2 else None
    if end is None or end <= start:
        end = datetime.combine(start.date(), dtime(23, 59), tzinfo=ROME)
    return start, end


def _venue(text: str) -> str:
    m = re.search(r"^Dove:\s*\n\s*(.+)$", text, re.M)
    return " ".join(m.group(1).split()) if m else ""


def _city(comuni) -> str:
    """Firenze se è nell'elenco o l'elenco è vuoto, altrimenti il primo comune."""
    names = [" ".join(c.split()) for c in str(comuni or "").splitlines() if c.strip()]
    return CITY if not names or any(slugify(n) == slugify(CITY) for n in names) else names[0]


@dataclass(frozen=True)
class FirenzeAdapter:
    name: str
    base: str
    city: str
    province: str
    region: str
    viewbox: str | None = None
    api: str = API
    #: fonte regionale: niente scheda comune nella copertura, e nella deduplica vince la fonte comunale
    regional: ClassVar[bool] = True

    def events(self, client: httpx.Client, now: datetime, horizon_days: int) -> Iterator[dict]:
        res = client.get(self.api, headers={"Accept": "application/geo+json, application/json"})
        res.raise_for_status()
        if len(res.content) > MAX_BYTES:
            raise httpx.HTTPError(f"{self.name}: file troppo grande")
        features = res.json().get("features") or []
        if len(features) > MAX_FEATURES:
            raise httpx.HTTPError(f"{self.name}: {len(features)} eventi (oltre {MAX_FEATURES}), mi fermo")
        for f in features:
            if isinstance(f, dict) and isinstance(f.get("properties"), dict):
                yield from self._events(f, now, horizon_days)

    def _events(self, feature: dict, now: datetime, horizon_days: int) -> Iterator[dict]:
        item = feature["properties"]
        url = str(item.get("feelflorence_link") or "").strip()
        title = " ".join(str(item.get("titolo") or "").split())
        first, last = _day(item.get("data_inizio")), _day(item.get("data_fine") or item.get("data_inizio"))
        if not url.startswith(self.base + "/") or not title or first is None or last is None or last < first:
            return
        start, end = _times(item, first, last)
        if end < now or start > now + timedelta(days=horizon_days) or too_long(start, end, url):
            return
        description = shorten(html_to_text(item.get("descrizione") or ""))
        text = str(item.get("appuntamenti") or "")
        venue = _venue(text)
        city = _city(item.get("comuni"))
        coords = ((feature.get("geometry") or {}).get("coordinates")) or []
        point = coords[0] if coords and isinstance(coords[0], list) else coords
        lat = lng = None
        if len(point) >= 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in point[:2]):
            lng, lat = float(point[0]), float(point[1])
            if not in_viewbox(lat, lng, self.viewbox):
                lat = lng = None
        site = str(item.get("link") or "").strip()
        ev = {
            "id": event_id(url),
            "title": title,
            "shortDescription": description,
            "category": category_from_title(title) or "other",  # la descrizione porta troppo rumore (parole di sport in una mostra)
            "priceType": map_price(description),
            "startTime": int(start.timestamp() * 1000),
            "endTime": int(end.timestamp() * 1000),
            "venueName": venue,
            "address": city,
            "lat": lat,
            "lng": lng,
            "imageUrl": "",  # il dataset non ha immagini
            "ticketUrl": site if site.startswith("https://") and " " not in site else "",
            "tags": ["kids"] if KIDS_RE.search(f"{title} {description}") else [],
            "source": "scraper",
            "sourceUrl": url,
            "approxLocation": False,
            "_geocode": geocode_queries("", venue, city),
            "_place": {"city": city, "citySlug": slugify(city), "province": PROVINCE, "region": self.region, "locality": ""},
        }
        yield ev


FIRENZE_VIEWBOX = PROVINCES[PROVINCE][1]
