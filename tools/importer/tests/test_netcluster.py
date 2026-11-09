"""netcluster.py: da host a IP e subnet, con DNS finto."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from netcluster import NetGate, Network, bare_host, subnet_of  # noqa: E402

DNS = {"dueville.it": "93.56.55.249", "monselice.it": "93.56.55.248", "altro.it": "217.64.201.219", "v6.it": "2001:db8:abcd:1::7"}


def rete(chiamate=None):
    def resolver(host):
        if chiamate is not None:
            chiamate.append(host)
        return DNS.get(host)
    return Network(resolver)


def test_subnet_ipv4_e_ipv6():
    assert subnet_of("93.56.55.249") == "93.56.55.0/24"
    assert subnet_of("2001:db8:abcd:1::7") == "2001:db8:abcd::/48"


def test_porta_e_maiuscole_non_cambiano_l_host():
    assert bare_host("WWW.Dueville.it:8443") == "www.dueville.it"
    assert bare_host("utente@dueville.it") == "dueville.it"
    assert bare_host("[2001:db8::1]:443") == "2001:db8::1"


def test_host_dello_stesso_fornitore_hanno_la_stessa_subnet():
    n = rete()
    assert n.subnet("dueville.it") == n.subnet("monselice.it") == "93.56.55.0/24"
    assert n.ip("dueville.it") != n.ip("monselice.it")
    assert n.subnet("altro.it") == "217.64.201.0/24"
    assert n.subnet("v6.it") == "2001:db8:abcd::/48"


def test_host_non_risolvibile_non_entra_in_nessun_cluster():
    n = rete()
    assert n.ip("morto.it") == n.subnet("morto.it") == "host:morto.it"
    assert n.subnet("morto.it") != n.subnet("morto2.it")


def test_si_risolve_una_volta_sola_anche_senza_riuscire():
    chiamate: list[str] = []
    n = rete(chiamate)
    for _ in range(3):
        n.ip("dueville.it:443")
        n.ip("morto.it")
    assert sorted(chiamate) == ["dueville.it", "morto.it"]


def test_prefetch_risolve_tutto_e_poi_non_richiede_nulla():
    chiamate: list[str] = []
    n = rete(chiamate)
    n.prefetch(["dueville.it", "monselice.it", "altro.it", "dueville.it"])
    assert sorted(chiamate) == ["altro.it", "dueville.it", "monselice.it"]
    n.prefetch(["dueville.it"])
    n.subnet("altro.it")
    assert len(chiamate) == 3


# --- ordine a rotazione ---

def test_interleave_sparge_i_gruppi_in_proporzione():
    from netcluster import interleave

    items = ["a1", "a2", "a3", "a4", "b1", "b2", "c1"]
    assert interleave(items, lambda s: s[0]) == ["a1", "b1", "a2", "c1", "a3", "b2", "a4"]
    assert interleave([], lambda s: s) == []
    assert interleave(["x1", "x2"], lambda s: s[0]) == ["x1", "x2"]  # un solo gruppo: invariato


def test_collect_scarica_a_rotazione_per_subnet_e_conserva_le_statistiche(monkeypatch):
    from datetime import datetime
    from types import SimpleNamespace

    import fetch
    import run
    from mapping import ROME

    ordine: list[str] = []

    class Fonte:
        region, province, viewbox = "Veneto", "VI", None

        def __init__(self, nome, base):
            self.city, self.base = nome, base

        def events(self, client, now, horizon):
            ordine.append(self.city)
            return []

    dns = {"a1.it": "93.56.55.1", "a2.it": "93.56.55.2", "a3.it": "93.56.55.3", "b1.it": "10.0.0.1", "b2.it": "10.0.0.2"}
    sources = {n: Fonte(n, f"https://{n}.it") for n in ("a1", "a2", "a3", "b1", "b2")}
    monkeypatch.setattr(run, "SOURCES", sources)
    monkeypatch.setattr(run, "WORKERS", 1)  # un worker: l'ordine delle chiamate è quello di partenza
    monkeypatch.setattr(fetch, "DEFAULT_GATE", NetGate(Network(dns.get), ip_interval=0))
    stats: dict = {}
    run.collect(httpx_client(), SimpleNamespace(), list(sources), datetime(2026, 11, 3, tzinfo=ROME), 60, stats)
    assert ordine == ["a1", "b1", "a2", "b2", "a3"]
    assert list(stats) == ["a1", "a2", "a3", "b1", "b2"] and all(s["error"] is None for s in stats.values())


def httpx_client():
    import httpx

    return httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
