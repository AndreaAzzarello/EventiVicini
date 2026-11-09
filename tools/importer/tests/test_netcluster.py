"""netcluster.py: da host a IP e subnet, con DNS finto."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from netcluster import Network, bare_host, subnet_of  # noqa: E402

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
