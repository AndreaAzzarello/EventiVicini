"""clusters.py: raggruppamento per subnet, sentinelle, giù/su, rilascio dei parcheggi."""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import clusters  # noqa: E402
import unreachable  # noqa: E402

D = date(2026, 11, 7)
SUB = {f"s{i}": "93.56.55.0/24" for i in range(6)} | {"t1": "10.0.0.0/24", "t2": "10.0.0.0/24", "u1": "host:morto.it"}
HOST = {n: f"{n}.it" for n in SUB}


def test_solo_le_subnet_con_abbastanza_fonti_fanno_cluster():
    g = clusters.groups(list(SUB), SUB.get)
    assert list(g) == ["93.56.55.0/24"] and len(g["93.56.55.0/24"]) == 6
    assert clusters.groups(list(SUB), SUB.get, min_sources=2).keys() == {"93.56.55.0/24", "10.0.0.0/24"}  # host:… mai


def test_sentinelle_su_host_diversi():
    host = {"a": "x.it", "b": "x.it", "c": "y.it", "d": "z.it"}
    assert clusters.pick_canaries(["a", "b", "c", "d"], host.get, {}) == ["a", "c"]  # b ha lo stesso host di a


def test_le_sentinelle_preferiscono_host_senza_fallimenti():
    state = {"s0.it": {"fails": 3, "last": "2026-11-01", "reason": "x"}, "s1.it": {"fails": 1, "last": "2026-11-01", "reason": "x"}}
    assert clusters.pick_canaries([f"s{i}" for i in range(6)], HOST.get, state) == ["s2", "s3"]


def test_con_un_solo_host_distinto_non_ci_sono_due_sentinelle():
    assert clusters.pick_canaries(["a", "b"], {"a": "x.it", "b": "x.it"}.get, {}) == ["a"]


def test_giu_solo_se_tutte_le_sentinelle_non_si_connettono():
    assert clusters.is_down(["connect", "connect"])
    assert not clusters.is_down(["connect", ""])  # una risponde
    assert not clusters.is_down(["connect", "budget"])  # il tempo esaurito non è «non si connette»
    assert not clusters.is_down([])


def test_stato_giu_conserva_la_data_di_inizio_e_su_la_restituisce():
    st: dict = {}
    assert clusters.mark_down(st, "93.56.55.0/24", D, "ConnectTimeout", 91) == "2026-11-07"
    assert clusters.mark_down(st, "93.56.55.0/24", date(2026, 11, 9), "ConnectTimeout", 91) == "2026-11-07"
    assert st["net:93.56.55.0/24"] == {"since": "2026-11-07", "last": "2026-11-09", "reason": "ConnectTimeout", "sources": 91}
    assert clusters.mark_up(st, "93.56.55.0/24") == "2026-11-07"
    assert clusters.mark_up(st, "93.56.55.0/24") is None and st == {}


def test_rilascio_dopo_un_cluster_giu_o_con_molti_host_fermi():
    st: dict = {}
    for h in ("s0.it", "s1.it", "s2.it"):
        unreachable.fail(st, h, D, "ConnectTimeout")
    parked = clusters.parked_hosts([f"s{i}" for i in range(6)], HOST.get, st)
    assert parked == ["s0.it", "s1.it", "s2.it"]
    assert clusters.should_release("2026-11-07", parked)  # era dichiarata giù
    assert not clusters.should_release(None, parked)  # 3 host morti in una subnet sana: tengono la scala
    assert clusters.should_release(None, parked + ["s3.it", "s4.it"])  # 5 fermi: stato di prima della logica di cluster
    clusters.release(st, parked)
    assert st == {}
