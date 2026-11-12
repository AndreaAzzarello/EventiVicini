"""#56: gli eventi spariti da un sito si nascondono anche se l'host dell'evento differisce da quello del sito (www o dominio)."""

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parents[1]))
from registry import host_key  # noqa: E402
from run import source_hosts, stale_updates  # noqa: E402

NOW = 1_800_000_000_000
DAY = 86_400_000


def doc(url: str) -> dict:
    return {"source": "scraper", "sourceUrl": url, "startTime": NOW + DAY, "endTime": NOW + 2 * DAY}


def test_host_key_www_maiuscole_e_netloc():
    assert host_key("https://WWW.Comune.X.it/a") == host_key("comune.x.it") == host_key("www.comune.x.it") == "comune.x.it"


def test_source_hosts_include_il_host_della_pagina_eventi():
    s = SimpleNamespace(base="https://www.comunedifondi.it", url_eventi="https://comune.fondi.lt.it/vivere-il-comune/eventi/")
    assert source_hosts(s) == {"www.comunedifondi.it", "comune.fondi.lt.it"}
    assert source_hosts(SimpleNamespace(base="https://x.it")) == {"x.it"}  # adapter senza url_eventi
    assert source_hosts(SimpleNamespace(base="https://x.it", url_eventi="")) == {"x.it"}


def test_evento_su_host_diverso_dal_sito_viene_nascosto_al_secondo_giro():
    docs = {"a": doc("https://comune.fondi.lt.it/e/1") | {"missingRuns": 1}}
    ok = source_hosts(SimpleNamespace(base="https://www.comunedifondi.it", url_eventi="https://comune.fondi.lt.it/eventi/"))
    out = stale_updates(docs, set(), ok, NOW, 60 * DAY)
    assert out["a"]["missingRuns"] == 2 and "removedAt" in out["a"]


def test_www_e_non_www_sono_lo_stesso_host():
    docs = {"a": doc("https://comune.x.it/e/1"), "b": doc("https://www.comune.x.it/e/2")}
    assert set(stale_updates(docs, set(), {"www.comune.x.it"}, NOW, 60 * DAY)) == {"a", "b"}
    assert set(stale_updates(docs, set(), {"comune.x.it"}, NOW, 60 * DAY)) == {"a", "b"}


def test_host_non_risposto_resta_intatto():
    docs = {"a": doc("https://altro.example/e/1")}
    assert stale_updates(docs, set(), {"comune.x.it"}, NOW, 60 * DAY) == {}
