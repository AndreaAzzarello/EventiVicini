"""Metriche di copertura: run.coverage_metrics (eventi visibili, comuni con eventi, fonti, lastOkAt, cluster) e ci_report.coverage_report."""

import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parents[1]))
import run  # noqa: E402
from ci_report import coverage_report, summary  # noqa: E402

TODAY = date(2026, 11, 9)
DOCS = {"veneto": {"name": "Veneto", "comuni": [{"slug": "a", "events": 20}, {"slug": "b", "events": 0}, {"slug": "c", "events": 5}]}}
COLLECTED = {
    "a": {"events": 3, "error": None},
    "b": {"events": 0, "error": "x", "parked": True},
    "c": {"events": 0, "error": "y", "cluster": True},
    "d": {"events": 0, "error": "z", "connect": True},
    "e": {"events": 1, "error": None},
}
HEALTH = {"sources": {"a": {"lastOkAt": "2026-11-09"}, "b": {"lastOkAt": "2026-11-01"}, "c": {"lastOkAt": "2026-11-06"}, "d": {}},
          "outages": [{"subnet": "10.0.0.0/24", "since": "2026-10-01", "until": "2026-10-03"}]}
STATE = {"net:93.56.55.0/24": {"since": "2026-11-07", "last": "2026-11-09", "reason": "x", "sources": 91},
         "net:10.0.0.0/24": {"since": "2026-10-01", "last": "2026-10-02", "reason": "x", "sources": 7},  # giù ieri, oggi no
         "host.it": {"fails": 1, "last": "2026-11-09", "reason": "x"}}


def test_metriche_di_un_giro_con_di_tutto():
    m = run.coverage_metrics(COLLECTED, DOCS, STATE, HEALTH, TODAY)
    assert (m["visible"], m["comuni_with_events"], m["comuni"]) == (25, 2, 3)
    assert (m["sources"], m["sources_error"], m["sources_parked"], m["sources_cluster"], m["sources_connect"]) == (5, 3, 1, 1, 1)
    assert m["oldest_ok_days"] == 8 and m["never_ok"] == 2  # b: 1/11; d ed e senza lastOkAt
    assert m["clusters_down"] == [{"subnet": "93.56.55.0/24", "since": "2026-11-07", "sources": 91}]
    assert m["outages"] == HEALTH["outages"]


def test_senza_documenti_di_copertura_i_campi_dei_comuni_restano_vuoti():  # --source a mano
    m = run.coverage_metrics(COLLECTED, None, None, None, TODAY)
    assert m["visible"] is None and m["comuni"] is None and m["comuni_with_events"] is None
    assert m["sources"] == 5 and m["oldest_ok_days"] is None and m["never_ok"] == 5 and m["clusters_down"] == []


def test_write_coverage_passa_i_documenti_per_le_metriche(monkeypatch):
    class Fonte:
        region, city, province = "Emilia-Romagna", "Sassuolo", "MO"

    monkeypatch.setattr(run, "SOURCES", {"sassuolo": Fonte()})
    monkeypatch.setattr(run.bundles, "write_coverage", lambda db, docs, now: {"writes": 0})
    db = SimpleNamespace(collection=lambda name: SimpleNamespace(document=lambda doc_id: SimpleNamespace(set=lambda doc: None)))
    ev = {"importRegion": "emilia-romagna", "citySlug": "sassuolo", "city": "Sassuolo", "province": "MO", "lat": 44.5, "lng": 10.8}
    out: dict = {}
    run.write_coverage(db, [ev, ev], ["sassuolo"], {("Emilia-Romagna", "sassuolo"): (44.5, 10.8)}, 1, docs_out=out)
    assert list(out) == ["emilia-romagna"]
    assert run.coverage_metrics({"sassuolo": {"events": 2, "error": None}}, out, {}, {}, TODAY)["visible"] == 2


def stats(region, coverage=None, **kw):
    s = {"region": region, "events": 10, "reads": 1, "writes": 0, "unchanged": 0, "hidden": 0, "sources": 5}
    if coverage is not None:
        s["coverage"] = coverage
    return s | kw


def test_riepilogo_senza_metriche_non_ha_la_sezione_copertura():
    assert coverage_report([stats("lombardia")]) == []
    assert "### Copertura" not in summary([stats("lombardia")], None)


def test_sezione_copertura_con_tabella_totali_e_cluster():
    m = run.coverage_metrics(COLLECTED, DOCS, STATE, HEALTH, TODAY)
    text = summary([stats("veneto", m, net={"throttle_s": 12.4, "cooldowns": 1, "top_ips": {"93.56.55.248": {"requests": 30, "peak60": 9}}}),
                    stats("lombardia")], None)
    assert "### Copertura" in text
    assert "| veneto | 5 | 3 | 1 | 1 | 10 | 25 | 2 su 3 | 8 g |" in text
    assert "**Copertura**: 25 eventi visibili (stima, 10 estratti oggi), 2 comuni con almeno un evento su 3;" in text
    assert "5 fonti, 3 in errore (1 parcheggiate, 1 in cluster); ultimo successo più vecchio: 8 giorni, 2 fonti mai riuscite." in text
    assert "### ⚠️ Cluster di rete non raggiungibili" in text and "| 93.56.55.0/24 | veneto | 91 | 2026-11-07 |" in text
    assert "10.0.0.0/24 (veneto, dal 2026-10-01 al 2026-10-03)" in text
    assert "Rete: veneto 12 s di attesa per i limiti, 1 pause di subnet, picco 9/min per IP." in text


def test_nessun_cluster_giu_nessuna_sezione_di_avviso():
    m = run.coverage_metrics({"a": {"events": 1, "error": None}}, DOCS, {}, {"sources": {"a": {"lastOkAt": "2026-11-09"}}, "outages": []}, TODAY)
    text = "\n".join(coverage_report([stats("veneto", m)]))
    assert "Cluster di rete" not in text and "Interruzioni" not in text and "0 fonti mai riuscite" in text
