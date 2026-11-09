"""unreachable.py: stato degli host che non rispondono (#26, test di caratterizzazione: il comportamento non cambia)."""

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import unreachable  # noqa: E402

D0 = date(2026, 11, 3)


def test_host_sconosciuto_si_visita_sempre():
    assert unreachable.retry_on({}, "nuovo.it") is None
    assert unreachable.due({}, "nuovo.it", D0)


def test_primo_fallimento_attesa_di_un_giorno():
    st: dict = {}
    unreachable.fail(st, "h.it", D0, "ConnectTimeout")
    assert st["h.it"] == {"fails": 1, "last": "2026-11-03", "reason": "ConnectTimeout"}
    assert not unreachable.due(st, "h.it", D0)
    assert unreachable.due(st, "h.it", date(2026, 11, 4))


def test_oltre_il_terzo_fallimento_resta_sette_giorni():
    st: dict = {}
    for _ in range(6):
        unreachable.fail(st, "h.it", D0, "x")
    assert st["h.it"]["fails"] == 6
    assert unreachable.retry_on(st, "h.it") == date(2026, 11, 10)


def test_il_motivo_si_tronca_a_120_caratteri():
    st: dict = {}
    unreachable.fail(st, "h.it", D0, "x" * 500)
    assert len(st["h.it"]["reason"]) == 120


def test_ok_su_host_assente_non_fa_nulla():
    st = {"altro.it": {"fails": 1, "last": "2026-11-03", "reason": "x"}}
    unreachable.ok(st, "h.it")
    assert list(st) == ["altro.it"]


def test_un_successo_azzera_la_scala():
    st: dict = {}
    unreachable.fail(st, "h.it", D0, "x")
    unreachable.fail(st, "h.it", D0, "x")
    unreachable.ok(st, "h.it")
    unreachable.fail(st, "h.it", D0, "x")
    assert st["h.it"]["fails"] == 1


def test_salvataggio_ordinato_e_rilettura(tmp_path):
    f = tmp_path / "u.json"
    unreachable.save(f, {"b.it": {"fails": 2, "last": "2026-11-03", "reason": "y"}, "a.it": {"fails": 1, "last": "2026-11-03", "reason": "x"}})
    assert list(json.loads(f.read_text(encoding="utf-8"))) == ["a.it", "b.it"]
    assert unreachable.load(f)["b.it"]["fails"] == 2
    assert unreachable.load(tmp_path / "assente.json") == {}
