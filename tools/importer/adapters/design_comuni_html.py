"""Siti comunali sul modello "Design Comuni Italia" (Designers Italia / Bootstrap Italia) letti dall'HTML.

Serve dove non c'è una API REST degli eventi (WordPress DCI "nativo", Drupal, Joomla, fornitori PA).
Scoperta: pagina eventi del registro (card + paginazione) e, se la lista si completa via AJAX, la sitemap
dichiarata in robots.txt. Per ogni dettaglio, in ordine di priorità:
  (a) JSON-LD schema.org/Event  (b) microdata/RDFa  (c) link "Aggiungi al calendario" (Google Calendar; .ics non implementato)
  (d) selettori del modello (Dal/Al, #luogo, #date-e-orari, #costi, "Tipo di evento")  (e) testo libero.
Cortesia: robots.txt, 1 richiesta/s per host, retry, cache ETag (fetch.Fetcher). Niente browser headless.
shortcut: la lista caricata via POST admin-ajax ("Carica altri risultati") non si usa; si ricorre alla sitemap.
"""

from __future__ import annotations

import html
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx
from selectolax.lexbor import LexborHTMLParser

from fetch import CACHE_DIR, Blocked, Fetcher, RobotsUnknown
from relevance import is_season
from mapping import (KIDS_RE, LONG_RUNNING_DAYS, ROME, category_from_title, event_id, geocode_queries, html_to_text,
                     map_price, parse_hours, shorten, too_long)

log = logging.getLogger("importer")

MAX_DETAILS = 40  # dettagli scaricati per comune a ogni import
ARCHIVE_RE = re.compile(r"/(?:archivio(?:-eventi)?|index\.html?)/?$", re.I)
SUMMARY_LINKS = 6  # link ad altri eventi, senza data strutturata: la pagina è un riepilogo
TYPICAL_PATHS = ["/vivere-il-comune/eventi/", "/novita/eventi/", "/eventi/", "/evento/"]
MONTHS = {m: i for i, m in enumerate(
    "gennaio febbraio marzo aprile maggio giugno luglio agosto settembre ottobre novembre dicembre".split(), 1)}
MONTH_ABBR = {m[:3]: i for m, i in MONTHS.items()}
WEEKDAYS = {"lunedì": 0, "lunedi": 0, "martedì": 1, "martedi": 1, "mercoledì": 2, "mercoledi": 2, "giovedì": 3,
            "giovedi": 3, "venerdì": 4, "venerdi": 4, "sabato": 5, "sabati": 5, "domenica": 6, "domeniche": 6}
_MON = "|".join(MONTHS)
DATE_RE = re.compile(rf"\b(\d{{1,2}})\s*(?:°|º)?\s+({_MON})(?:\s+(\d{{4}}))?\b", re.I)
NUM_DATE_RE = re.compile(r"\b(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})\b")
RANGE_RE = re.compile(rf"\bdal\s+(\d{{1,2}})(?:°|º)?(?:\s+({_MON}))?(?:\s+(\d{{4}}))?\s+al\s+(\d{{1,2}})(?:°|º)?\s+({_MON})(?:\s+(\d{{4}}))?\b", re.I)
RECUR_RE = re.compile(r"\b(?:tutti\s+i|tutte\s+le|ogni)\s+(" + "|".join(WEEKDAYS) + r")\b", re.I)
GCAL_RE = re.compile(r"dates=(\d{8})(?:T(\d{6}))?/(\d{8})(?:T(\d{6}))?")
ADDRESS_TAIL = re.compile(r"(?:\s*[-–]\s*|,\s*)[^,\d]+\([A-Z]{2}\).*$|,?\s*\b\d{5}\b.*$")


def _clean(s: str | None) -> str:
    return re.sub(r"\s+", " ", html.unescape(s or "")).strip()


def _year(y: str | None, today: date, month: int, day: int) -> int:
    if y:
        return 2000 + int(y) if len(y) == 2 else int(y)
    # senza anno: il prossimo giorno così (un evento "20 gennaio" a novembre è del prossimo anno)
    return today.year + (1 if date(today.year, month, max(1, min(day, 28))) < today - timedelta(days=60) else 0)


def _date(y: int, m: int, d: int) -> date | None:
    """None per un giorno che non esiste ("31 aprile", "0 maggio", "30/02"): nel testo libero capita."""
    try:
        return date(y, m, d)
    except ValueError:
        return None


def parse_dates(text: str, today: date) -> tuple[date, date] | None:
    """Primo intervallo o giorno nel testo: "dal 3 al 5 novembre 2026", "24 Ottobre 2026", "24/10/26"."""
    t = _clean(text)
    if m := RANGE_RE.search(t):
        d1, m1, y1, d2, m2, y2 = m.groups()
        mon2 = MONTHS[m2.lower()]
        mon1 = MONTHS[m1.lower()] if m1 else mon2
        end = _date(_year(y2, today, mon2, int(d2)), mon2, int(d2))
        start = end and _date(int(y1) if y1 else end.year - (1 if mon1 > mon2 else 0), mon1, int(d1))
        return (start, end) if start and start <= end else None
    found = []
    for m in DATE_RE.finditer(t):
        d, mon, y = int(m.group(1)), MONTHS[m.group(2).lower()], m.group(3)
        if day := _date(_year(y, today, mon, d), mon, d):
            found.append((m.start(), day))
    for m in NUM_DATE_RE.finditer(t):
        d, mon, y = int(m.group(1)), int(m.group(2)), m.group(3)
        if day := _date(2000 + int(y) if len(y) == 2 else int(y), mon, d):
            found.append((m.start(), day))
    found.sort()
    if not found:
        return None
    return found[0][1], found[0][1]


def next_weekday(text: str, start: date, end: date, today: date) -> date | None:
    """"tutti i sabati" / "ogni domenica": prossima data dal giorno in corso dentro [start, end]."""
    m = RECUR_RE.search(text)
    if not m:
        return None
    wd = WEEKDAYS[m.group(1).lower()]
    day = max(start, today)
    day += timedelta(days=(wd - day.weekday()) % 7)
    return day if day <= end else None


def _dt(d: date, t: time) -> datetime:
    return datetime.combine(d, t, ROME)


def span(day1: date, day2: date, hours: list[time]) -> tuple[datetime, datetime]:
    """Inizio e fine: senza orario tutto il giorno, con un solo orario +2 ore (come per Plone)."""
    if not hours:
        return _dt(day1, time(0, 0)), _dt(day2, time(23, 59))
    first = hours[0]
    last = hours[-1] if len(hours) > 1 and (day2 > day1 or hours[-1] > first) else None
    start = _dt(day1, first)
    end = _dt(day2, last) if last else min(start + timedelta(hours=2), _dt(day1, time(23, 59)))
    return start, max(end, start)


# --- sorgenti dei dati dell'evento -------------------------------------------------------------------

def _walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def jsonld_event(tree: LexborHTMLParser) -> dict | None:
    """(a) primo oggetto schema.org di tipo *Event con startDate."""
    for s in tree.css('script[type="application/ld+json"]'):
        try:
            data = json.loads(s.text() or "")
        except ValueError:
            continue
        for n in _walk(data):
            t = n.get("@type")
            types = t if isinstance(t, list) else [t]
            if any(isinstance(x, str) and x.endswith("Event") for x in types) and n.get("startDate"):
                return n
    return None


def microdata_event(tree: LexborHTMLParser) -> dict | None:
    """(b) microdata/RDFa: itemtype .../Event con itemprop startDate/endDate/name/location."""
    node = tree.css_first('[itemtype$="/Event"], [typeof="Event"]')
    if node is None:
        return None

    def prop(name: str) -> str:
        n = node.css_first(f'[itemprop="{name}"], [property="{name}"]')
        return _clean(n.attributes.get("content") or n.attributes.get("datetime") or n.text()) if n else ""

    if not prop("startDate"):
        return None
    return {"name": prop("name"), "startDate": prop("startDate"), "endDate": prop("endDate"),
            "location": {"name": prop("location"), "address": prop("address")}, "description": prop("description")}


def _iso(value: str) -> tuple[date, time | None] | None:
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(ROME)
    return dt.date(), dt.time() if "T" in value and dt.time() != time(0, 0) else None


def from_structured(ev: dict, today: date) -> tuple[datetime, datetime] | None:
    a, b = _iso(str(ev.get("startDate"))), _iso(str(ev.get("endDate") or ev.get("startDate")))
    if not a or not b:
        return None
    hours = [t for t in (a[1], b[1] if b[1] != a[1] or b[0] != a[0] else None) if t]
    return span(a[0], max(b[0], a[0]), hours)


def from_calendar_link(tree: LexborHTMLParser) -> tuple[datetime, datetime] | None:
    """(c) il bottone "Aggiungi al calendario" porta le date esatte nel link Google Calendar."""
    for a in tree.css("a[href]"):
        href = a.attributes.get("href") or ""
        if "calendar.google.com" in href and (m := GCAL_RE.search(href)):
            d1, t1, d2, t2 = m.groups()
            day1, day2 = datetime.strptime(d1, "%Y%m%d").date(), datetime.strptime(d2, "%Y%m%d").date()
            hours = [datetime.strptime(t, "%H%M%S").time() for t in (t1, t2) if t]
            if t2 is None and day2 > day1:  # evento "tutto il giorno": la fine è esclusiva
                day2 -= timedelta(days=1)
            when = span(day1, max(day2, day1), hours)
            # Alcuni temi, senza data di fine, mettono nel link l'ora in cui la pagina è stata generata.
            if abs(when[1] - datetime.now(ROME)) > timedelta(minutes=30) or when[1] - when[0] < timedelta(days=1):
                return when
    return None


# --- pagina di dettaglio ----------------------------------------------------------------------------

def _text_of(node) -> str:
    return _clean(node.text(separator=" ")) if node is not None else ""


def _section(tree: LexborHTMLParser, *ids: str):
    """Sezione per id. In Municipium l'id sta su un'àncora dentro una riga: la sezione sono le righe fino alla prossima àncora."""
    for i in ids:
        n = tree.css_first(f"#{i}")
        if n is None:
            continue
        if n.tag != "a" or n.parent is None or n.parent.parent is None:
            return n
        row, nodes = n.parent.parent, []
        nodes.append(row.html)
        sib = row.next
        while sib is not None and not (sib.css_first("a.anchor-content") if sib.tag not in ("-text", "-comment") else None):
            nodes.append(sib.html or "")
            sib = sib.next
        wrapper = LexborHTMLParser("<div>" + "".join(nodes) + "</div>")
        for anchor in wrapper.css("a.anchor-content"):
            anchor.decompose()
        return wrapper.css_first("div")
    return None


def _heading_section(tree: LexborHTMLParser, label: str) -> str:
    """Testo della sezione il cui titolo è `label` (varianti senza id)."""
    for h in tree.css("h2, h3"):
        if _clean(h.text()).lower() == label:
            parent = h.parent
            return _text_of(parent) if parent is not None else ""
    return ""


def _image(tree: LexborHTMLParser, base: str) -> str:
    for sel in ('meta[property="og:image"]', 'meta[name="twitter:image"]'):
        if (n := tree.css_first(sel)) and n.attributes.get("content"):
            url = urljoin(base, n.attributes["content"])
            if not re.search(r"favicon|logo", url, re.I):  # og:image del tema = icona del sito
                return url
    n = tree.css_first(".it-page-sections-container a[href$='.jpg'], .it-page-sections-container a[href$='.png'], "
                       ".it-page-sections-container a[href$='.jpeg']")
    return urljoin(base, n.attributes["href"]) if n else ""


def _place(tree: LexborHTMLParser) -> tuple[str, str]:
    """(nome del luogo, indirizzo) dalla sezione "Luogo"."""
    sec = _section(tree, "luogo", "luoghi")
    if sec is None:
        return "", ""
    name = _text_of(sec.css_first(".card-title, h3, h4, a"))
    street = _text_of(sec.css_first(".card-text, p, address"))
    return name, street


def parse_detail(page: str, url: str, today: date, fetch=None) -> dict | None:
    """Campi grezzi di un dettaglio: title, start, end, venue, street, description, price_text, tipo, image."""
    tree = LexborHTMLParser(page)
    for sel in ('[data-element="feedback"]', ".cmp-rating"):  # "Quanto sono chiare le informazioni…": h1/h2 del widget
        while (node := tree.css_first(sel)) is not None:
            node.decompose()
    canonical = (tree.css_first('link[rel="canonical"]') or tree.css_first("body")).attributes.get("href") or url
    og = tree.css_first('meta[property="og:title"]')
    # Alcuni temi hanno più <h1> ("Seguici su" nel piè di pagina): meglio l'h1 marcato o og:title
    title_node = tree.css_first('h1[data-element="event-title"]') or tree.css_first("main h1")
    title = _clean(title_node.text()) if title_node else _clean(og.attributes.get("content") if og else "")         or _clean((tree.css_first("h1") or tree.css_first("title")).text())
    if not title:
        return None
    ld = jsonld_event(tree) or microdata_event(tree)
    venue, street = _place(tree)
    meta = tree.css_first('meta[name="description"]')
    desc = html_to_text(meta.attributes.get("content")) if meta else ""
    when = None
    if ld:  # (a)/(b)
        when = from_structured(ld, today)
        loc = ld.get("location")
        loc = loc[0] if isinstance(loc, list) and loc else loc
        loc = loc if isinstance(loc, dict) else {}
        addr = loc.get("address")
        addr = addr.get("streetAddress", "") if isinstance(addr, dict) else (addr if isinstance(addr, str) else "")
        venue, street = venue or _clean(loc.get("name")), street or _clean(addr)
        title = _clean(ld.get("name")) or title
        desc = html_to_text(ld.get("description")) or desc
    if when is None:  # (c)
        when = from_calendar_link(tree)
    exact = when is not None  # data da dati strutturati: una pagina riassuntiva non ne ha
    main = tree.css_first("main") or tree.body
    main_text = _text_of(main)
    sec = _section(tree, "date-e-orari", "dataora", "orari")
    if when is None and sec is not None:  # (d) elenco puntato "27 ott · 20:45 - 22:00" della sezione "Date e orari"
        when = _next_point(sec, today)
        exact = when is not None
    if when is None:  # (d) Dal/Al + orari della sezione
        dates = _dal_al(tree, today)
        if dates:
            when = span(dates[0], dates[1], parse_hours(_text_of(sec)) if sec is not None else [])
    if when is None:  # (e) testo libero
        dates = parse_dates(main_text, today)
        if dates:
            if (d := next_weekday(main_text, dates[0], dates[1], today)):
                dates = (d, d)
            at = DATE_RE.search(main_text) or NUM_DATE_RE.search(main_text)
            when = span(dates[0], dates[1], parse_hours(main_text[at.start(): at.start() + 120]) if at else [])
    if when is None:
        return None
    host, here = urlsplit(url).netloc, urlsplit(url).path.rstrip("/")
    others = {h for a in (tree.css_first("main") or tree.body).css("a[href]")
              if (h := _event_href(urljoin(url, a.attributes.get("href") or ""), host, here))}
    sec = _section(tree, "costi", "costo")
    price_text = _text_of(sec) if sec is not None else _heading_section(tree, "costi")
    tipo = ""
    for strong in tree.css("strong"):
        if _clean(strong.text()).lower() == "tipo di evento" and strong.next is not None:
            tipo = _clean(strong.next.text()).lstrip(": ")
    if not tipo and (c := tree.css_first(".category, .category-top a")):
        tipo = _clean(c.text())
    sec = _section(tree, "cos-e", "cos-", "descrizione")
    if sec is not None and (not desc or desc.startswith("Sito ufficiale")):
        desc = html_to_text(sec.html)
    return {"title": title, "start": when[0], "end": when[1], "venue": venue, "street": street, "description": desc,
            "price_text": price_text or (_clean(str(ld.get("isAccessibleForFree"))) if ld and ld.get("isAccessibleForFree") else ""),
            "tipo": tipo, "image": _image(tree, url), "url": urljoin(url, canonical), "recurring": bool(RECUR_RE.search(main_text)),
            "summary": not exact and len(others) >= SUMMARY_LINKS and not is_season(title)}


def _next_point(sec, today: date) -> tuple[datetime, datetime] | None:
    """Prossima data dell'elenco puntato (.point-list: giorno, mese abbreviato, orari); le righe dello stesso giorno si uniscono."""
    days: dict[date, list[time]] = {}
    marks: list[tuple[date, str, list[time]]] = []
    for pt in sec.css(".point-list"):
        d, m = pt.css_first(".point-date"), pt.css_first(".point-month")
        mon = MONTH_ABBR.get(_clean(m.text()).lower()[:3]) if m else None
        if not (d and mon and _clean(d.text()).isdigit()):
            continue
        day = _date(_year(None, today, mon, int(_clean(d.text()))), mon, int(_clean(d.text())))
        if day is None:
            continue
        label = _text_of(pt.css_first(".point-list-content"))
        marks.append((day, label.lower(), parse_hours(label)))
        days.setdefault(day, []).extend(marks[-1][2])
    if not days:
        return None
    # "24 ott 10:00 Inizio evento" ... "01 nov 19:00 Fine evento": un solo evento su più giorni
    if len(days) > 1 and "inizio" in marks[0][1] and "fine" in marks[-1][1]:
        return span(marks[0][0], marks[-1][0], marks[0][2][:1] + marks[-1][2][-1:])
    day = next((x for x in sorted(days) if x >= today), max(days))
    return span(day, day, sorted(days[day]))


def _dal_al(tree: LexborHTMLParser, today: date) -> tuple[date, date] | None:
    vals: dict[str, date] = {}
    for small in tree.css("small"):
        label = _clean(small.text()).rstrip(":").lower()
        sib = small.next
        while sib is not None and not (sib.tag or "").startswith("h"):
            sib = sib.next
        if label in ("dal", "al") and sib is not None and (p := parse_dates(_clean(sib.text()), today)):
            vals[label] = p[0]
    if "dal" in vals:
        return vals["dal"], max(vals.get("al", vals["dal"]), vals["dal"])
    return None


# --- adapter ----------------------------------------------------------------------------------------

@dataclass(frozen=True)
class DesignComuniHtmlAdapter:
    name: str
    base: str
    city: str
    province: str
    region: str
    viewbox: str | None = None
    url_eventi: str = ""
    max_pages: int = 5
    max_details: int = MAX_DETAILS
    fetcher: Fetcher | None = field(default=None, compare=False)  # solo per i test

    # -- rete
    def _get(self, f: Fetcher, url: str, why: list[str] | None = None) -> str | None:
        """Testo della pagina, o None; why (opzionale) raccoglie il motivo: "Disallow" (robots.txt) oppure "HTTP <codice>"."""
        try:
            res = f.get(url)
        except Blocked as e:
            log.warning("%s: robots.txt non permette %s", self.name, e)
            if why is not None:
                why.append("Disallow")
            return None
        except RobotsUnknown as e:  # errore e non "zero eventi": run.py non deve scambiarlo per una fonte vuota
            raise httpx.ConnectError(f"robots.txt non raggiungibile ({e})") from e
        if res.status_code >= 400 and why is not None:
            why.append(f"HTTP {res.status_code}")
        return res.text if res.status_code < 400 else None

    def _list_urls(self, f: Fetcher, now: datetime) -> list[str]:
        """Link ai dettagli dalla lista (con paginazione) e, se manca roba, dalla sitemap."""
        starts = [self.url_eventi] if self.url_eventi else [self.base + p for p in TYPICAL_PATHS]
        found: dict[str, None] = {}
        listing = ""
        why: list[str] = []
        for start in starts:
            url: str | None = start
            for _ in range(self.max_pages):
                page = self._get(f, url, why) if url else None
                if page is None:
                    break
                listing = listing or url
                links, nxt = parse_list(page, url, now.date())
                found.update(dict.fromkeys(links))
                url = nxt
                if not url:
                    break
            if found:
                break
        if not listing:
            if set(why) == {"Disallow"}:  # il sito risponde ma robots.txt vieta la pagina: scelta del sito, non un guasto
                raise httpx.HTTPError(f"robots.txt vieta la pagina eventi (Disallow): {starts[0]}")
            raise httpx.HTTPError(f"pagina eventi assente o non leggibile ({', '.join(dict.fromkeys(why)) or 'nessuna risposta'}): {starts[0]}")
        if listing:
            path = urlsplit(listing).path.rstrip("/")
            for u in self._sitemap_urls(f, path):
                found.setdefault(u)
        return list(found)[: self.max_details]

    def _sitemap_urls(self, f: Fetcher, path: str) -> list[str]:
        """URL sotto `path` dalla sitemap di robots.txt (più recenti per prima)."""
        sitemaps = f.sitemaps(self.base)[:2]
        urls: list[tuple[str, str]] = []
        for sm in sitemaps:
            xml = self._get(f, sm)
            if xml is None:
                continue
            for loc, mod in re.findall(r"<loc>([^<]+)</loc>(?:\s*<lastmod>([^<]*)</lastmod>)?", xml):
                u = html.unescape(loc.strip())
                if urlsplit(u).path.startswith(path + "/") and urlsplit(u).path.rstrip("/") != path:
                    urls.append((mod or "", u))
        return [u for _, u in sorted(urls, reverse=True)]

    def events(self, client: httpx.Client, now: datetime, horizon_days: int):
        f = self.fetcher or Fetcher(client, cache_dir=CACHE_DIR, retries=4, backoff=3.0)  # server comunali lenti: Fanano ha timeout a intermittenza
        urls = self._list_urls(f, now)
        found = 0
        for url in urls:
            if ARCHIVE_RE.search(urlsplit(url).path):  # archivio e index.html sono elenchi, non eventi
                continue
            page = self._get(f, url)
            if page is None:
                continue
            ev = self.event_from_page(page, url, now, horizon_days)
            if ev is not None:
                found += 1
                yield ev
        log.info("%s: %d pagine evento lette, %d futuri", self.name, len(urls), found)

    def event_from_page(self, page: str, url: str, now: datetime, horizon_days: int) -> dict | None:
        d = parse_detail(page, url, now.astimezone(ROME).date())
        if d is None:
            return None
        start, end = d["start"], d["end"]
        if d["recurring"] and end - start > timedelta(days=LONG_RUNNING_DAYS):  # "tutti i sabati": la prossima data
            day = next_weekday(_clean(d["description"]), start.date(), end.date(), now.astimezone(ROME).date())
            if day:
                start, end = _dt(day, start.timetz().replace(tzinfo=None)), _dt(day, end.timetz().replace(tzinfo=None))
        if end < now or start > now + timedelta(days=horizon_days) or end < start or too_long(start, end, d["url"]):
            return None
        street = ADDRESS_TAIL.sub("", d["street"]).strip(" ,")
        description = shorten(d["description"])
        return {
            "id": event_id(d["url"]),
            "title": d["title"],
            "shortDescription": description,
            "category": category_from_title(f"{d['title']} {d['tipo']}") or "other",
            "priceType": map_price(d["price_text"]),
            "startTime": int(start.timestamp() * 1000),
            "endTime": int(end.timestamp() * 1000),
            "venueName": d["venue"],
            "address": street or self.city,
            "lat": None,
            "lng": None,
            "imageUrl": d["image"],
            "ticketUrl": "",
            "tags": ["kids"] if KIDS_RE.search(f"{d['title']} {d['tipo']}") else [],
            "source": "scraper",
            "sourceUrl": d["url"],
            "approxLocation": False,
            "_geocode": geocode_queries(street, d["venue"], self.city),
            **({"_excluded": "pagina riassuntiva"} if d["summary"] else {}),
        }


EVENT_LINK = re.compile(r"/eventi?/[^/?#]+", re.I)


def _event_href(href: str, host: str, here: str) -> str:
    """href se è un dettaglio evento dello stesso sito (non la lista, non una categoria), altrimenti ""."""
    p = urlsplit(href)
    if p.netloc != host or p.path.rstrip("/") == here or re.search(r"/(tipi_evento|argomento|categoria)/", p.path) or p.query:
        return ""
    return href if EVENT_LINK.search(p.path) or p.path.startswith(here + "/") else ""


def parse_list(page: str, url: str, today: date) -> tuple[list[str], str | None]:
    """Link ai dettagli (saltando le card già finite, se la lista lo dice) e URL della pagina successiva."""
    tree = LexborHTMLParser(page)
    host, here = urlsplit(url).netloc, urlsplit(url).path.rstrip("/")
    links: list[str] = []
    cards = tree.css(".cmp-list-card-img, .cmp-card-latest-messages, .card-wrapper, article")
    for card in cards:
        href = next((h for x in card.css("a[href]") if (h := _event_href(urljoin(url, x.attributes.get("href") or ""), host, here))), "")
        if not href:
            continue
        nums = card.css(".data_num")
        if nums and (p := parse_dates(_clean(nums[-1].text()), today)) and p[0] < today:
            continue  # già finito
        links.append(href.split("#")[0])
    nxt = tree.css_first('a[rel="next"], link[rel="next"], .pagination a[aria-label*="success" i], .pagination .next a')
    href = nxt.attributes.get("href") if nxt else None
    return list(dict.fromkeys(links)), urljoin(url, href) if href and href != "#" else None
