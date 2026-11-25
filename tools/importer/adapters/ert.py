"""Emilia-Romagna Turismo (APT Servizi): API regionale degli eventi (JSON, nessuno scraping).

GET https://emiliaromagnaturismo.it/opendata/v1/events?lang=it&limit=500&page=N. Nessuna chiave. Limite dichiarato
nell'header X-RateLimit-Limit: 120 richieste; oggi tutti gli eventi (circa 130) stanno in una pagina, quindi una richiesta
a import (al massimo MAX_PAGES, con 1 s di pausa). Un 429 o un 5xx ferma la fonte per quel giro (errore della fonte).
L'API è in migrazione verso visitemiliaromagna.it (host di transizione stage.emiliaromagnaturismo.it): se cambia l'host,
cambiano API e BASE.

Licenza dei dati: CC BY 4.0, da citare come «Emilia Romagna Turismo» con l'URL (il permalink dell'evento è il sourceUrl).
Le immagini hanno licenze proprie (spesso NC/ND/SA) e NON si importano finché l'ente non conferma: imageUrl è sempre vuoto.
Un evento in più comuni (locations) diventa un evento per ogni comune distinto, fino a MAX_PLACES.

Calabria Straordinaria (portale della Regione Calabria, stesso fornitore, stesso schema): GET
https://api.calabriastraordinaria.it/opendata/v1/events?lang=it&limit=1000. Nessuna chiave; l'header X-RateLimit-Limit
dichiara 90 richieste; oggi tutti gli eventi (circa 260) stanno in una pagina, quindi una richiesta a import.
Licenza dei dati: CC BY 4.0, uso anche commerciale con citazione della fonte (verificata a mano su
calabriastraordinaria.it/open-data il 25/11/2026), da citare come «Calabria Straordinaria» con il permalink dell'evento.
Le immagini (http, senza licenza nel record) NON si importano. I record non hanno `status`, `scaduto` né `ticketing`.
Stessa classe, configurata da CALABRIA più sotto: `api`, `status_required`, province e categorie del portale.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, time as dtime, timedelta
from typing import ClassVar, Iterator

import httpx

from geo import PROVINCES, slugify
from mapping import (KIDS_RE, ROME, category_from_title, event_id, geocode_queries, html_to_text, map_price, shorten,
                     too_long)

log = logging.getLogger("importer")

BASE = "https://emiliaromagnaturismo.it"
API = f"{BASE}/opendata/v1/events"
PAGE_SIZE = 500
MAX_PAGES = 5  # 2.500 eventi: oggi sono circa 130, oltre qualcosa non va
PAUSE = 1.0  # secondi tra due richieste
MAX_PLACES = 5
REGION = "Emilia-Romagna"

#: nome ERT della categoria (prima categoria utile vince) → categoria dell'app
CATEGORY = {
    "musica": "music", "eventi enogastronomici": "food", "mercatini e mostre mercato": "market",
    "natale mercati di natale": "market", "per famiglie": "kids", "eventi sportivi": "sport",
    "mostre ed arte": "culture", "opera teatro e danza": "culture", "cinema": "culture", "festival": "culture",
    "fiere congressi": "other", "spettacoli di strada e tradizioni": "culture", "escursioni e visite guidate": "culture",
}
#: sigla delle 9 province dell'Emilia-Romagna per nome slugificato (le forme ERT: «Reggio nell'Emilia», «Forlì-Cesena»)
PROVINCE_CODE = {slugify(PROVINCES[c][0]): c for c in ("BO", "FC", "FE", "MO", "PC", "PR", "RA", "RE", "RN")} | {
    "reggio-nell-emilia": "RE"}

CALABRIA_BASE = "https://calabriastraordinaria.it"
CALABRIA_API = "https://api.calabriastraordinaria.it/opendata/v1/events"
CALABRIA_REGION = "Calabria"
#: l'API scrive «Reggio di Calabria» (anagrafe: «Reggio Calabria»)
PROVINCE_CODE_CALABRIA = {slugify(PROVINCES[c][0]): c for c in ("CS", "CZ", "KR", "RC", "VV")} | {"reggio-di-calabria": "RC"}
#: categorie del portale (nome minuscolo senza punteggiatura) → categoria dell'app; «Eventi multipli» non dice nulla: decide il titolo
CATEGORY_CALABRIA = {
    "musica": "music", "teatro": "culture", "danza": "culture", "mostre": "culture", "cinema e video": "culture",
    "rievocazioni storiche": "culture", "escursioni e visite guidate": "culture", "sagre e feste": "food",
    "mercatini e mostre mercato": "market", "sport e giochi": "sport", "fiere ed esposizioni": "other",
    "congressi convegni conferenze e seminari": "other", "premi e concorsi": "other", "stage corsi e laboratori": "culture",
}


def _day(value) -> datetime | None:
    """Data «2026-12-13» o «2026/12/13» (l'API li mescola), a mezzanotte di Roma."""
    try:
        return datetime.combine(datetime.fromisoformat(str(value).replace("/", "-")[:10]).date(), dtime.min, tzinfo=ROME)
    except ValueError:
        return None


def _category(item: dict, names: dict[str, str] = CATEGORY) -> str:
    for c in item.get("category") or []:
        name = re.sub(r"[\W_]+", " ", str(c.get("name") or "").lower()).strip()
        if names.get(name, "other") != "other":
            return names[name]
    return category_from_title(item.get("title") or "") or "other"


def _for_families(item: dict) -> bool:
    """«Per famiglie» può essere la seconda categoria: la prima decide la categoria dell'app, ma il tag bambini vale lo stesso."""
    return any(re.sub(r"[\W_]+", " ", str(c.get("name") or "").lower()).strip() == "per famiglie" for c in item.get("category") or [])


def _price(item: dict, description: str) -> str:
    """ingresso 2 = gratuito; con pagamento, alcuni a pagamento o rimando al sito si guarda il testo (come le altre fonti)."""
    t = item.get("ticketing") if isinstance(item.get("ticketing"), dict) else {}
    kind = str(t.get("type") or "")  # a volte numero, a volte testo
    if kind == "2":
        return "free"
    return map_price(f"{t.get('entrance') or ''} {description}")


@dataclass(frozen=True)
class ErtAdapter:
    name: str
    base: str
    city: str
    province: str
    region: str
    viewbox: str | None = None
    #: configurazione del portale (i default sono quelli di Emilia Romagna Turismo)
    api: str = API
    page_size: int = PAGE_SIZE
    max_pages: int = MAX_PAGES
    status_required: bool = True  # ERT: solo status 1; Calabria non ha il campo
    provinces: dict[str, str] = field(default_factory=lambda: PROVINCE_CODE)
    categories: dict[str, str] = field(default_factory=lambda: CATEGORY)
    #: fonte regionale: niente scheda comune nella copertura, e nella deduplica vince la fonte comunale
    regional: ClassVar[bool] = True

    def events(self, client: httpx.Client, now: datetime, horizon_days: int) -> Iterator[dict]:
        for page in range(1, self.max_pages + 1):
            res = client.get(self.api, params={"lang": "it", "limit": self.page_size, "page": page}, headers={"Accept": "application/json"})
            res.raise_for_status()
            body = res.json()
            for item in body.get("data") or []:
                yield from self._events(item, now, horizon_days)
            if page >= int((body.get("meta") or {}).get("last_page") or 1):
                return
            time.sleep(PAUSE)
        log.warning("%s: oltre %d pagine, mi fermo", self.name, self.max_pages)

    def _events(self, item: dict, now: datetime, horizon_days: int) -> Iterator[dict]:
        url = str(item.get("permalink") or "")
        title = str(item.get("title") or "").strip()
        dates = item.get("dates") if isinstance(item.get("dates"), dict) else {}
        first = _day(dates.get("from"))
        last = _day(dates.get("to") or dates.get("from"))
        if ((self.status_required and item.get("status") != 1) or item.get("scaduto") or not url.startswith(self.base + "/")
                or not title or first is None or last is None):
            return
        start, end = first, last + timedelta(hours=23, minutes=59)
        if end < start or end < now or start > now + timedelta(days=horizon_days) or too_long(start, end, url):
            return
        description = shorten(html_to_text(item.get("description") or item.get("excerpt") or ""))
        tags = ["kids"] if _for_families(item) or KIDS_RE.search(f"{title} {description}") else []
        ticketing = item.get("ticketing") if isinstance(item.get("ticketing"), dict) else {}
        site = str(ticketing.get("website") or "")
        seen: set[str] = set()
        for place in item.get("locations") or []:
            city = str((place or {}).get("city") or "").strip()
            province = self.provinces.get(slugify(str(place.get("province") or "")))
            if not city or province is None or slugify(city) in seen:
                continue  # senza comune o fuori regione
            seen.add(slugify(city))
            if len(seen) > MAX_PLACES:
                break
            street = ", ".join(p for p in (str(place.get("address") or "").strip(), str(place.get("number") or "").strip()) if p)
            lat, lng = place.get("lat"), place.get("lng")
            has_geo = isinstance(lat, (int, float)) and isinstance(lng, (int, float)) and bool(lat or lng)
            venue = str(place.get("title") or "").strip()
            yield {
                # il primo comune tiene l'id del permalink, gli altri ne derivano uno stabile dal comune
                "id": event_id(url if len(seen) == 1 else f"{url}#{slugify(city)}"),
                "title": title,
                "shortDescription": description,
                "category": _category(item, self.categories),
                "priceType": _price(item, description),
                "startTime": int(start.timestamp() * 1000),
                "endTime": int(end.timestamp() * 1000),
                "venueName": venue,
                "address": ", ".join(p for p in (street, city) if p),
                "lat": float(lat) if has_geo else None,
                "lng": float(lng) if has_geo else None,
                "imageUrl": "",  # licenze delle immagini NC/ND/SA: niente finché ERT non conferma
                "ticketUrl": site if site.startswith("https://") else "",
                "tags": tags,
                "source": "scraper",
                "sourceUrl": url,
                "approxLocation": False,
                "_geocode": geocode_queries(street, venue, city),
                "_place": {"city": city, "citySlug": slugify(city), "province": province, "region": self.region, "locality": ""},
            }
