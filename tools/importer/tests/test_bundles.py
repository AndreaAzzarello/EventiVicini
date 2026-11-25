"""Bundle delle liste: contenuto, unione col precedente, scritture solo se cambia l'hash, suddivisione."""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))
import bundles  # noqa: E402
from fake_firestore import FakeFirestore  # noqa: E402

NOW = 1_800_000_000_000
DAY = 86_400_000


def ev(i, **over):
    return {"id": f"e{i}", "title": f"Evento {i}", "startTime": NOW + DAY, "endTime": NOW + 2 * DAY, "category": "music",
            "priceType": "free", "geohash": "u0qa3xyz", "city": "Modena", "citySlug": "modena", "lat": 44.6, "lng": 10.9,
            "tags": ["kids", "altro"], "shortDescription": "non va nel bundle"} | over


def stored(db, name):
    return json.loads(db.data[f"bundles/{name}"]["json"])


def test_campi_uguali_a_quelli_della_webapp():
    ts = (Path(__file__).parents[3] / "web/src/lib/server/bundles.ts").read_text(encoding="utf-8")
    fields = re.search(r"FIELDS = \[(.*?)\]", ts, re.S).group(1)
    assert re.findall(r"'(\w+)'", fields) == bundles.FIELDS


def test_celle_citta_sitemap_e_meta():
    db = FakeFirestore()
    out = bundles.write_events(db, [ev(1), ev(2, geohash="u0qb9abc", citySlug="formigine")], [], NOW, 100)
    assert set(k.split("/")[1] for k in db.data) == {"g_u0qa", "g_u0qb", "c_modena", "c_formigine", "sitemap"}
    row = stored(db, "g_u0qa")[0]
    assert row[0] == "e1" and row[bundles.FIELDS.index("tags")] == ["kids"] and "non va" not in json.dumps(row)
    assert out["writes"] == db.writes == 5


def test_secondo_giro_uguale_non_scrive():
    db = FakeFirestore()
    bundles.write_events(db, [ev(1)], [], NOW, 100)
    before = db.writes
    out = bundles.write_events(db, [ev(1)], [], NOW, 100)
    assert db.writes == before and out["writes"] == 0


def test_import_parziale_non_cancella_gli_altri_e_toglie_i_nascosti_e_i_finiti():
    db = FakeFirestore()
    bundles.write_events(db, [ev(1), ev(2), ev(3, endTime=NOW + 1)], [], NOW, 100)
    bundles.write_events(db, [ev(4)], [{"id": "e2", "geohash": "u0qa3xyz", "citySlug": "modena"}], NOW + 10, 100)
    assert [r[0] for r in stored(db, "g_u0qa")] == ["e1", "e4"]  # e2 nascosto, e3 finito, e1 dal giro prima


def test_dividi_in_piu_documenti_e_rileggi(monkeypatch):
    monkeypatch.setattr(bundles, "MAX_PART", 400)
    db = FakeFirestore()
    bundles.write_events(db, [ev(i) for i in range(10)], [], NOW, 100)
    assert db.data["bundles/g_u0qa"]["parts"] > 1 and "bundles/g_u0qa~1" in db.data
    prev, _ = bundles.read(db, ["g_u0qa"])
    assert len(bundles.rows_of(prev["g_u0qa"])) == 10
    bundles.write_events(db, [], [{"id": f"e{i}", "geohash": "u0qa3xyz"} for i in range(1, 10)], NOW, 100)
    assert "bundles/g_u0qa~1" not in db.data and len(stored(db, "g_u0qa")) == 1  # le parti in più spariscono


def test_budget_di_scritture():
    db = FakeFirestore()
    bundles.write_events(db, [ev(1), ev(2, citySlug="altra")], [], NOW, 2)
    assert db.writes <= 2  # sitemap e una cella
    assert "bundles/sitemap" in db.data


def test_sitemap_tiene_i_500_piu_vicini():
    db = FakeFirestore()
    bundles.write_events(db, [ev(i, endTime=NOW + DAY + i) for i in range(520)], [], NOW, 1000)
    rows = stored(db, "sitemap")
    assert len(rows) == 500 and "e519" not in {r[0] for r in rows}


def test_coverage_unisce_le_regioni():
    db = FakeFirestore()
    bundles.write_coverage(db, {"lazio": {"name": "Lazio", "comuni": [{"slug": "roma"}]}}, NOW)
    bundles.write_coverage(db, {"puglia": {"name": "Puglia", "comuni": []}}, NOW)
    assert [r["slug"] for r in stored(db, "coverage")] == ["lazio", "puglia"]


def test_import_scrive_i_bundle_con_manuali_e_nasconde_gli_spariti():
    from datetime import datetime, timezone

    from mapping import content_hash
    from run import write

    now = datetime.fromtimestamp(NOW / 1000, timezone.utc)
    mk = lambda i, **o: (lambda e: e | {"contentHash": content_hash(e)})(  # noqa: E731
        ev(i) | {"source": "scraper", "sourceUrl": f"https://www.comune.test.it/{i}", "importRegion": "emilia-romagna"} | o)
    manual = {"events/m1": {"source": "manual", "title": "A mano", "startTime": NOW + DAY, "endTime": NOW + 2 * DAY,
                            "geohash": "u0qa3xyz", "citySlug": "modena", "importRegion": ""}}
    db = FakeFirestore(manual)
    write([mk(1), mk(2)], now, {"www.comune.test.it"}, db=db, with_bundles=True)
    assert {r[0] for r in stored(db, "g_u0qa")} == {"e1", "e2", "m1"}
    # e2 sparisce dalla fonte due volte di fila → nascosto anche dai bundle
    for _ in range(2):
        write([mk(1)], now, {"www.comune.test.it"}, db=db, with_bundles=True)
    assert {r[0] for r in stored(db, "g_u0qa")} == {"e1", "m1"}


class Tracer(FakeFirestore):
    """Registra l'ordine dei documenti scritti e in quale commit."""

    def __init__(self):
        super().__init__()
        self.log: list[tuple[int, str]] = []

    def batch(self):
        b = super().batch()
        real, n = b.commit, self.commits
        b.commit = lambda: ([self.log.append((n, o[1].split("/")[1])) for o in b.ops], real())[1]
        return b


def test_un_bundle_non_si_spezza_tra_due_batch(monkeypatch):
    monkeypatch.setattr(bundles, "MAX_PART", 400)
    monkeypatch.setattr(bundles, "BATCH", 6)
    db = Tracer()
    # un bundle di 3 parti riempie quasi il lotto: quello dopo non può cominciare nello stesso commit se non ci sta intero
    bundles.write_events(db, [ev(i) for i in range(4)] + [ev(9, geohash="u0qb9abc", citySlug="altra")], [], NOW, 100)
    by_bundle: dict[str, set[int]] = {}
    for commit_no, doc in db.log:
        by_bundle.setdefault(doc.split("~")[0], set()).add(commit_no)
    multi = [n for n in by_bundle if f"{n}~1" in {d for _, d in db.log}]
    assert multi and all(len(by_bundle[n]) == 1 for n in multi)


def test_bundle_piu_grande_del_lotto_scrive_prima_le_parti_e_per_ultima_la_testa(monkeypatch):
    monkeypatch.setattr(bundles, "MAX_PART", 120)
    monkeypatch.setattr(bundles, "BATCH", 3)
    db = Tracer()
    bundles.write_events(db, [ev(i) for i in range(12)], [], NOW, 1000)
    parts = db.data["bundles/g_u0qa"]["parts"]
    assert parts > 3  # supera da solo il lotto
    seq = [d for _, d in db.log if d.split("~")[0] == "g_u0qa"]
    assert seq[-1] == "g_u0qa" and seq.count("g_u0qa") == 1  # la testa è l'ultima scritta
    assert {f"g_u0qa~{k}" for k in range(1, parts)} <= set(seq[:-1])


def test_riduzione_parti_cancella_le_in_piu_dopo_la_testa(monkeypatch):
    monkeypatch.setattr(bundles, "MAX_PART", 400)
    db = Tracer()
    bundles.write_events(db, [ev(i) for i in range(10)], [], NOW, 100)
    db.log.clear()
    bundles.write_events(db, [], [{"id": f"e{i}", "geohash": "u0qa3xyz"} for i in range(1, 10)], NOW, 100)
    seq = [d for _, d in db.log if d.startswith("g_u0qa")]
    assert seq[0] == "g_u0qa" and all("~" in d for d in seq[1:])


def test_coverage_scrive_sempre_la_version_anche_a_copertura_invariata():
    db = FakeFirestore()
    docs = {"lazio": {"name": "Lazio", "comuni": [{"slug": "roma"}]}}
    bundles.write_coverage(db, docs, NOW)
    assert db.data["bundles/coverage"]["version"] == NOW
    out = bundles.write_coverage(db, docs, NOW + 5)  # stesso contenuto, hash uguale
    assert db.data["bundles/coverage"]["version"] == NOW + 5 and out["writes"] == 1
    assert [r["slug"] for r in stored(db, "coverage")] == ["lazio"]  # il contenuto non è stato toccato


def test_bump_version_aggiorna_solo_la_version_senza_toccare_la_copertura():
    # import parziale (--source): i bundle delle liste cambiano, la copertura no, ma la webapp deve vedere una version nuova (#cache /citta)
    db = FakeFirestore()
    bundles.write_coverage(db, {"lazio": {"name": "Lazio", "comuni": [{"slug": "roma"}]}}, NOW)
    before = dict(db.data["bundles/coverage"])
    writes = db.writes
    assert bundles.bump_version(db, NOW + 9) == 1 and db.writes == writes + 1
    after = db.data["bundles/coverage"]
    assert after["version"] == NOW + 9
    assert {k: v for k, v in after.items() if k != "version"} == {k: v for k, v in before.items() if k != "version"}
    assert bundles.bump_version(FakeFirestore(), NOW) == 1  # anche senza bundle di copertura
