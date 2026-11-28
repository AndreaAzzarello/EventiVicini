"""Adapter HTML Design Comuni: fixture reali (tests/fixtures/html/<comune>/), nessuna rete."""

import sys
from datetime import date, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from adapters.design_comuni_html import (DesignComuniHtmlAdapter, next_weekday, parse_dates, parse_list,  # noqa: E402
                                         span)
from mapping import ROME  # noqa: E402

FIX = Path(__file__).parent / "fixtures" / "html"
adapter = DesignComuniHtmlAdapter("x", "https://x.it", "X", "BO", "Emilia-Romagna")


def event(slug: str, n: int, today: str) -> dict:
    index = (FIX / "INDEX.md").read_text(encoding="utf-8")
    row = next(line for line in index.splitlines() if line.startswith(f"| {slug} "))
    url = row.split("|")[3].split(" ; ")[n - 1].strip()
    page = (FIX / slug / f"dettaglio-{n}.html").read_text(encoding="utf-8")
    ev = adapter.event_from_page(page, url, datetime.fromisoformat(today).replace(tzinfo=ROME), 365)
    assert ev is not None
    ev["start"] = datetime.fromtimestamp(ev["startTime"] / 1000, ROME).strftime("%Y-%m-%d %H:%M")
    ev["end"] = datetime.fromtimestamp(ev["endTime"] / 1000, ROME).strftime("%Y-%m-%d %H:%M")
    return ev


# (comune, dettaglio, "oggi", titolo, inizio, fine, luogo, indirizzo, prezzo, categoria)
CASES = [
    ("sarsina", 1, "2026-10-20", "Ludi Plautini Sarsinates VIII – 24 ottobre 2026", "2026-10-24 10:15",
     "2026-10-24 18:00", "Teatro Silvio Pellico", "Largo Alcide De Gasperi, 1", "unknown", "culture"),
    ("mercato-saraceno", 1, "2026-10-20", None, "2026-10-23 21:00", "2026-10-23 23:30", "Palazzo Dolcini",
     "Viale Giacomo Matteotti, 2", "free", "culture"),
    ("verghereto", 1, "2025-10-01", None, "2025-10-12 09:00", "2025-10-19 23:00", "Comune di Verghereto",
     "Via Caduti d'Ungheria 11", "free", "food"),
    ("montiano", 1, "2025-09-10", "Sagra del cicciolo", "2025-09-18 19:00", "2025-09-21 23:00", "", "X", "free", "food"),
    ("bagno-di-romagna", 1, "2025-04-20", None, "2025-04-26 20:45", "2025-04-27 09:30", "", "X", "low", "other"),
    ("casina", 1, "2026-06-01", None, "2026-06-09 20:30", "2026-06-09 23:00", "Casa Cantoniera", "via Roma 13, Casina",
     "free", "culture"),
    ("medicina", 2, "2026-10-27", "Pensare Francesco. Storia, memoria e uso politico", "2026-10-27 20:45",
     "2026-10-27 22:00", "Sala del Consiglio", "Via Libertà, 103", "free", "culture"),
    ("pavullo-nel-frignano", 1, "2026-10-27", "Salone dell’Orientamento 2026", "2026-11-07 15:00",
     "2026-11-07 17:00", "Sala Consiliare del Comune di Pavullo", "X", "free", "other"),
    ("granarolo-dell-emilia", 1, "2026-10-20", "La Scuola di Pozioni: un laboratorio di Halloween alla biblioteca Rodari",
     "2026-10-31 00:00", "2026-10-31 23:59", "", "X", "free", "culture"),
    # Municipium (Maggioli): più <h1>, id sulle àncore, "Inizio evento"/"Fine evento" su due giorni
    ("riccione", 1, "2026-10-27", "Il Parco delle zucche: la magia dell'autunno a Villa Lodi Fé", "2026-10-24 10:00",
     "2026-11-01 19:00", "Villa Lodi Fè", "Viale delle Magnolie, 2", "low", "other"),
]


@pytest.mark.parametrize("slug,n,today,title,start,end,venue,address,price,category", CASES)
def test_evento_da_fixture(slug, n, today, title, start, end, venue, address, price, category):
    ev = event(slug, n, today)
    assert (ev["start"], ev["end"]) == (start, end)
    assert (ev["venueName"], ev["address"], ev["priceType"], ev["category"]) == (venue, address, price, category)
    if title:
        assert ev["title"] == title
    assert ev["title"] and ev["source"] == "scraper" and ev["lat"] is None and ev["_geocode"] is not None
    assert ev["sourceUrl"].startswith("https://") and len(ev["id"]) == 20


def test_immagine_e_url_canonico():
    ev = event("sarsina", 1, "2026-10-20")
    assert ev["imageUrl"].endswith("Immagine-2026-10-14-112856.png")  # non l'icona og:image del tema
    assert ev["sourceUrl"].endswith("/ludi-plautini-sarsinates-viii-sarsina-24-ottobre-2026/")


def test_evento_finito_o_oltre_orizzonte_scartato():
    page = (FIX / "sarsina" / "dettaglio-1.html").read_text(encoding="utf-8")
    url = "https://x.it/eventi/ludi/"
    assert adapter.event_from_page(page, url, datetime(2026, 10, 30, tzinfo=ROME), 60) is None  # finito
    assert adapter.event_from_page(page, url, datetime(2026, 5, 1, tzinfo=ROME), 60) is None  # troppo lontano


def test_lista_sarsina_e_paginazione():
    page = (FIX / "sarsina" / "lista.html").read_text(encoding="utf-8")
    links, nxt = parse_list(page, "https://www.comune.sarsina.fc.it/vivere-il-comune/eventi/", date(2025, 1, 1))
    assert len(links) == 3 and all("/vivere-il-comune/eventi/" in u for u in links) and nxt is None
    # una card già finita non porta a scaricare il dettaglio
    later, _ = parse_list(page, "https://www.comune.sarsina.fc.it/vivere-il-comune/eventi/", date(2026, 12, 1))
    assert later == []


def test_lista_senza_link_a_categorie():
    page = (FIX / "granarolo-dell-emilia" / "lista.html").read_text(encoding="utf-8")
    links, _ = parse_list(page, "https://www.comune.granarolo-dellemilia.bo.it/it-it/vivere-il-comune/eventi",
                          date(2026, 10, 20))
    assert len(links) == 4 and not any("?c=" in u or u.endswith(("/storico", "/eventi-principali")) for u in links)


T = date(2026, 10, 27)


@pytest.mark.parametrize("text,expected", [
    ("dal 3 al 5 novembre 2026", (date(2026, 11, 3), date(2026, 11, 5))),
    ("dal 28 ottobre al 2 novembre 2026", (date(2026, 10, 28), date(2026, 11, 2))),
    ("Sabato 24 Ottobre 2026 ore 21:00", (date(2026, 10, 24), date(2026, 10, 24))),
    ("24/10/26", (date(2026, 10, 24), date(2026, 10, 24))),
    ("il 3 novembre", (date(2026, 11, 3), date(2026, 11, 3))),
    ("il 15 gennaio", (date(2027, 1, 15), date(2027, 1, 15))),  # senza anno, a fine anno: il prossimo
    ("nessuna data", None),
])
def test_parse_dates(text, expected):
    assert parse_dates(text, T) == expected


def test_tutti_i_sabati():
    # 27/10/2026 è un martedì: il prossimo sabato è il 31
    assert next_weekday("Ogni sabato dalle 9 alle 12", date(2026, 9, 1), date(2026, 12, 31), T) == date(2026, 10, 31)
    assert next_weekday("tutti i sabati", date(2026, 9, 1), date(2026, 10, 28), T) is None  # finito il periodo
    assert next_weekday("domani", date(2026, 9, 1), date(2026, 12, 31), T) is None


def test_span_orari():
    d = date(2026, 11, 3)
    from datetime import time
    assert span(d, d, []) == (datetime(2026, 11, 3, 0, 0, tzinfo=ROME), datetime(2026, 11, 3, 23, 59, tzinfo=ROME))
    assert span(d, d, [time(21, 0)])[1] == datetime(2026, 11, 3, 23, 0, tzinfo=ROME)  # un solo orario: +2 ore
    assert span(d, d, [time(21, 0), time(22, 30)])[1] == datetime(2026, 11, 3, 22, 30, tzinfo=ROME)


def test_robots_non_raggiungibile_o_lista_assente_e_un_errore_non_zero_eventi():
    import httpx

    from fetch import Fetcher

    def client(robots_status: int, list_status: int) -> httpx.Client:
        def handler(req: httpx.Request) -> httpx.Response:
            if req.url.path == "/robots.txt":
                return httpx.Response(robots_status, text="User-agent: *\nAllow: /")
            return httpx.Response(list_status, text="<html></html>")
        return httpx.Client(transport=httpx.MockTransport(handler))

    now = datetime(2026, 10, 27, tzinfo=ROME)
    for robots, lista in [(503, 200), (200, 404)]:
        a = DesignComuniHtmlAdapter("x", "https://x.it", "X", "BO", "Emilia-Romagna", None, "https://x.it/eventi/",
                                    fetcher=Fetcher(client(robots, lista), min_interval=0, backoff=0))
        with pytest.raises(httpx.HTTPError):
            list(a.events(None, now, 60))
    # lista raggiungibile ma senza eventi: zero eventi, nessun errore
    ok = DesignComuniHtmlAdapter("x", "https://x.it", "X", "BO", "Emilia-Romagna", None, "https://x.it/eventi/",
                                 fetcher=Fetcher(client(200, 200), min_interval=0, backoff=0))
    assert list(ok.events(None, now, 60)) == []


def test_mostra_lunga_importata_e_long_running():
    from mapping import is_long_running

    ev = event("riccione", 2, "2026-10-27")  # Mostra "Vissi d'arte": dal 18 ottobre al 15 novembre
    assert ev["title"].startswith("Mostra") and (ev["start"], ev["end"]) == ("2026-10-18 09:00", "2026-11-15 19:00")
    assert is_long_running(ev)


def test_giorni_inesistenti_nel_testo_libero_non_fanno_cadere_la_fonte():
    from datetime import date

    from adapters.design_comuni_html import parse_dates

    today = date(2026, 10, 28)
    assert parse_dates("0 gennaio", today) is None and parse_dates("31 aprile 2027", today) is None and parse_dates("30/02/2027", today) is None
    assert parse_dates("dal 31 giugno al 2 luglio 2027", today) is None
    assert parse_dates("31 aprile e poi 3 novembre 2026", today) == (date(2026, 11, 3), date(2026, 11, 3))


def test_lista_senza_link_scrive_una_riga_di_diagnosi(caplog):
    """Molise 27 e 28/11: lista vuota a intermittenza. La riga dice se la pagina viene dalla rete o dalla cache, quanto pesa,
    che titolo ha e quante card contiene, così si distingue «nessun evento» da una pagina di manutenzione."""
    import logging

    import httpx

    from adapters.design_comuni_html import describe_page
    from fetch import Fetcher

    assert describe_page("<html><title> Eventi – Comune </title><article>a</article></html>") .startswith("dalla rete, ")
    assert "titolo «Eventi – Comune», 1 card" in describe_page("<html><title> Eventi – Comune </title><article>a</article></html>")
    assert describe_page("<html></html>", cached=True).startswith("da cache, ") and "titolo «», 0 card" in describe_page("<html></html>")

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nAllow: /")
        return httpx.Response(200, text="<html><head><title>Sito in manutenzione</title></head></html>")

    a = DesignComuniHtmlAdapter("x", "https://x.it", "X", "BO", "Emilia-Romagna", None, "https://x.it/eventi/",
                                fetcher=Fetcher(httpx.Client(transport=httpx.MockTransport(handler)), min_interval=0, backoff=0))
    with caplog.at_level(logging.INFO):
        assert list(a.events(None, datetime(2026, 10, 27, tzinfo=ROME), 60)) == []
    assert any("lista senza link a eventi: dalla rete" in r.message and "Sito in manutenzione" in r.message and "0 card" in r.message
               for r in caplog.records)
