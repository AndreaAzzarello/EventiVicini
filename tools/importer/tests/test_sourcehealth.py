"""sourcehealth.py e salvataggio dello stato: lastOkAt, serie di fallimenti, interruzioni di rete, niente scritture nel dry-run (#16)."""

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import clusters  # noqa: E402
import run  # noqa: E402
import sourcehealth  # noqa: E402
import unreachable  # noqa: E402

D1, D2, D3 = date(2026, 11, 7), date(2026, 11, 8), date(2026, 11, 9)
VUOTO = Path("non-esiste.json")


def stat(events=0, error=None, **kw):
    return {"events": events, "error": error, **kw}


def test_successo_con_eventi_registra_ok_ed_eventi():
    h = sourcehealth.load(VUOTO)
    sourcehealth.update(h, {"a": stat(3)}, D1)
    assert h["sources"]["a"] == {"lastOkAt": "2026-11-07", "failStreak": 0, "lastEventsAt": "2026-11-07"}


def test_successo_senza_eventi_non_sposta_last_events_at():
    h = sourcehealth.load(VUOTO)
    sourcehealth.update(h, {"a": stat(2)}, D1)
    sourcehealth.update(h, {"a": stat(0)}, D2)
    assert h["sources"]["a"]["lastOkAt"] == "2026-11-08" and h["sources"]["a"]["lastEventsAt"] == "2026-11-07"


def test_serie_di_fallimenti_e_azzeramento():
    h = sourcehealth.load(VUOTO)
    sourcehealth.update(h, {"a": stat(2)}, D1)
    sourcehealth.update(h, {"a": stat(error="x" * 300, connect=True)}, D2)
    assert len(h["sources"]["a"]["lastError"]) == 120
    sourcehealth.update(h, {"a": stat(error="y", parked=True)}, D3)
    a = h["sources"]["a"]
    assert a["failStreak"] == 2 and a["lastOkAt"] == "2026-11-07" and a["lastKind"] == "parked" and a["lastError"] == "y"
    sourcehealth.update(h, {"a": stat(1)}, date(2026, 11, 10))
    assert h["sources"]["a"]["failStreak"] == 0
    assert "lastError" not in h["sources"]["a"] and "lastKind" not in h["sources"]["a"]


def test_tipo_di_salto_cluster():
    h = sourcehealth.load(VUOTO)
    sourcehealth.update(h, {"a": stat(error="rete", cluster=True)}, D1)
    assert h["sources"]["a"]["lastKind"] == "cluster"


def test_interruzioni_ricordate_al_massimo_dieci():
    h = sourcehealth.load(VUOTO)
    for i in range(12):
        sourcehealth.record_outage(h, f"10.0.{i}.0/24", "2026-11-07", D3)
    assert len(h["outages"]) == 10
    assert h["outages"][-1]["subnet"] == "10.0.11.0/24" and h["outages"][0]["subnet"] == "10.0.2.0/24"


def test_file_assente_rotto_o_di_altro_tipo(tmp_path):
    vuoto = {"sources": {}, "outages": []}
    assert sourcehealth.load(tmp_path / "x.json") == vuoto
    f = tmp_path / "h.json"
    for contenuto in ("{rotto", "[1, 2]", json.dumps({"sources": 5, "outages": "x"})):
        f.write_text(contenuto, encoding="utf-8")
        assert sourcehealth.load(f) == vuoto


def test_salvataggio_rilettura_e_last_ok(tmp_path):
    f = tmp_path / "h.json"
    h = sourcehealth.load(f)
    sourcehealth.update(h, {"b": stat(1), "a": stat(1)}, D1)
    sourcehealth.save(f, h)
    assert sourcehealth.load(f) == h
    assert list(json.loads(f.read_text(encoding="utf-8"))["sources"]) == ["a", "b"]
    assert sourcehealth.last_ok(h, "a") == "2026-11-07"
    assert sourcehealth.last_ok(h, "zzz") == "" and sourcehealth.last_ok(None, "a") == ""


# --- ticket #16: il dry-run non scrive né lo stato degli host (con net:<subnet>) né la salute ---

def stato_con_cluster():
    state: dict = {}
    unreachable.fail(state, "a.it", D1, "ConnectTimeout")
    clusters.mark_down(state, "93.56.55.0/24", D1, "ConnectTimeout", 91)
    h = sourcehealth.load(VUOTO)
    sourcehealth.update(h, {"a": stat(error="x", cluster=True)}, D1)
    return state, h


def test_persist_state_nel_dry_run_non_scrive_nulla(tmp_path):
    state, health = stato_con_cluster()
    sf, hf = tmp_path / "unreachable.json", tmp_path / "health.json"
    assert run.persist_state(sf, state, hf, health, dry_run=True) is False
    assert not sf.exists() and not hf.exists()


def test_persist_state_nel_dry_run_non_modifica_i_file_di_prima(tmp_path):
    sf, hf = tmp_path / "unreachable.json", tmp_path / "health.json"
    sf.write_text('{"vecchio.it": {"fails": 1, "last": "2026-11-01", "reason": "x"}}', encoding="utf-8")
    hf.write_text('{"outages": [], "sources": {"z": {"lastOkAt": "2026-11-01"}}}', encoding="utf-8")
    prima = (sf.read_text(encoding="utf-8"), hf.read_text(encoding="utf-8"))
    state, health = stato_con_cluster()
    run.persist_state(sf, state, hf, health, dry_run=True)
    assert (sf.read_text(encoding="utf-8"), hf.read_text(encoding="utf-8")) == prima


def test_persist_state_nell_import_vero_salva_stato_cluster_e_salute(tmp_path):
    state, health = stato_con_cluster()
    sf, hf = tmp_path / "unreachable.json", tmp_path / "health.json"
    assert run.persist_state(sf, state, hf, health, dry_run=False) is True
    assert set(unreachable.load(sf)) == {"a.it", "net:93.56.55.0/24"}
    assert sourcehealth.load(hf)["sources"]["a"]["lastKind"] == "cluster"


def test_persist_state_senza_stato_ne_salute_non_scrive_file(tmp_path):  # --source a mano
    run.persist_state(tmp_path / "u.json", None, tmp_path / "h.json", None, dry_run=False)
    assert list(tmp_path.iterdir()) == []
