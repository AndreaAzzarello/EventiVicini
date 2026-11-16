"""#56: un evento la cui pagina risponde ancora non si segna come sparito; sparito davvero (404/410/redirect) sì."""

import sys
from urllib.parse import urlsplit
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


def test_unknown_registrati_per_host_e_motivo():
    def handler(req):
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        if req.url.path.endswith("/boom/"):
            raise httpx.ConnectTimeout("t")
        return httpx.Response(403)
    c = checker(handler)
    for p in ("a", "b"):
        c(f"{BASE}/eventi/{p}/")
    c(f"{BASE}/eventi/boom/")
    host = urlsplit(BASE).netloc
    assert c.unknown_by_host == {host: {"HTTP 403": 2, "ConnectTimeout": 1}}
    assert c.unknown_summary() == f"{host}: ConnectTimeout 1, HTTP 403 2"


def test_esito_del_mac_al_posto_della_richiesta_dal_runner():
    """#70: l'host blocca il runner GitHub (403), ma il Mac ha già visto la pagina sparita o viva."""
    def blocked(req):
        return httpx.Response(404) if req.url.path == "/robots.txt" else httpx.Response(403)
    client = httpx.Client(transport=httpx.MockTransport(blocked), follow_redirects=True)
    c = LiveChecker(client, set(), None, precomputed={f"{BASE}/eventi/via/": "gone", f"{BASE}/eventi/vivo": "online",
                                                      f"{BASE}/eventi/boh/": "unknown"})
    c.fetcher.min_interval = 0
    assert c(f"{BASE}/eventi/via") is False  # barra finale e maiuscole dell'host non contano
    assert c(f"{BASE}/eventi/vivo/") is True
    assert c(f"{BASE}/eventi/boh/") is True and c.stats["unknown"] == 1  # esito non certo: si richiede, 403 → resta visibile
    assert c.stats["mac"] == 2 and c.fetcher.requests <= 2


def test_senza_esiti_del_mac_il_comportamento_resta_quello_di_prima():
    c = checker(site({"/eventi/vivo/": httpx.Response(200, text="ok")}))
    assert c(f"{BASE}/eventi/vivo/") is True and c(f"{BASE}/eventi/via/") is False and c.stats["mac"] == 0


def test_lettura_degli_esiti_del_mac(tmp_path):
    import json
    from datetime import datetime, timedelta, timezone
    from liveness import read_mac_results
    now = datetime(2026, 11, 17, 8, 0, tzinfo=timezone.utc)
    f = tmp_path / "_liveness.json"
    assert read_mac_results(tmp_path, now) == {}  # file assente
    f.write_text(json.dumps({"checkedAt": (now - timedelta(hours=2)).isoformat(), "results": {"u": "gone", "v": "boh", "w": "online"}}))
    assert read_mac_results(tmp_path, now) == {"u": "gone", "w": "online"}
    f.write_text(json.dumps({"checkedAt": (now - timedelta(hours=40)).isoformat(), "results": {"u": "gone"}}))
    assert read_mac_results(tmp_path, now) == {}  # troppo vecchio
    f.write_text("non è json")
    assert read_mac_results(tmp_path, now) == {}
