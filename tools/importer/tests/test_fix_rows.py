"""fix_rows: controlli prima di scrivere, solo le colonne previste, nessuna rete nei test."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import fix_rows  # noqa: E402
from registry import COLUMNS, read_rows, write_rows  # noqa: E402


def row(**kw) -> dict:
    base = dict.fromkeys(COLUMNS, "") | {"regione": "Lazio", "provincia": "LT", "comune": "Fondi", "stato": "attivo",
                                         "sito": "https://www.comunedifondi.it", "url_eventi": "https://comune.fondi.lt.it/eventi/",
                                         "note": "vecchia nota", "cms": "design_comuni_html"}
    return base | kw


def ok_fetch(url):
    return 200, url


def ok_robots(url):
    return True


FIX = {"regione": "Lazio", "comune": "Fondi", "sito": "https://comune.fondi.lt.it"}


def test_host_key_ignora_www_e_maiuscole():
    assert fix_rows.host_key("https://WWW.Comune.X.it/a") == fix_rows.host_key("https://comune.x.it") == "comune.x.it"


def test_correzione_valida_cambia_solo_sito_e_note():
    rows = [row()]
    before = dict(rows[0])
    (r, _, errs), = fix_rows.apply_fixes(rows, [FIX], "2026-11-12", ok_fetch, ok_robots)
    assert errs == [] and r["sito"] == "https://comune.fondi.lt.it"
    assert {k for k in COLUMNS if rows[0][k] != before[k]} == {"sito", "note"}
    assert "fix_rows 2026-11-12" in rows[0]["note"] and "www.comunedifondi.it" in rows[0]["note"]
    assert rows[0]["note"].startswith("vecchia nota")


def test_rifiuta_http_riga_non_attiva_host_diversi_e_riga_mancante():
    rows = [row()]
    assert "serve https" in fix_rows.problems(rows[0], {"sito": "http://comune.fondi.lt.it"})[0]
    assert "non è attiva" in fix_rows.problems(row(stato="candidato"), FIX)[0]
    assert "host diversi" in fix_rows.problems(rows[0], {"sito": "https://altro.example"})[0]
    (_, _, errs), = fix_rows.apply_fixes(rows, [{"regione": "Lazio", "comune": "Roma", "sito": "https://x.it"}], "d", ok_fetch, ok_robots)
    assert "0 righe" in errs[0]
    assert rows[0]["sito"] == "https://www.comunedifondi.it"  # nulla è cambiato


def test_rifiuta_404_redirect_su_altro_host_e_robots():
    r = row()
    assert "HTTP 404" in fix_rows.problems(r, FIX, lambda u: (404, u), ok_robots)[0]
    assert "altro host" in fix_rows.problems(r, FIX, lambda u: (200, "https://altro.example/"), ok_robots)[0]
    assert "robots" in fix_rows.problems(r, FIX, ok_fetch, lambda u: False)[0]


def test_www_dopo_redirect_e_accettato():
    assert fix_rows.problems(row(), FIX, lambda u: (200, "https://www.comune.fondi.lt.it/"), ok_robots) == []


def test_main_senza_apply_non_scrive_e_con_apply_scrive(tmp_path, monkeypatch):
    monkeypatch.setattr(fix_rows, "http_fetch", ok_fetch)
    monkeypatch.setattr(fix_rows, "http_robots", ok_robots)
    src = tmp_path / "sources"
    write_rows([row()], src)
    fixes = tmp_path / "f.json"
    fixes.write_text(json.dumps([FIX]), encoding="utf-8")
    assert fix_rows.main([str(fixes), "--sources", str(src)]) == 0
    assert read_rows(src)[0]["sito"] == "https://www.comunedifondi.it"
    assert fix_rows.main([str(fixes), "--sources", str(src), "--apply"]) == 0
    assert read_rows(src)[0]["sito"] == "https://comune.fondi.lt.it"
