"""misura_rete.py: legge un estratto reale del log dell'import del 18/11 (nessuna rete, nessun `gh`)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import misura_rete as m  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "log_import_estratto.txt"
NEW_LINES = (
    "import (piemonte, 15458, true)\tUNKNOWN STEP\t2026-11-19T08:34:40.0000000Z pogno: dettagli saltati (finiti): 31, riletti a rotazione: 2, coda da esplorare: 20\n"
    "import (piemonte, 15458, true)\tUNKNOWN STEP\t2026-11-19T09:00:00.0000000Z Dettagli (Piemonte): richieste di dettaglio 700, saltati (finiti) 900, "
    "riletti a rotazione 40, coda da esplorare 5000 (fonti con coda 80), sitemap vuote saltate 3\n")


def test_estratto_del_18_11_per_regione_ip_e_fornitore():
    rep = m.parse_log(FIXTURE.read_text(encoding="utf-8"))
    pie = rep["piemonte"]
    assert (pie["n_ips"], pie["wait_s"]) == (14, 7712)
    assert pie["ips"]["151.11.50.116"] == (2227, 61) and len(pie["ips"]) == 3
    assert pie["sources"]["pogno"] == {"seconds": 169.0, "requests": 44, "details": 40, "future": 2}
    com = m.by_vendor("piemonte", pie["sources"], m.vendors())["ComWeb"]
    assert (com["sources"], com["requests"], com["details"], com["future"]) == (3, 44 + 44 + 36, 40 + 40 + 32, 3)
    trn = rep["trentino-alto-adige"]
    assert trn["ips"]["20.107.132.93"] == (617, 61) and trn["wait_s"] == 2006
    asp = m.by_vendor("trentino-alto-adige", trn["sources"], m.vendors())["ASP.NET"]
    assert (asp["sources"], asp["requests"]) == (2, 5 + 12)


def test_righe_nuove_dei_dettagli_saltati():
    rep = m.parse_log(FIXTURE.read_text(encoding="utf-8") + NEW_LINES)
    assert rep["piemonte"]["sources"]["pogno"]["skipped"] == 31 and rep["piemonte"]["sources"]["pogno"]["tail"] == 20
    assert rep["piemonte"]["details"] == {"gets": 700, "skipped": 900, "rotated": 40, "tail": 5000, "tail_sources": 80, "sitemap_skipped": 3}


def test_render_e_confronto_prima_dopo():
    before = m.parse_log(FIXTURE.read_text(encoding="utf-8"))
    after = m.parse_log(FIXTURE.read_text(encoding="utf-8").replace("2227 ric.", "600 ric.").replace("44 richieste", "11 richieste"))
    vend = m.vendors()
    text = m.render(before, {"piemonte": 38.3}, vend, ["piemonte"])
    assert "== piemonte · job 38,3 min · attesa 7712 s · 14 IP" in text and "IP 151.11.50.116: 2227 ric., picco 61/min" in text
    assert "ComWeb: 3 fonti, 124 ric." in text and "trentino" not in text
    cmp = m.compare(before, {"piemonte": 38.3}, after, {"piemonte": 18.0}, vend, ["piemonte"])
    assert "job (min): 38,3 → 18 (-53%)" in cmp
    assert "IP 151.11.50.116: ric. 2227 → 600 (-73%)" in cmp
    assert "ComWeb: ric. 124 → 58 (-53%)" in cmp


def test_durata_dei_job_dal_json_di_gh():
    jobs = [{"name": "import (piemonte, 15458, true)", "startedAt": "2026-11-18T08:24:14Z", "completedAt": "2026-11-18T09:02:32Z"},
            {"name": "cleanup", "startedAt": "2026-11-18T09:02:00Z", "completedAt": "2026-11-18T09:03:00Z"}]
    assert m.job_minutes(jobs) == {"piemonte": 38.3}
