"""Normalizzazione di un evento Plone (design-comuni-plone) nel modello Event dell'app.

Funzioni pure: niente rete, così si testano con le fixture salvate.
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import re
import unicodedata
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr

ROME = ZoneInfo("Europe/Rome")
log = logging.getLogger("importer")

# Token di tipologia_evento (vocabolario design-comuni-plone) → categoria dell'app.
CATEGORY_BY_TYPE = {
    "maifestazione_musicale": "music",  # sic, refuso nel vocabolario
    "manifestazione_musicale": "music",
    "concerto": "music",
    "mercatino": "market",
    "fiera_o_salone": "market",
    "evento_sportivo": "sport",
    "gara_sportiva": "sport",
    "sagra": "food",
    "evento_gastronomico": "food",
    "eventi_sociali": "other",
    "raduno_di_comunita": "other",
}
CULTURE_TYPES = {
    "mostra", "evento_culturale", "spettacolo_teatrale", "proiezione_cinematografia",
    "visita_guidata", "presentazione_libro", "lettura_pubblica", "manifestazione_artistica",
    "commemorazione", "convegno", "seminario", "giornata_informativa", "riunione_esperti",
    "corso", "laboratorio", "conferenza",
}
# Se la tipologia manca o è generica, decide il titolo.
KEYWORDS = [
    ("kids", r"\b(bambin\w*|bimb\w*|burattin\w*|ludoteca|baby|ragazzi|piccoli|favol\w*|\w*kinder\w*|märchen|puppentheater|enfants?|jeunesse|contes?)\b"),  # + DE/FR
    ("food", r"\b(sagra|degustazion\w*|street food|enogastronom\w*|cena|pranzo|aperitiv\w*|polenta|tortell\w*|gnocco|vino|birra|tartuf\w*|castagn\w*|cucina|gastronom\w*|food|\w*(?:wein|bier|verkostung|speck|knödel)\w*|törggelen|dégustation|repas|apéritif|fromages?|vins?|gastronomie|cuisine)\b"),
    ("sport", r"\b(corsa|camminata|maratona|torneo|partita|gara|sport\w*|bici\w*|ciclo\w*|trekking|yoga|ginnastica|nuoto|calcio|basket|pallavolo|tennis|podistic\w*|palio|\w*lauf|lauf\w*|wander\w*|radtour\w*|turnier\w*|fußball|fussball|skirennen|course|randonnée|tournoi|cyclisme|vélo)\b"),
    ("music", r"\b(concert\w*|music\w*|jazz|rock|orchestra|coro|corale|dj|band|serenata|opera|liric\w*|festival|\w*konzert\w*|musik\w*|chor|orchester|kapelle|oper|musique|chorale|orchestre|fanfare|opéra)\b"),
    ("market", r"\b(mercat\w*|fiera|antiquariato|bancarell\w*|expo|\w*markt|märkte|marché|brocante|foire|vide-grenier|braderie)\b"),
    ("culture", r"\b(teatr\w*|mostra|spettacol\w*|cinema|film|proiezion\w*|libr\w*|museo|visita guidata|laboratorio|conferenza|convegno|presentazione|lettur\w*|incontro|commemorazion\w*|cerimonia|arte|storia|theater\w*|ausstellung\w*|lesung|vortrag|kino|museum|führung|besichtigung|buchvorstellung|konferenz|tagung|feier|gedenk\w*|geschichte|kunst|théâtre|exposition|spectacle|cinéma|projection|lecture|musée|visite guidée|conférence|présentation|atelier|rencontre|cérémonie|commémoration|histoire)\b"),
]
KIDS_RE = re.compile(r"bambin|bimb|ragazz|famigli|kinder|familie|enfants|famille|\b\d{1,2}\s*-\s*\d{1,2}\s*anni|piccoli|kids", re.I)
FREE_RE = re.compile(r"gratuit|gratis|gratutio|libero|free|non\s+(?:sono\s+)?previst\w+\s+cost|senza\s+costi|nessun\s+costo", re.I)
EURO_RE = re.compile(r"(\d+(?:[.,]\d{1,2})?)\s*(?:€|euro)|€\s*(\d+(?:[.,]\d{1,2})?)", re.I)

PREMIUM_FROM_EUR = 25
#: tetto di sicurezza (tutti gli adapter): oltre è un dato palesemente sbagliato (anno errato, evento permanente)
MAX_EVENT_DAYS = 365
#: oltre questa durata l'evento è "longRunning" (mostra, rassegna): resta in lista ma dopo gli eventi puntuali
LONG_RUNNING_DAYS = 14
MAX_DESCRIPTION = 300


_BLOCK_END = re.compile(r"</(?:p|div|h[1-6]|tr|table|ul|ol|blockquote|section|article)\s*>", re.I)


def html_to_text(s: str | None) -> str:
    """HTML → testo semplice: a capo da <br> e blocchi, "• " per le liste, entità decodificate, niente tag.

    Idempotente sul testo già pulito. Gestisce anche l'HTML scritto come entità (&lt;div&gt;), che alcune
    fonti mettono in meta description / JSON-LD.
    """
    if not s:
        return ""
    if re.search(r"&lt;/?[a-z]", s, re.I):
        s = html.unescape(s)
    s = re.sub(r"(?is)<(script|style)\b.*?</\1\s*>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = _BLOCK_END.sub("\n", s)
    s = re.sub(r"(?i)<li\b[^>]*>", "\n• ", s)
    s = re.sub(r"</?[a-zA-Z][^>]*>", "", s)  # tag restanti; "a < b" e "<3" restano
    s = html.unescape(s).replace("\xa0", " ")
    lines = [" ".join(line.split()) for line in s.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def one_line(s: str | None) -> str:
    """Titolo, luogo, indirizzo: testo pulito su una riga."""
    return " ".join(html_to_text(s).split())


def shorten(text: str) -> str:
    """Descrizione breve: al massimo MAX_DESCRIPTION caratteri, tagliata su una parola."""
    if len(text) <= MAX_DESCRIPTION:
        return text
    return text[: MAX_DESCRIPTION - 1].rsplit(" ", 1)[0].rstrip() + "…"


def too_long(start: datetime, end: datetime, url: str) -> bool:
    """True (e log) se la durata supera il tetto di sicurezza."""
    if (end - start).days <= MAX_EVENT_DAYS:  # giorni interi, come nel messaggio: 365 giorni e 5 ore non sono "oltre 365"
        return False
    log.warning("  durata di %d giorni (oltre %d), scartato: %s", (end - start).days, MAX_EVENT_DAYS, url)
    return True


def is_long_running(ev: dict) -> bool:
    return ev["endTime"] - ev["startTime"] > LONG_RUNNING_DAYS * 86_400_000


def event_id(source_url: str) -> str:
    """Id deterministico: lo stesso evento letto ogni giorno aggiorna lo stesso documento."""
    return hashlib.sha1(source_url.encode("utf-8")).hexdigest()[:20]


#: campi di servizio: cambiano a ogni giro o li scrive l'importer dopo, non fanno parte del contenuto
HASH_SKIP = {"id", "createdAt", "updatedAt", "contentHash", "missingRuns", "removedAt", "importRegion"}


def content_hash(ev: dict) -> str:
    """sha256 dei campi normalizzati dell'evento: se non cambia, il documento non va riscritto."""
    body = {k: v for k, v in ev.items() if k not in HASH_SKIP}
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def dedupe_key(ev: dict) -> tuple:
    """Stesso titolo (normalizzato), giorno e comune = stesso evento anche se pubblicato da due siti."""
    day = datetime.fromtimestamp(ev["startTime"] / 1000, ROME).date()
    return (_norm(ev["title"]), day, ev["citySlug"])


def _norm(s: str) -> str:
    """Minuscole, senza accenti né punteggiatura, spazi singoli."""
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", " ", s).strip()


# Testo che nei campi indirizzo non è un indirizzo ("sedi diverse", "vedi nel programma").
NOT_AN_ADDRESS = re.compile(r"\bsedi?\s+(?:diverse|varie)|\bvedi\b|da definire|\bonline\b|a distanza", re.I)
ROAD_RE = re.compile(
    r"\b(?:via|viale|piazza|piazzale|corso|largo|vicolo|strada|stradello|borgo|localit[àa]|loc\.)\s.*", re.I)


def clean_street(s: str) -> str:
    """"ritrovo presso la biglietteria, via Lanfranco" → "via Lanfranco"; "" se non c'è un indirizzo."""
    if NOT_AN_ADDRESS.search(s):
        return ""
    m = ROAD_RE.search(s)
    if not m:
        return s.strip()
    parts = [p.strip() for p in m.group(0).split(",")]
    out = parts[0] + (f", {parts[1]}" if len(parts) > 1 and re.match(r"\d", parts[1]) else "")
    return re.sub(r"^(?:localit[àa]|loc\.)\s+", "", out, flags=re.I)


def geocode_queries(street: str, venue_name: str, city: str) -> list[str]:
    """Indirizzi da provare con Nominatim, dal più preciso: via+civico, via, nome del luogo."""
    street = clean_street(street)
    venue = "" if NOT_AN_ADDRESS.search(venue_name) else re.split(r",| - | e ", venue_name)[0].strip()
    return [f"{p}, {city}" for p in dict.fromkeys([street, re.sub(r",\s*\d.*$", "", street), venue]) if p]


def plaintext(blocks_field) -> str:
    """Testo semplice da un campo a blocchi Volto ({"blocks": {...}, "blocks_layout": ...})."""
    if not isinstance(blocks_field, dict):
        return ""
    blocks = blocks_field.get("blocks") or {}
    order = (blocks_field.get("blocks_layout") or {}).get("items") or list(blocks)
    parts = [(blocks.get(k) or {}).get("plaintext", "") for k in order]
    return " ".join(p.strip() for p in parts if p and p.strip())


def category_from_title(title: str) -> str | None:
    return next((cat for cat, rx in KEYWORDS if re.search(rx, title, re.I)), None)


def map_category(item: dict) -> str:
    t = item.get("tipologia_evento")
    token = t.get("token") if isinstance(t, dict) else None
    if token in CATEGORY_BY_TYPE and CATEGORY_BY_TYPE[token] != "other":
        return CATEGORY_BY_TYPE[token]
    cat = category_from_title(item.get("title", ""))
    if cat:
        return cat
    if token in CULTURE_TYPES:
        return "culture"
    return CATEGORY_BY_TYPE.get(token, "other")


def map_price(text: str) -> str:
    """free / low / premium / unknown. Senza importi né parole di gratuità: unknown ("Prezzo sul sito"), mai un prezzo inventato."""
    amounts = [float((a or b).replace(",", ".")) for a, b in EURO_RE.findall(text)]
    if amounts:
        return "premium" if max(amounts) >= PREMIUM_FROM_EUR else "low"
    return "free" if FREE_RE.search(text) else "unknown"


HOUR_RE = re.compile(
    r"\b([01]?\d|2[0-3])[:.]([0-5]\d)\b|\b(?:ore|alle|dalle)\s+([01]?\d|2[0-3])\b(?![:.]\d)", re.I)


def parse_hours(text: str) -> list[time]:
    """Orari nel testo libero: "dalle ore 8.30 alle 12.30" → [08:30, 12:30]."""
    return [time(int(h or h2), int(m or 0)) for h, m, h2 in HOUR_RE.findall(text)]


def _parse(dt: str) -> datetime:
    return datetime.fromisoformat(dt.replace("Z", "+00:00"))


def _times(item: dict, now: datetime) -> tuple[datetime, datetime] | None:
    """Inizio e fine (aware). Per gli eventi ricorrenti restituisce la prossima occorrenza."""
    start = _parse(item["start"]).astimezone(ROME)
    end = _parse(item["end"]).astimezone(ROME) if item.get("end") else start
    if item.get("whole_day"):
        start = datetime.combine(start.date(), time(0, 0), ROME)
        end = datetime.combine(end.date(), time(23, 59), ROME)
    elif item.get("open_end"):
        end = datetime.combine(start.date(), time(23, 59), ROME)
    elif start.minute % 15 or start.second:
        # Orario non "tondo" (es. 11:33:57): è quello di inserimento, quello vero sta in "orari".
        hours = parse_hours(plaintext(item.get("orari")))
        first = hours[0] if hours else time(0, 0)
        last = hours[1] if len(hours) > 1 and hours[1] > first else (
            time(min(first.hour + 2, 23), first.minute) if hours else time(23, 59))
        start = datetime.combine(start.date(), first, ROME)
        end = datetime.combine(end.date(), last, ROME)

    rule = item.get("recurrence")
    if rule:
        # La fine dei ricorrenti spesso coincide con l'UNTIL: la durata si ricava dall'orario.
        dur = end - start
        if dur >= timedelta(days=1) or dur <= timedelta(0):
            same_day_end = datetime.combine(start.date(), end.timetz())
            dur = same_day_end - start if same_day_end > start else timedelta(hours=2)
        # La regola (con i suoi EXDATE) usa l'orario originale: da lei prendo solo il giorno,
        # l'ora è quella di start. Così regge anche il cambio dell'ora legale.
        try:
            rr = rrulestr(rule, dtstart=_parse(item["start"]), forceset=True)
            for occ in rr.xafter(now - dur - timedelta(days=1), inc=True):
                s = datetime.combine(occ.astimezone(ROME).date(), start.time(), ROME)
                if s + dur >= now:
                    return s, s + dur
        except (ValueError, TypeError):
            pass
        return None
    return start, end


def to_event(item: dict, source: dict, now: datetime, horizon_days: int = 60) -> dict | None:
    """Evento dell'app (senza lat/lng se mancano) o None se va scartato.

    Restituisce anche "_geocode": indirizzi da provare con Nominatim, in ordine.
    """
    title = (item.get("title") or "").strip()
    url = item.get("@id") or ""
    if not title or not url or not item.get("start"):
        return None
    times = _times(item, now)
    if times is None:
        return None
    start, end = times
    if end < now or start > now + timedelta(days=horizon_days) or too_long(start, end, url):
        return None

    venues = item.get("luoghi_correlati") or []
    venue = venues[0] if venues else {}
    city = item.get("city") or venue.get("city") or source["city"]
    venue_name = (item.get("nome_sede") or venue.get("title") or "").strip()
    street = (item.get("street") or venue.get("street") or "").strip()
    address = ", ".join(p for p in [street, f"{item.get('zip_code') or ''} {city}".strip()] if p)

    description = shorten(html_to_text(item.get("description")) or html_to_text(plaintext(item.get("descrizione_estesa"))))

    audience = " ".join([title, plaintext(item.get("descrizione_destinatari"))])
    image = item.get("image") or {}
    scales = image.get("scales") or {}
    image_url = (scales.get("large") or {}).get("download") or image.get("download") or ""
    # Scale piccole CON hash nell'URL (image-200-<hash>.jpeg): il server le serve con cache di 1 anno, mentre quelle senza hash
    # (image/mini) fanno una richiesta condizionale per ogni miniatura a ogni visita (#95). Il web le usa solo per le card.
    image_mini = (scales.get("mini") or {}).get("download") or ""
    image_preview = (scales.get("preview") or {}).get("download") or ""

    geo = item.get("geolocation") or venue.get("geolocation") or {}
    lat, lng = geo.get("latitude"), geo.get("longitude")
    has_geo = bool(lat and lng)

    return {
        "id": event_id(url),
        "title": title,
        "shortDescription": description,
        "category": map_category(item),
        "priceType": map_price(plaintext(item.get("prezzo"))),
        "startTime": int(start.timestamp() * 1000),
        "endTime": int(end.timestamp() * 1000),
        "venueName": venue_name,
        "address": address or city,
        "lat": float(lat) if has_geo else None,
        "lng": float(lng) if has_geo else None,
        "imageUrl": image_url,
        "imageMiniUrl": image_mini,
        "imagePreviewUrl": image_preview,
        "ticketUrl": "",
        "tags": ["kids"] if KIDS_RE.search(audience) else [],
        "source": "scraper",
        "sourceUrl": url,
        "approxLocation": False,
        # Sempre compilato: se le coordinate della fonte risultano fuori provincia si riparte da qui.
        "_geocode": geocode_queries(street, venue_name, city),
    }
