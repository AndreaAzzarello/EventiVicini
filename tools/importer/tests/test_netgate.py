"""NetGate: intervallo per IP, tetto per subnet, pausa dopo timeout consecutivi, misure; integrazione con Fetcher."""

import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import netcluster  # noqa: E402
from fetch import Fetcher  # noqa: E402
from netcluster import NetGate, Network  # noqa: E402

DNS = {"a.it": "93.56.55.248", "b.it": "93.56.55.248", "c.it": "93.56.55.249", "d.it": "217.64.201.219"}


@pytest.fixture
def clock(monkeypatch):
    """Orologio finto: sleep avanza il tempo, nessuna attesa vera."""
    t = SimpleNamespace(now=1000.0, sleeps=[])

    def sleep(s):
        t.sleeps.append(s)
        t.now += s
    monkeypatch.setattr(netcluster, "time", SimpleNamespace(monotonic=lambda: t.now, sleep=sleep))
    return t


def gate(**kw) -> NetGate:
    return NetGate(Network(DNS.get), **kw)


def entra(g, host):
    with g.slot(host):
        pass


def test_due_richieste_allo_stesso_ip_sono_distanziate_anche_se_gli_host_sono_diversi(clock):
    g = gate(ip_interval=1.0)
    entra(g, "a.it")
    entra(g, "b.it")  # stesso IP
    assert clock.sleeps == [1.0]


def test_ip_diversi_della_stessa_subnet_non_si_aspettano(clock):
    g = gate(ip_interval=1.0)
    entra(g, "a.it")
    entra(g, "c.it")  # 93.56.55.249: altro IP
    entra(g, "d.it")
    assert clock.sleeps == []


def test_intervallo_zero_non_aspetta_mai(clock):
    g = gate(ip_interval=0)
    for _ in range(5):
        entra(g, "a.it")
    assert clock.sleeps == []


def test_tetto_di_richieste_in_volo_per_subnet():
    g = gate(ip_interval=0, subnet_concurrency=2)
    dentro, picco, lock = 0, 0, threading.Lock()
    via = threading.Event()

    def lavora(host):
        nonlocal dentro, picco
        with g.slot(host):
            with lock:
                dentro += 1
                picco = max(picco, dentro)
            via.wait(0.2)
            with lock:
                dentro -= 1

    ths = [threading.Thread(target=lavora, args=(h,)) for h in ("a.it", "b.it", "c.it", "a.it", "b.it")]
    [t.start() for t in ths]
    [t.join() for t in ths]
    assert picco == 2


def test_subnet_diverse_non_si_bloccano_a_vicenda():
    g = gate(ip_interval=0, subnet_concurrency=1)
    uscita = threading.Event()
    with g.slot("a.it"):
        t = threading.Thread(target=lambda: (entra(g, "d.it"), uscita.set()))  # altra subnet: passa subito
        t.start()
        assert uscita.wait(2)
        t.join()


def test_dopo_tre_timeout_consecutivi_la_subnet_si_ferma_60_secondi(clock):
    g = gate(ip_interval=0, cooldown_after=3, cooldown=60)
    for host in ("a.it", "b.it", "c.it"):
        g.report(host, False)  # stessa subnet 93.56.55.0/24
    entra(g, "a.it")
    assert clock.sleeps == [60.0] and g.stats()["cooldowns"] == 1
    entra(g, "d.it")  # altra subnet: libera
    assert clock.sleeps == [60.0]


def test_una_risposta_azzera_i_timeout_consecutivi(clock):
    g = gate(ip_interval=0, cooldown_after=3, cooldown=60)
    g.report("a.it", False)
    g.report("b.it", False)
    g.report("c.it", True)
    g.report("a.it", False)
    g.report("b.it", False)
    entra(g, "a.it")
    assert clock.sleeps == [] and g.stats()["cooldowns"] == 0


def test_la_pausa_riguarda_solo_la_propria_subnet(clock):
    g = gate(ip_interval=0, cooldown_after=2, cooldown=30)
    g.report("d.it", False)
    g.report("d.it", False)
    entra(g, "a.it")
    assert clock.sleeps == []
    entra(g, "d.it")
    assert clock.sleeps == [30.0]


def test_misure_richieste_per_ip_picco_e_attese(clock):
    g = gate(ip_interval=1.0)
    for _ in range(4):
        entra(g, "a.it")
    entra(g, "d.it")
    s = g.stats()
    assert s["ips"] == 2 and s["top_ips"]["93.56.55.248"] == {"requests": 4, "peak60": 4}
    assert s["throttle_s"] == pytest.approx(0 + 1 + 1 + 1)
    clock.now += 120
    entra(g, "a.it")
    assert g.stats()["top_ips"]["93.56.55.248"] == {"requests": 5, "peak60": 4}  # finestra di 60 s


# --- integrazione con Fetcher ---

def fetcher(handler, g, **kw):
    return Fetcher(httpx.Client(transport=httpx.MockTransport(handler)), min_interval=0, backoff=0, gate=g, **kw)


def test_il_fetcher_passa_dal_gate_e_riporta_l_esito(clock):
    visti = []

    def handler(req):
        visti.append((req.url.host, clock.now))
        return httpx.Response(200, text="User-agent: *\nDisallow:\n")

    g = gate(ip_interval=1.0)
    fetcher(handler, g).get("https://a.it/x")
    fetcher(handler, g).get("https://b.it/y")  # altro Fetcher, stesso IP: il gate è condiviso
    assert [h for h, _ in visti] == ["a.it", "a.it", "b.it", "b.it"]  # robots.txt e pagina
    assert [t for _, t in visti] == [1000.0, 1001.0, 1002.0, 1003.0]


def test_timeout_di_connessione_nel_fetcher_scatenano_la_pausa(clock):
    def handler(req):
        raise httpx.ConnectTimeout("timed out")

    g = gate(ip_interval=0, cooldown_after=3, cooldown=60)
    for host in ("a.it", "b.it", "c.it"):
        with pytest.raises(Exception):
            fetcher(handler, g).get(f"https://{host}/x")
    assert g.stats()["cooldowns"] == 1


def test_senza_gate_il_fetcher_si_comporta_come_prima(clock):
    f = Fetcher(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=""))), min_interval=0, backoff=0)
    assert f.gate is None and f.get("https://a.it/x").status_code == 200
    assert clock.sleeps == []


# --- collegamento in run.py ---

def test_main_imposta_il_gate_dalle_opzioni_e_lo_toglie_alla_fine(monkeypatch):
    import fetch
    import run

    visti = []

    class Spia(NetGate):
        def __init__(self, *a, **kw):
            visti.append(kw)
            super().__init__(*a, **kw)

    monkeypatch.setattr(run, "NetGate", Spia)
    monkeypatch.setattr(run, "SOURCES", {})
    assert run.main(["--ip-interval", "2.5", "--subnet-concurrency", "3"]) == 1  # nessuna fonte: esce subito
    assert visti == [{"ip_interval": 2.5, "subnet_concurrency": 3}]
    assert fetch.DEFAULT_GATE is None


def test_default_dei_limiti_1_secondo_e_2_richieste():
    import run

    assert (run.IP_INTERVAL, run.SUBNET_CONCURRENCY) == (1.0, 2)
