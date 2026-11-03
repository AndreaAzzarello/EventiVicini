"""Tempi e robustezza del download: misure per fonte, robots.txt (RFC 9309), host irraggiungibili, budget per fonte."""

import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from fetch import Fetcher, RobotsUnknown  # noqa: E402
from mapping import ROME  # noqa: E402

import run  # noqa: E402

NOW = datetime(2026, 11, 3, tzinfo=ROME)


def fetcher(handler, **kw) -> Fetcher:
    kw = {"min_interval": 0, "backoff": 0} | kw
    return Fetcher(httpx.Client(transport=httpx.MockTransport(handler)), **kw)


# --- misure per fonte ---

class Chiama:
    """Fonte finta: n richieste HTTP, poi eventualmente un errore."""
    region, city, province, base = "Emilia-Romagna", "Modena", "MO", "https://www.comune.test.it"

    def __init__(self, n=3, error=None):
        self.n, self.error = n, error

    def events(self, client, now, horizon):
        for _ in range(self.n):
            client.get(self.base + "/x")
        if self.error:
            raise self.error
        return []


def collect(monkeypatch, sources, **kw):
    monkeypatch.setattr(run, "SOURCES", sources)
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    stats: dict = {}
    client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200)))
    run.collect(client, SimpleNamespace(), list(sources), NOW, 60, stats, None, kw.get("retry_wait"))
    return stats


def test_stats_per_fonte_con_secondi_e_richieste(monkeypatch):
    stats = collect(monkeypatch, {"a": Chiama(3), "b": Chiama(5, httpx.ReadTimeout("timed out"))})
    assert stats["a"]["requests"] == 3 and stats["a"]["error"] is None
    assert stats["b"]["requests"] == 5 and "timed out" in stats["b"]["error"]
    assert stats["a"]["seconds"] >= 0


def test_riepilogo_elenca_le_fonti_piu_lente():
    sources = {f"c{i}": SimpleNamespace(city=f"C{i}") for i in range(12)}
    stats = {n: {"events": 0, "skipped": 0, "error": None, "seconds": i * 10.0, "requests": i} for i, n in enumerate(sources)}
    text = run.summary(stats, sources)
    block = text.split("Fonti più lente:")[1].split("Totale")[0]
    assert "| C11 | 110 | 11 | ok |" in block and "| C2 |" in block and "| C1 |" not in block  # solo le 10 più lente


# --- robots.txt (RFC 9309) ---

@pytest.mark.parametrize("status, raises", [(200, False), (404, False), (403, False), (500, True), (503, True)])
def test_robots_status(status, raises):
    f = fetcher(lambda req: httpx.Response(status, text="User-agent: *\nAllow: /") if req.url.path == "/robots.txt"
                else httpx.Response(200, text="ok"))
    if raises:
        with pytest.raises(RobotsUnknown, match=f"HTTP {status}"):
            f.get("https://x.it/pagina")
    else:
        assert f.get("https://x.it/pagina").text == "ok"


def test_robots_errore_di_rete_e_sconosciuto_con_il_motivo():
    def handler(req):
        raise httpx.ConnectTimeout("lento")
    with pytest.raises(RobotsUnknown, match="ConnectTimeout"):
        fetcher(handler).get("https://x.it/pagina")


def test_robots_che_vieta_blocca():
    from fetch import Blocked
    f = fetcher(lambda req: httpx.Response(200, text="User-agent: *\nDisallow: /privato") if req.url.path == "/robots.txt"
                else httpx.Response(200))
    with pytest.raises(Blocked):
        f.get("https://x.it/privato/a")


# --- host irraggiungibili: niente retry sulla connessione ---

def test_connessione_fallita_su_robots_una_sola_richiesta():
    calls = []

    def handler(req):
        calls.append(req.url.path)
        raise httpx.ConnectTimeout("5 s")
    with pytest.raises(RobotsUnknown):
        fetcher(handler, retries=4).get("https://x.it/pagina")
    assert calls == ["/robots.txt"]


def test_timeout_di_lettura_su_robots_al_massimo_un_retry():
    calls = []

    def handler(req):
        calls.append(req.url.path)
        raise httpx.ReadTimeout("30 s")
    with pytest.raises(RobotsUnknown):
        fetcher(handler, retries=4).get("https://x.it/pagina")
    assert calls == ["/robots.txt"] * 2


def test_connessione_fallita_sulla_pagina_non_si_ritenta():
    calls = []

    def handler(req):
        calls.append(req.url.path)
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        raise httpx.ConnectError("rifiutata")
    with pytest.raises(httpx.ConnectError):
        fetcher(handler, retries=4).get("https://x.it/pagina")
    assert calls == ["/robots.txt", "/pagina"]


def test_errore_5xx_sulla_pagina_si_ritenta_ancora():
    calls = []

    def handler(req):
        calls.append(req.url.path)
        return httpx.Response(404 if req.url.path == "/robots.txt" else 503)
    assert fetcher(handler, retries=2).get("https://x.it/pagina").status_code == 503
    assert calls.count("/pagina") == 3


# --- memoria degli host irraggiungibili ---

def test_scala_di_attesa_1_3_7_giorni():
    import unreachable
    from datetime import date

    st: dict = {}
    d0 = date(2026, 11, 3)
    for n, giorni in enumerate([1, 3, 7, 7], start=1):
        unreachable.fail(st, "h.it", d0, "ConnectTimeout")
        assert st["h.it"]["fails"] == n and unreachable.retry_on(st, "h.it") == date(2026, 11, 3 + giorni)
        assert not unreachable.due(st, "h.it", date(2026, 11, 3 + giorni - 1)) and unreachable.due(st, "h.it", date(2026, 11, 3 + giorni))
    unreachable.ok(st, "h.it")
    assert unreachable.due(st, "h.it", d0) and st == {}


def test_stato_su_file(tmp_path):
    import unreachable

    f = tmp_path / "u.json"
    assert unreachable.load(f) == {}  # file assente
    f.write_text("{rotto", encoding="utf-8")
    assert unreachable.load(f) == {}
    unreachable.save(f, {"h.it": {"fails": 1, "last": "2026-11-03", "reason": "x"}})
    assert unreachable.load(f)["h.it"]["fails"] == 1


class Host(Chiama):
    def __init__(self, base, error=None):
        super().__init__(0, error)
        self.base, self.calls = base, 0

    def events(self, client, now, horizon):
        self.calls += 1
        return super().events(client, now, horizon)


def test_collect_parcheggia_l_host_che_non_si_connette(monkeypatch):
    src = Host("https://morto.it", httpx.ConnectError("robots.txt non raggiungibile"))
    state: dict = {}
    sources = {"morto": src}
    monkeypatch.setattr(run, "SOURCES", sources)
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200)))
    stats: dict = {}
    run.collect(client, SimpleNamespace(), ["morto"], NOW, 60, stats, None, 0, state)
    assert src.calls == 1 and stats["morto"]["connect"] and "retry" not in stats["morto"]  # niente secondo giro
    assert state["morto.it"]["fails"] == 1
    # il giorno dopo (1 giorno di attesa) si riprova; lo stesso giorno no
    stats = {}
    run.collect(client, SimpleNamespace(), ["morto"], NOW, 60, stats, None, None, state)
    assert src.calls == 1 and stats["morto"]["parked"] and "riprovo dal 04/11" in stats["morto"]["error"]
    stats = {}
    run.collect(client, SimpleNamespace(), ["morto"], datetime(2026, 11, 4, tzinfo=ROME), 60, stats, None, None, state)
    assert src.calls == 2 and state["morto.it"]["fails"] == 2  # ancora morto: attesa 3 giorni
    # torna a rispondere: sparisce dallo stato
    src.error = None
    stats = {}
    run.collect(client, SimpleNamespace(), ["morto"], datetime(2026, 11, 7, tzinfo=ROME), 60, stats, None, None, state)
    assert src.calls == 3 and state == {} and stats["morto"]["error"] is None


def test_collect_errore_di_lettura_non_parcheggia_e_si_riprova(monkeypatch):
    src = Host("https://lento.it", httpx.ReadTimeout("timed out"))
    state: dict = {}
    monkeypatch.setattr(run, "SOURCES", {"lento": src})
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    stats: dict = {}
    run.collect(httpx.Client(), SimpleNamespace(), ["lento"], NOW, 60, stats, None, 0, state)
    assert src.calls == 2 and state == {} and stats["lento"]["retry"] == "fallito"


def test_collect_senza_stato_non_salta_nulla(monkeypatch):  # --source a mano
    src = Host("https://morto.it", httpx.ConnectError("x"))
    monkeypatch.setattr(run, "SOURCES", {"morto": src})
    for _ in range(2):
        run.collect(httpx.Client(), SimpleNamespace(), ["morto"], NOW, 60, {}, None, None, None)
    assert src.calls == 2


def test_fonte_regionale_non_si_parcheggia(monkeypatch):
    src = Host("https://api.it", httpx.ConnectError("x"))
    src.regional = True
    state: dict = {}
    monkeypatch.setattr(run, "SOURCES", {"reg": src})
    run.collect(httpx.Client(), SimpleNamespace(), ["reg"], NOW, 60, {}, None, None, state)
    assert state == {}


# --- robots.txt per gli adapter API (Plone, WordPress) ---

def test_robots_429_e_sconosciuto():
    with pytest.raises(RobotsUnknown, match="HTTP 429"):
        fetcher(lambda req: httpx.Response(429), retries=0).get("https://x.it/a")


def api_routes(robots, items=None):
    seen = []

    def handler(req):
        seen.append(req.url.path)
        if req.url.path == "/robots.txt":
            return robots if isinstance(robots, httpx.Response) else httpx.Response(200, text=robots)
        return httpx.Response(200, json=items if items is not None else {"items": [], "batching": {}})
    return handler, seen


def plone(handler):
    from adapters.plone import PloneAdapter
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return PloneAdapter("x", "https://www.comune.x.it", "X", "MO", "Emilia-Romagna",
                        fetcher=Fetcher(client, min_interval=0, backoff=0)), client


def wordpress(handler):
    from adapters.wordpress import WordpressAdapter
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return WordpressAdapter("x", "https://www.comune.x.it", "X", "MO", "Emilia-Romagna",
                            fetcher=Fetcher(client, min_interval=0, backoff=0)), client


@pytest.mark.parametrize("make", [plone, wordpress])
def test_api_vietate_da_robots_zero_eventi_e_nessuna_richiesta(make):
    handler, seen = api_routes("User-agent: *\nDisallow: /")
    a, client = make(handler)
    assert list(a.events(client, NOW, 60)) == [] and seen == ["/robots.txt"]


@pytest.mark.parametrize("make", [plone, wordpress])
@pytest.mark.parametrize("robots", [httpx.Response(500), httpx.Response(429)])
def test_api_con_robots_irraggiungibile_e_un_errore(make, robots):
    handler, seen = api_routes(robots)
    a, client = make(handler)
    with pytest.raises(httpx.ConnectError, match="robots.txt non raggiungibile"):
        list(a.events(client, NOW, 60))
    assert set(seen) == {"/robots.txt"}


@pytest.mark.parametrize("make", [plone, wordpress])
def test_api_con_robots_4xx_nessuna_restrizione(make):
    handler, seen = api_routes(httpx.Response(404), items=[] if make is wordpress else None)
    a, client = make(handler)
    assert list(a.events(client, NOW, 60)) == [] and seen[0] == "/robots.txt" and len(seen) == 2
