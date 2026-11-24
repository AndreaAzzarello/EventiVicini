"""Fonti che non rispondono: la copertura di ieri non si azzera, secondo tentativo a fine giro, avviso nel riepilogo CI."""

import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import httpx

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))
from ci_report import BIG_COMUNE, SKIPPED_SHARE, skipped_report, summary  # noqa: E402
from fake_firestore import FakeFirestore  # noqa: E402
from mapping import ROME  # noqa: E402

import run  # noqa: E402
from run import coverage_doc, previous_coverage, skipped_sources, write_coverage  # noqa: E402

SRC = [SimpleNamespace(city="Modena", province="MO"), SimpleNamespace(city="Sassuolo", province="MO"),
       SimpleNamespace(city="Carpi", province="MO")]
CENTERS = {("Emilia-Romagna", "modena"): (44.6471, 10.9252), ("Emilia-Romagna", "sassuolo"): (44.5436, 10.7842),
           ("Emilia-Romagna", "carpi"): (44.7818, 10.8786)}
YESTERDAY = {"name": "Emilia-Romagna", "updatedAt": 1, "comuni": [
    {"name": "Carpi", "slug": "carpi", "province": "MO", "lat": 44.7818, "lng": 10.8786, "events": 7},
    {"name": "Modena", "slug": "modena", "province": "MO", "lat": 44.6471, "lng": 10.9252, "events": 82},
    {"name": "Sassuolo", "slug": "sassuolo", "province": "MO", "lat": 44.5436, "lng": 10.7842, "events": 20},
    {"name": "Bardi", "slug": "bardi", "province": "PR", "lat": 44.6, "lng": 9.7, "events": 3}]}


def ev(slug):
    return {"importRegion": "emilia-romagna", "citySlug": slug, "city": slug.title(), "province": "MO", "lat": 44.5, "lng": 10.8}


def events_of(c):
    return {x["slug"]: x["events"] for x in c["comuni"]}


def test_fonte_saltata_mantiene_i_dati_di_ieri():
    today = [ev("sassuolo")] * 18 + [ev("carpi")] * 6  # Modena non ha risposto
    doc = coverage_doc("Emilia-Romagna", SRC, today, CENTERS, 2, YESTERDAY, {"modena"})
    assert events_of(doc) == {"carpi": 6, "modena": 82, "sassuolo": 18}  # Modena resta a 82; chi ha risposto si aggiorna
    assert next(c for c in doc["comuni"] if c["slug"] == "modena")["lat"] == 44.6471


def test_senza_fonti_saltate_o_senza_ieri_comportamento_invariato():
    today = [ev("sassuolo")]
    assert events_of(coverage_doc("Emilia-Romagna", SRC, today, CENTERS, 2)) == {"carpi": 0, "modena": 0, "sassuolo": 1}
    assert events_of(coverage_doc("Emilia-Romagna", SRC, today, CENTERS, 2, YESTERDAY)) == {"carpi": 0, "modena": 0, "sassuolo": 1}
    assert events_of(coverage_doc("Emilia-Romagna", SRC, today, CENTERS, 2, None, {"modena"}))["modena"] == 0  # primo giorno: niente da mantenere


def test_fonte_saltata_ma_con_eventi_da_altra_fonte_tiene_il_maggiore():
    today = [ev("modena")] * 3  # solo la fonte regionale ha risposto: 3 eventi, ieri 82
    assert events_of(coverage_doc("Emilia-Romagna", SRC, today, CENTERS, 2, YESTERDAY, {"modena"}))["modena"] == 82
    today = [ev("modena")] * 90
    assert events_of(coverage_doc("Emilia-Romagna", SRC, today, CENTERS, 2, YESTERDAY, {"modena"}))["modena"] == 90


def test_senza_centro_oggi_si_tiene_quello_di_ieri():
    doc = coverage_doc("Emilia-Romagna", SRC, [], {k: v for k, v in CENTERS.items() if k[1] != "modena"}, 2, YESTERDAY, {"modena"})
    assert events_of(doc)["modena"] == 82


def test_fonte_regionale_saltata_tiene_le_citta_di_ieri():
    doc = coverage_doc("Emilia-Romagna", SRC, [ev("sassuolo")], CENTERS, 2, YESTERDAY, set(), regional_failed=True)
    assert events_of(doc)["bardi"] == 3 and events_of(doc)["sassuolo"] == 1
    assert "bardi" not in events_of(coverage_doc("Emilia-Romagna", SRC, [ev("sassuolo")], CENTERS, 2, YESTERDAY))


def test_previous_coverage_una_lettura_per_regione(monkeypatch):
    db = FakeFirestore({"coverage/emilia-romagna": YESTERDAY})
    assert previous_coverage(db, {"emilia-romagna", "lazio"}) == {"emilia-romagna": YESTERDAY}
    assert db.reads == 2
    assert previous_coverage(db, set()) == {} and db.reads == 2  # senza fonti saltate non si legge nulla


def test_write_coverage_usa_il_documento_di_ieri(monkeypatch):
    class Ok:
        region, city, province = "Emilia-Romagna", "Sassuolo", "MO"

    class Rotta:
        region, city, province = "Emilia-Romagna", "Modena", "MO"

    monkeypatch.setattr(run, "SOURCES", {"sassuolo": Ok(), "modena": Rotta()})
    monkeypatch.setattr(run.bundles, "write_coverage", lambda db, docs, now: {"writes": 0})
    written = {}

    class Ref:
        def __init__(self, doc_id):
            self.doc_id = doc_id

        def set(self, doc):
            written[self.doc_id] = doc

    db = SimpleNamespace(collection=lambda name: SimpleNamespace(document=Ref))
    run.write_coverage(db, [ev("sassuolo")], ["sassuolo", "modena"], CENTERS, 2, {"modena"}, {"emilia-romagna": YESTERDAY})
    assert events_of(written["emilia-romagna"]) == {"modena": 82, "sassuolo": 1}


# --- secondo tentativo ---

class Instabile:
    """Fallisce al primo giro, risponde al secondo."""
    region, city, province, base = "Emilia-Romagna", "Modena", "MO", "https://www.comune.test.it"

    def __init__(self, fail_times=1):
        self.left = fail_times
        self.calls = 0

    def events(self, client, now, horizon):
        self.calls += 1
        if self.left > 0:
            self.left -= 1
            raise httpx.ReadTimeout("timed out")
        return []


def collect(monkeypatch, sources, **kw):
    monkeypatch.setattr(run, "SOURCES", sources)
    monkeypatch.setattr(run.time, "sleep", lambda s: kw.setdefault("slept", []).append(s))
    stats: dict = {}
    run.collect(httpx.Client(), SimpleNamespace(), list(sources), datetime(2026, 11, 1, tzinfo=ROME), 60, stats, None, kw.get("retry_wait"))
    return stats, kw


def test_secondo_tentativo_recupera_la_fonte(monkeypatch):
    a = Instabile()
    stats, kw = collect(monkeypatch, {"modena": a}, retry_wait=300)
    assert a.calls == 2 and kw["slept"] == [300]
    assert stats["modena"]["error"] is None and stats["modena"]["retry"] == "ok" and "timed out" in stats["modena"]["first_error"]


def test_secondo_tentativo_fallito_resta_errore(monkeypatch):
    a = Instabile(fail_times=5)
    stats, _ = collect(monkeypatch, {"modena": a}, retry_wait=0)
    assert a.calls == 2 and stats["modena"]["error"] and stats["modena"]["retry"] == "fallito"


def test_senza_retry_wait_non_si_riprova(monkeypatch):
    a = Instabile()
    stats, kw = collect(monkeypatch, {"modena": a})
    assert a.calls == 1 and "slept" not in kw and "retry" not in stats["modena"]


def test_le_fonti_a_posto_non_si_riprovano(monkeypatch):
    ok, bad = Instabile(0), Instabile(5)
    collect(monkeypatch, {"a": ok, "b": bad}, retry_wait=0)
    assert ok.calls == 1 and bad.calls == 2


def test_skipped_sources_con_gli_eventi_di_ieri(monkeypatch):
    monkeypatch.setattr(run, "SOURCES", {"modena": Instabile(), "carpi": SimpleNamespace(region="Emilia-Romagna", city="Carpi")})
    out = skipped_sources({"modena": {"error": "timed out"}, "carpi": {"error": None}}, {"emilia-romagna": YESTERDAY})
    assert out == [{"source": "modena", "city": "Modena", "region": "emilia-romagna", "error": "timed out", "before": 82}]


# --- riepilogo CI ---

def stat(sources, skipped=(), ok=()):
    return {"region": "x", "sources": sources, "events": 10, "reads": 1, "writes": 1, "unchanged": 0, "hidden": 0,
            "skipped_sources": list(skipped), "retried_ok": list(ok)}


def skip(city, before=0, error="timed out"):
    return {"source": city.lower(), "city": city, "region": "x", "error": error, "before": before}


def test_nessuna_fonte_saltata_nessun_avviso():
    lines, warnings = skipped_report([stat(100)])
    assert lines == [] and warnings == []


def test_poche_fonti_piccole_elenco_ma_nessun_avviso():
    lines, warnings = skipped_report([stat(100, [skip("Piccolo", 4)] * 5)])  # 5%: non oltre la soglia
    assert warnings == [] and "### ⚠️ Fonti saltate: 5 su 100 (5%)" in "\n".join(lines)


def test_oltre_il_5_per_cento_avvisa():
    lines, warnings = skipped_report([stat(100, [skip(f"C{i}", 2) for i in range(6)])])
    assert len(warnings) == 1 and warnings[0].startswith("::warning title=") and "6 fonti su 100 (6%)" in warnings[0]
    assert SKIPPED_SHARE == 0.05


def test_un_comune_grande_avvisa_anche_se_sono_poche():
    lines, warnings = skipped_report([stat(1000, [skip("Modena", 82), skip("Piccolo", 3)])])
    assert len(warnings) == 1 and "Modena (82)" in warnings[0] and "Piccolo" not in warnings[0]
    assert "| Modena | x | 82 | timed out |" in "\n".join(lines)
    assert BIG_COMUNE == 50 and skipped_report([stat(1000, [skip("Giusto", 50)])])[1] == []  # "più di 50"


def test_avviso_su_una_riga_e_fonti_recuperate_nel_riepilogo():
    _, warnings = skipped_report([stat(10, [skip("Modena", 82, "a|b")])])
    assert "\n" not in warnings[0]
    lines, _ = skipped_report([stat(10, ok=["Carpi", "Bardi"])])
    assert "recuperate al secondo tentativo: 2 (Bardi, Carpi)" in "\n".join(lines)


def test_il_riepilogo_unico_include_la_sezione():
    text = summary([stat(100, [skip("Modena", 82)])], None)
    assert "Fonti saltate: 1 su 100" in text and "| Modena |" in text


def test_source_events_solo_fonti_che_hanno_risposto():
    from run import source_events
    out = source_events({"modena": {"error": None, "events": 12}, "carpi": {"error": None, "events": 0},
                         "mirandola": {"error": "timed out", "events": 0}})
    assert out == {"carpi": 0, "modena": 12}
