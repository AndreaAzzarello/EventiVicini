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


def _no_requests(req):
    raise AssertionError(f"GitHub non deve fare richieste per le fonti del Mac: {req.url}")


def test_fonte_del_mac_senza_esito_resta_visibile_senza_richieste():
    """#70 (ipotesi d): pagina di un evento mai visto dal Mac. Prima partiva la richiesta da GitHub (403)."""
    client = httpx.Client(transport=httpx.MockTransport(_no_requests), follow_redirects=True)
    c = LiveChecker(client, set(), None, precomputed={f"{BASE}/eventi/vivo": "online"}, mac_hosts={"WWW.comune.example.it"})
    c.fetcher.min_interval = 0
    assert c(f"{BASE}/eventi/mai-visto/") is True
    assert c.verdict(f"https://www.comune.example.it/eventi/altro") == "skipped"  # www e maiuscole non contano
    assert c(f"{BASE}/eventi/vivo") is True
    assert c.stats["mac_missing"] == 2 and c.stats["mac"] == 1 and c.fetcher.requests == 0


def test_esito_gone_del_mac_vale_anche_per_host_del_mac():
    client = httpx.Client(transport=httpx.MockTransport(_no_requests), follow_redirects=True)
    c = LiveChecker(client, set(), None, precomputed={f"{BASE}/eventi/via": "gone"}, mac_hosts={"comune.example.it"})
    assert c(f"{BASE}/eventi/via/") is False and c.stats["mac"] == 1 and c.stats["mac_missing"] == 0


def test_host_non_del_mac_si_controlla_come_prima():
    c = checker(site({"/eventi/vivo/": httpx.Response(200, text="ok")}))
    c.mac_hosts = {"altro.example.it"}
    assert c(f"{BASE}/eventi/vivo/") is True and c(f"{BASE}/eventi/via/") is False
    assert c.stats["mac_missing"] == 0 and c.fetcher.requests >= 2


def test_skipped_del_mac_e_neutro_per_la_regola_dei_2_giri():
    """Senza verdetto l'evento non conta come giro mancante e il contatore non si azzera; col verdetto gone chiude i 2 giri."""
    from run import plan_writes
    url = f"{BASE}/eventi/x"
    doc = {"source": "scraper", "sourceUrl": url, "startTime": NOW + DAY, "endTime": NOW + 2 * DAY, "missingRuns": 1}
    client = httpx.Client(transport=httpx.MockTransport(_no_requests), follow_redirects=True)

    def run(precomputed):
        c = LiveChecker(client, set(), None, precomputed=precomputed, mac_hosts={"comune.example.it"})
        return plan_writes([], {"id1": doc}, {"comune.example.it"}, NOW, 60 * DAY, still_online=c)["stale"]

    assert run({}) == {}  # skipped: nessun aggiornamento, quindi missingRuns resta 1 (né +1 né reset a 0) e niente removedAt
    assert doc["missingRuns"] == 1
    assert run({url: "online"}) == {}  # online: com'è
    assert run({url: "gone"}) == {"id1": {"missingRuns": 2, "removedAt": NOW}}
    doc0 = dict(doc, missingRuns=0)
    plan = plan_writes([], {"id1": doc0}, {"comune.example.it"}, NOW, 60 * DAY,
                       still_online=LiveChecker(client, set(), None, mac_hosts={"comune.example.it"}))
    assert plan["stale"] == {} and plan["write"] == []


def _src(base, url_eventi="", regional=False):
    from types import SimpleNamespace
    return SimpleNamespace(base=base, url_eventi=url_eventi, regional=regional)


def test_host_del_mac_da_mac_mini_txt_e_host_condivisi():
    """#70: gli host vengono dall'elenco del Mac (non dall'artifact) e un host condiviso con fonti normali si segnala."""
    from run import mac_host_info
    sources = {"jesolo": _src("https://www.comune.jesolo.ve.it", "https://www.comune.jesolo.ve.it/eventi"),
               "altra": _src("https://comune.altra.it"),
               "gemella": _src("https://COMUNE.jesolo.ve.it"),  # stesso sito, senza www e in maiuscolo
               "unione": _src("https://unione.example.it", "https://www.comune.jesolo.ve.it/agenda"),
               "regione": _src("https://www.comune.jesolo.ve.it", regional=True)}
    hosts, shared = mac_host_info(sources, ["jesolo", "inesistente"])
    assert hosts == {"comune.jesolo.ve.it"}
    assert shared == {"comune.jesolo.ve.it": ["gemella", "unione"]}  # la regionale e le fonti del Mac non contano
    assert mac_host_info(sources, ["altra"]) == ({"comune.altra.it"}, {})


def test_log_verdetti_dal_mac_e_host_condiviso(caplog):
    import logging
    from run import log_mac_verdicts
    client = httpx.Client(transport=httpx.MockTransport(_no_requests), follow_redirects=True)
    c = LiveChecker(client, set(), None, precomputed={f"{BASE}/eventi/a": "online"}, mac_hosts={"comune.example.it"})
    c(f"{BASE}/eventi/a")
    c(f"{BASE}/eventi/b")
    c(f"{BASE}/eventi/c")
    with caplog.at_level(logging.INFO, logger="importer"):
        log_mac_verdicts(c, 5, {"comune.example.it": ["gemella"]})
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "Verdetti dal Mac: 5 letti, 1 usati, 2 mancanti" in text
    assert "host del Mac condiviso con: gemella (comune.example.it)" in text
    assert c.fetcher.requests == 0  # host condiviso: nessuna richiesta da GitHub


def test_ticketmaster_nessuna_richiesta_verdetto_skipped():
    calls = []

    def handler(req):
        calls.append(req.url)
        return httpx.Response(200)
    c = checker(handler)
    url = "https://app.ticketmaster.com/discovery/v2/events/abc?apikey=SEGRETA"
    assert c.verdict(url) == "skipped" and c(url) is True
    assert calls == []


def test_url_http_di_host_https_si_richiede_in_https():
    seen = []

    def handler(req):
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        seen.append(str(req.url))
        return httpx.Response(200) if req.url.scheme == "https" else httpx.Response(400)  # Trecenta: http → 400
    client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
    c = LiveChecker(client, set(), None, https_hosts={"comune.example.it"})
    c.fetcher.min_interval = 0
    assert c.verdict("http://comune.example.it/eventi/a") == "online"
    assert seen == ["https://comune.example.it/eventi/a"]
    c2 = LiveChecker(client, set(), None)  # senza l'host https: resta la richiesta http e lo status 400 è «unknown»
    c2.fetcher.min_interval = 0
    assert c2.verdict("http://comune.example.it/eventi/b") == "unknown"
