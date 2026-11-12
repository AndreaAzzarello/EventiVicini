"""#56: un evento la cui pagina risponde ancora non si segna come sparito; sparito davvero (404/410/redirect) sì."""

import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import fetch  # noqa: E402
from liveness import LiveChecker  # noqa: E402
from run import stale_updates  # noqa: E402

NOW = 1_800_000_000_000
DAY = 86_400_000
BASE = "https://comune.example.it"


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(fetch.time, "sleep", lambda s: None)


def checker(handler, seen=(), max_checks=300) -> LiveChecker:
    client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
    c = LiveChecker(client, set(seen), None, max_checks)
    c.fetcher.min_interval = 0
    return c


def site(pages: dict[str, httpx.Response]):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        return pages.get(req.url.path, httpx.Response(404))
    return handler


def test_200_resta_visibile_404_e_410_si_segnano():
    c = checker(site({"/eventi/vivo/": httpx.Response(200, text="ok"), "/eventi/via/": httpx.Response(410)}))
    assert c(f"{BASE}/eventi/vivo/") is True
    assert c(f"{BASE}/eventi/via/") is False
    assert c(f"{BASE}/eventi/mai-esistito/") is False
    assert c.stats["online"] == 1 and c.stats["gone"] == 2


def test_redirect_ad_altra_pagina_vale_come_sparito():
    c = checker(site({"/eventi/vecchio/": httpx.Response(301, headers={"location": f"{BASE}/eventi/"}),
                      "/eventi/": httpx.Response(200, text="elenco")}))
    assert c(f"{BASE}/eventi/vecchio/") is False


def test_nel_dubbio_resta_visibile_5xx_403_errore_di_rete():
    def handler(req):
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        if req.url.path.endswith("/boom/"):
            raise httpx.ConnectTimeout("t")
        return httpx.Response(403 if "vietato" in req.url.path else 503)
    c = checker(handler)
    assert c(f"{BASE}/eventi/vietato/") is True and c(f"{BASE}/eventi/giu/") is True and c(f"{BASE}/eventi/boom/") is True
    assert c.stats["unknown"] == 3


def test_robots_che_vieta_resta_visibile():
    c = checker(lambda req: httpx.Response(200, text="User-agent: *\nDisallow: /eventi/") if req.url.path == "/robots.txt"
                else httpx.Response(200))
    assert c(f"{BASE}/eventi/x/") is True and c.stats["unknown"] == 1


def test_doppione_copy_con_originale_in_lista_si_nasconde_senza_richieste():
    calls = []
    c = checker(lambda req: calls.append(req) or httpx.Response(200), seen={f"{BASE}/eventi/notte/"})
    assert c(f"{BASE}/eventi/notte-copy/") is False and c(f"{BASE}/eventi/notte-copy-copy/") is False
    assert calls == [] and c.stats["duplicates"] == 2
    assert c(f"{BASE}/eventi/altro-copy/") is True  # l'originale non c'è in lista: l'evento esiste solo con quel nome


def test_tetto_di_controlli_nel_dubbio_resta_visibile():
    c = checker(site({}), max_checks=0)
    assert c(f"{BASE}/eventi/a/") is True and c.stats["skipped"] == 1


def test_risultato_ricordato_una_sola_richiesta():
    calls = []
    c = checker(lambda req: calls.append(req.url.path) or httpx.Response(200 if req.url.path != "/robots.txt" else 404))
    c(f"{BASE}/eventi/a/")
    c(f"{BASE}/eventi/a/")
    assert calls.count("/eventi/a/") == 1


def doc(url: str, **kw) -> dict:
    return {"source": "scraper", "sourceUrl": url, "startTime": NOW + DAY, "endTime": NOW + 2 * DAY} | kw


def test_stale_updates_con_still_online():
    docs = {"vivo": doc(f"{BASE}/e/vivo"), "via": doc(f"{BASE}/e/via"), "altro": doc("https://altro.example/e/1"),
            "fine": doc(f"{BASE}/e/fine", endTime=NOW - DAY)}
    asked = []

    def online(url):
        asked.append(url)
        return url.endswith("vivo")
    out = stale_updates(docs, set(), {BASE.split("//")[1]}, NOW, 60 * DAY, online)
    assert set(out) == {"via"}
    assert sorted(asked) == [f"{BASE}/e/via", f"{BASE}/e/vivo"]  # solo i candidati veri: né altro host né evento finito
    assert set(stale_updates(docs, set(), {BASE.split("//")[1]}, NOW, 60 * DAY)) == {"vivo", "via"}  # senza controllo, come prima
