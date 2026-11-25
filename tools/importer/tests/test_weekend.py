"""«Questo weekend» della home (#22): finestra (parità con il web), righe candidate, unione delle parti, scrittura del bundle."""

import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import bundles  # noqa: E402
import sitemap  # noqa: E402
import weekend  # noqa: E402
from fake_firestore import FakeFirestore  # noqa: E402

PARITY = json.loads((Path(__file__).parents[3] / "docs" / "schema" / "parity.json").read_text(encoding="utf-8"))
ms = lambda iso: int(datetime.fromisoformat(iso).timestamp() * 1000)  # noqa: E731
NOW = ms("2026-11-25T09:17:00+01:00")  # mercoledì
LO, HI = ms("2026-11-27T18:00:00+01:00"), ms("2026-11-29T23:59:59.999+01:00")
H = 3_600_000


def ev(i, city="modena", start=LO + H, dur=2 * H, **over):
    return {"id": f"e{i:03d}", "title": f"Evento {i}", "category": "music", "priceType": "free", "city": city.title(), "citySlug": city,
            "province": "MO", "region": "Emilia-Romagna", "lat": 44.6, "lng": 10.9, "startTime": start, "endTime": start + dur, **over}


# --- finestra


@pytest.mark.parametrize("case", PARITY["weekendWindows"], ids=lambda c: c["now"])
def test_finestra_coincide_con_il_file_condiviso(case):
    assert weekend.window(ms(case["now"])) == (ms(case["start"]), ms(case["end"]))


def test_finestra_ven_18_dom_2359_in_ora_italiana():
    assert weekend.window(NOW) == (LO, HI)
    assert weekend.window(LO - 1) == (LO, HI)  # venerdì 17:59: è già il weekend che arriva
    assert weekend.window(HI) == (LO, HI)  # domenica 23:59:59,999: ancora quello in corso
    assert weekend.window(HI + 1)[0] > HI  # lunedì 00:00: il successivo


# --- righe candidate di una regione


def test_candidati_solo_eventi_che_iniziano_nella_finestra():
    events = [ev(1, "a"), ev(2, "b", start=LO - H), ev(3, "c", start=HI + H), ev(4, "d", start=HI - H, dur=H // 2), ev(5, "e", start=LO)]
    ids = {r[0] for r in weekend.part_rows(events, NOW)}
    assert ids == {"e001", "e004", "e005"}


def test_esclusi_lunga_durata_posizione_approssimata_e_senza_coordinate_o_citta():
    events = [ev(1), ev(2, longRunning=True), ev(3, dur=20 * 86_400_000), ev(4, approxLocation=True), ev(5, lat=None), ev(6, citySlug=""), ev(7, lng=0)]
    assert [r[0] for r in weekend.part_rows(events, NOW)] == ["e001"]


def test_eventi_gia_finiti_esclusi():
    now_sat = ms("2026-11-28T20:00:00+01:00")
    events = [ev(1, start=ms("2026-11-28T10:00:00+01:00"), dur=H), ev(2, start=ms("2026-11-28T19:00:00+01:00"), dur=3 * H)]
    assert [r[0] for r in weekend.part_rows(events, now_sat)] == ["e002"]


def test_al_massimo_due_per_citta_il_primo_per_inizio_e_tetto_per_regione():
    events = [ev(i, start=LO + i * 60_000) for i in range(1, 6)]
    assert sorted(r[0] for r in weekend.part_rows(events, NOW)) == ["e001", "e002"]
    many = [ev(i, city=f"citta-{i}") for i in range(1, 100)]
    assert len(weekend.part_rows(many, NOW)) == weekend.PER_REGION
    # prima uno per città, poi il secondo: 70 città → nessun secondo evento nella parte
    two = [ev(i, city=f"c{i % 70}", start=LO + i) for i in range(1, 141)]
    rows = weekend.part_rows(two, NOW)
    assert len(rows) == weekend.PER_REGION and len({r[bundles.FIELDS.index("citySlug")] for r in rows}) == weekend.PER_REGION


def test_parte_deterministica_e_nel_formato_dei_bundle():
    events = [ev(i, city=f"c{i}") for i in range(1, 30)]
    a, b = weekend.part_rows(events, NOW), weekend.part_rows(list(reversed(events)), NOW)
    assert a == b and len(a[0]) == len(bundles.FIELDS) and a[0][0].startswith("e")


# --- unione


def rows_for(region_events):
    return weekend.part_rows(region_events, NOW)


def test_merge_filtra_per_la_finestra_di_adesso_e_toglie_i_doppioni():
    parts = {
        "emilia-romagna": rows_for([ev(1), ev(2, city="parma")]),
        "lombardia": rows_for([ev(2, city="parma"), ev(3, city="milano")]),  # e002 è in due regioni
    }
    out = weekend.merge(parts, NOW)
    assert sorted(r[0] for r in out) == ["e001", "e002", "e003"]
    # una parte vecchia (cache) con eventi di un weekend passato non entra: si guarda la finestra di adesso
    stale = {"veneto": rows_for([ev(9, city="padova")])}
    assert weekend.merge(stale, ms("2026-12-02T10:00:00+01:00")) == []
    assert [r[0] for r in weekend.merge(stale, NOW)] == ["e009"]


def test_merge_alterna_le_regioni_e_rispetta_il_tetto(monkeypatch):
    big = {"a": rows_for([ev(i, city=f"a{i}") for i in range(1, 51)]), "b": rows_for([ev(100 + i, city=f"b{i}") for i in range(1, 6)])}
    out = weekend.merge(big, NOW)
    assert [r[0][0] for r in out[:6]] == ["e", "e", "e", "e", "e", "e"]
    first_b = [i for i, r in enumerate(out) if int(r[0][1:]) > 100]
    assert first_b[:3] == [1, 3, 5]  # a, b, a, b, a, b…
    monkeypatch.setattr(weekend, "TOTAL", 10)
    assert len(weekend.merge(big, NOW)) == 10


def test_merge_ignora_righe_corte_o_di_parti_scritte_prima():
    assert weekend.merge({"x": [["solo-id"]]}, NOW) == []
    assert weekend.merge({}, NOW) == []


# --- scrittura


def test_write_scrive_il_bundle_solo_se_cambia():
    db = FakeFirestore()
    rows = rows_for([ev(1), ev(2, city="parma")])
    out = weekend.write(db, rows, NOW)
    assert out["writes"] >= 1 and "bundles/weekend" in db.data
    assert sorted(r[0] for r in bundles.rows_of({"json": [db.data["bundles/weekend"]["json"]]})) == ["e001", "e002"]
    again = weekend.write(db, rows, NOW + 5)
    assert again["writes"] == 0 and again["reads"] == 1  # hash uguale: una lettura, nessuna scrittura


def test_write_anche_vuoto_cosi_la_fascia_sparisce():
    db = FakeFirestore()
    weekend.write(db, rows_for([ev(1)]), NOW)
    weekend.write(db, [], NOW + 1)
    assert json.loads(db.data["bundles/weekend"]["json"]) == []


# --- parti della sitemap


def test_la_parte_della_sitemap_porta_le_righe_del_weekend(tmp_path):
    p = tmp_path / "sitemap-lazio.json"
    sitemap.write_part(p, "lazio", [["e001", "evento", "roma", NOW + H]], NOW, weekend=rows_for([ev(1)]))
    assert [r[0] for r in sitemap.load_weekend(tmp_path)["lazio"]] == ["e001"]
    assert sitemap.load_parts(tmp_path)["lazio"][0][0] == "e001"  # la sitemap non cambia


def test_parti_scritte_prima_senza_weekend_danno_zero_righe_e_sitemap_invariata(tmp_path):
    sitemap.write_part(tmp_path / "sitemap-umbria.json", "umbria", [["e001", "evento", "terni", NOW + H]], NOW)
    assert "weekend" not in json.loads((tmp_path / "sitemap-umbria.json").read_text(encoding="utf-8"))
    assert sitemap.load_weekend(tmp_path) == {"umbria": []}
