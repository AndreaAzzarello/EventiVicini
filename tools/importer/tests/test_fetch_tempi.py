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
