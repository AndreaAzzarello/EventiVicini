"""collect() con cluster di rete: sentinelle, subnet giù senza parcheggio, ripresa, stato di prima, host morti in subnet sana."""

import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx

sys.path.insert(0, str(Path(__file__).parents[1]))
import fetch  # noqa: E402
import run  # noqa: E402
import unreachable  # noqa: E402
from mapping import ROME  # noqa: E402
from netcluster import NetGate, Network  # noqa: E402

DAY = datetime(2026, 11, 7, tzinfo=ROME)
SUB = "93.56.55.0/24"
NET = f"net:{SUB}"


class Fonte:
    region, province, viewbox = "Veneto", "PD", None

    def __init__(self, host, mondo):
        self.city, self.base, self.mondo, self.calls = host, f"https://{host}.it", mondo, 0

    def events(self, client, now, horizon):
        self.calls += 1
        errore = self.mondo.get(self.city, "ok")
        if errore == "connect":
            raise httpx.ConnectTimeout("robots.txt non raggiungibile")
        if errore == "lettura":
            raise httpx.ReadTimeout("timed out")
        return []


def mondo_di(n_giu=(), stessa_subnet=6, altri=0, **per_host):
    """Fonti s0..s{n-1} in 93.56.55.0/24 (un IP ciascuna) e `altri` fonti t* in un'altra subnet; ritorna (fonti, dns, mondo)."""
    mondo = {f"s{i}": "connect" for i in n_giu} | per_host
    dns = {f"s{i}.it": f"93.56.55.{i + 1}" for i in range(stessa_subnet)} | {f"t{i}.it": f"10.0.0.{i + 1}" for i in range(altri)}
    fonti = {f"s{i}": Fonte(f"s{i}", mondo) for i in range(stessa_subnet)} | {f"t{i}": Fonte(f"t{i}", mondo) for i in range(altri)}
    return fonti, dns, mondo


def giro(monkeypatch, fonti, dns, state, giorno=DAY, retry_wait=None):
    monkeypatch.setattr(run, "SOURCES", fonti)
    monkeypatch.setattr(run, "WORKERS", 1)
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    monkeypatch.setattr(fetch, "DEFAULT_GATE", NetGate(Network(dns.get), ip_interval=0))
    stats: dict = {}
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    run.collect(client, SimpleNamespace(), list(fonti), giorno, 60, stats, None, retry_wait, state)
    return stats


def chiamate(fonti):
    return {n: f.calls for n, f in fonti.items()}


def test_tutto_raggiungibile_nessuno_stato(monkeypatch):
    fonti, dns, _ = mondo_di()
    state: dict = {}
    giro(monkeypatch, fonti, dns, state)
    assert set(chiamate(fonti).values()) == {1} and state == {}


def test_subnet_giu_solo_le_sentinelle_provano_e_nessun_host_si_parcheggia(monkeypatch):
    fonti, dns, _ = mondo_di(n_giu=range(6))
    state: dict = {}
    stats = giro(monkeypatch, fonti, dns, state, retry_wait=0)
    assert chiamate(fonti) == {"s0": 1, "s1": 1, "s2": 0, "s3": 0, "s4": 0, "s5": 0}  # niente secondo giro per le sentinelle
    assert set(state) == {NET}  # nessuna scala per host
    assert state[NET]["since"] == "2026-11-07" and state[NET]["sources"] == 6
    assert all(s.get("cluster") for s in stats.values())
    assert all(s["error"] and "93.56.55.0/24" in s["error"] for n, s in stats.items() if n not in ("s0", "s1"))
    assert "retry" not in stats["s2"]


def test_giorni_di_fila_giu_la_data_di_inizio_resta(monkeypatch):
    fonti, dns, _ = mondo_di(n_giu=range(6))
    state: dict = {}
    giro(monkeypatch, fonti, dns, state)
    giro(monkeypatch, fonti, dns, state, DAY + timedelta(days=2))
    assert state[NET]["since"] == "2026-11-07" and state[NET]["last"] == "2026-11-09" and len(state) == 1


def test_la_ripresa_riprova_subito_tutte_le_fonti_e_toglie_lo_stato(monkeypatch):
    fonti, dns, mondo = mondo_di(n_giu=range(6))
    state: dict = {}
    giro(monkeypatch, fonti, dns, state)
    mondo.clear()  # il fornitore torna raggiungibile
    for f in fonti.values():
        f.calls = 0
    stats = giro(monkeypatch, fonti, dns, state, DAY + timedelta(days=1))
    assert set(chiamate(fonti).values()) == {1} and state == {}
    assert all(s["error"] is None for s in stats.values())


def test_stato_di_prima_con_molti_host_parcheggiati_si_azzera_alla_ripresa(monkeypatch):
    fonti, dns, _ = mondo_di()
    state: dict = {}
    for i in range(6):
        unreachable.fail(state, f"s{i}.it", date(2026, 11, 6), "ConnectTimeout")
        unreachable.fail(state, f"s{i}.it", date(2026, 11, 6), "ConnectTimeout")  # 2 fallimenti: attesa di 3 giorni
    giro(monkeypatch, fonti, dns, state)
    assert set(chiamate(fonti).values()) == {1} and state == {}


def test_host_morti_in_subnet_sana_tengono_la_loro_scala(monkeypatch):
    fonti, dns, _ = mondo_di(n_giu=(0, 1))
    state: dict = {}
    for h in ("s0.it", "s1.it"):
        unreachable.fail(state, h, date(2026, 11, 6), "ConnectTimeout")
        unreachable.fail(state, h, date(2026, 11, 6), "ConnectTimeout")
    stats = giro(monkeypatch, fonti, dns, state)
    assert chiamate(fonti) == {"s0": 0, "s1": 0, "s2": 1, "s3": 1, "s4": 1, "s5": 1}  # sentinelle: s2 e s3, non i morti
    assert set(state) == {"s0.it", "s1.it"} and state["s0.it"]["fails"] == 2
    assert stats["s0"].get("parked") and not any(s.get("cluster") for s in stats.values())


def test_una_sola_sentinella_morta_non_dichiara_giu_la_subnet(monkeypatch):
    fonti, dns, _ = mondo_di(n_giu=(0,))
    state: dict = {}
    stats = giro(monkeypatch, fonti, dns, state)
    assert set(chiamate(fonti).values()) == {1}  # tutte tentate
    assert set(state) == {"s0.it"} and state["s0.it"]["fails"] == 1  # la scala dell'host morto parte
    assert stats["s0"].get("connect") and not any(s.get("cluster") for s in stats.values())


def test_un_errore_di_lettura_su_una_sentinella_vuol_dire_che_l_host_risponde(monkeypatch):
    fonti, dns, _ = mondo_di(n_giu=(0,), s1="lettura")
    state: dict = {}
    giro(monkeypatch, fonti, dns, state)
    assert NET not in state and fonti["s5"].calls == 1


def test_sotto_le_cinque_fonti_vale_la_scala_per_host(monkeypatch):
    fonti, dns, _ = mondo_di(n_giu=range(4), stessa_subnet=4)
    state: dict = {}
    giro(monkeypatch, fonti, dns, state)
    assert set(chiamate(fonti).values()) == {1} and set(state) == {f"s{i}.it" for i in range(4)}


def test_subnet_giu_non_tocca_la_scala_degli_host_gia_fermi_ne_le_altre_subnet(monkeypatch):
    fonti, dns, _ = mondo_di(n_giu=range(6), altri=2)
    state: dict = {}
    unreachable.fail(state, "s4.it", date(2026, 11, 5), "ConnectTimeout")
    unreachable.fail(state, "s4.it", date(2026, 11, 5), "ConnectTimeout")
    giro(monkeypatch, fonti, dns, state)
    assert state["s4.it"]["fails"] == 2 and NET in state
    assert fonti["t0"].calls == 1 and fonti["t1"].calls == 1


def giro_con_salute(monkeypatch, fonti, dns, state, health, giorno=DAY):
    monkeypatch.setattr(run, "SOURCES", fonti)
    monkeypatch.setattr(run, "WORKERS", 1)
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    monkeypatch.setattr(fetch, "DEFAULT_GATE", NetGate(Network(dns.get), ip_interval=0))
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    stats: dict = {}
    run.collect(client, SimpleNamespace(), list(fonti), giorno, 60, stats, None, None, state, None, health)
    return stats


def test_la_salute_registra_successi_cluster_giu_e_poi_la_durata_del_blocco(monkeypatch):
    import sourcehealth

    fonti, dns, mondo = mondo_di()
    state: dict = {}
    health = sourcehealth.load(Path("non-esiste.json"))
    giro_con_salute(monkeypatch, fonti, dns, state, health)  # 7/11: tutte ok
    assert health["sources"]["s3"]["lastOkAt"] == "2026-11-07"
    mondo.update({f"s{i}": "connect" for i in range(6)})
    giro_con_salute(monkeypatch, fonti, dns, state, health, DAY + timedelta(days=1))  # 8/11: giù
    giro_con_salute(monkeypatch, fonti, dns, state, health, DAY + timedelta(days=2))  # 9/11: ancora giù
    assert health["sources"]["s3"]["failStreak"] == 2 and health["sources"]["s3"]["lastKind"] == "cluster"
    assert health["sources"]["s3"]["lastOkAt"] == "2026-11-07" and health["outages"] == []
    mondo.clear()
    giro_con_salute(monkeypatch, fonti, dns, state, health, DAY + timedelta(days=4))  # 11/11: di nuovo su
    assert health["outages"] == [{"subnet": SUB, "since": "2026-11-08", "until": "2026-11-11"}]
    assert health["sources"]["s3"]["failStreak"] == 0 and health["sources"]["s3"]["lastOkAt"] == "2026-11-11"


def test_le_sentinelle_preferiscono_chi_ha_risposto_piu_di_recente(monkeypatch):
    import sourcehealth

    fonti, dns, _ = mondo_di()
    health = sourcehealth.load(Path("non-esiste.json"))
    health["sources"]["s4"] = {"lastOkAt": "2026-11-06"}
    health["sources"]["s5"] = {"lastOkAt": "2026-11-05"}
    chiamati: list[str] = []
    fonti["s4"].events, fonti["s5"].events = (lambda *a, n="s4": chiamati.append(n) or []), (lambda *a, n="s5": chiamati.append(n) or [])
    fonti["s0"].events = lambda *a: (_ for _ in ()).throw(httpx.ConnectTimeout("x"))
    giro_con_salute(monkeypatch, fonti, dns, {}, health)
    assert chiamati[:2] == ["s4", "s5"]  # le prime due sono le sentinelle: ultimo successo più recente


def test_senza_salute_collect_funziona_come_prima(monkeypatch):
    fonti, dns, _ = mondo_di()
    stats = giro(monkeypatch, fonti, dns, {})
    assert all(s["error"] is None for s in stats.values())


def test_senza_limiti_di_rete_o_senza_stato_non_ci_sono_sentinelle(monkeypatch):
    fonti, dns, _ = mondo_di(n_giu=range(6))
    monkeypatch.setattr(run, "SOURCES", fonti)
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    run.collect(client, SimpleNamespace(), list(fonti), DAY, 60, {}, None, None, {})  # nessun gate
    assert set(chiamate(fonti).values()) == {1}
    for f in fonti.values():
        f.calls = 0
    monkeypatch.setattr(fetch, "DEFAULT_GATE", NetGate(Network(dns.get), ip_interval=0))
    run.collect(client, SimpleNamespace(), list(fonti), DAY, 60, {}, None, None, None)  # --source a mano: nessuno stato
    assert set(chiamate(fonti).values()) == {1}
