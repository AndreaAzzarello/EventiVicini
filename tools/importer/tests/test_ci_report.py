"""Matrice per regione e riepilogo unico del workflow."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from ci_report import BUDGET, QUOTA, load_sizes, matrix, read_floor, reconcile_days, simulate, summary, update_sizes  # noqa: E402


def row(regione, stato="attivo"):
    return {"regione": regione, "stato": stato}


def test_matrice_venti_regioni_non_blocca_il_primo_caricamento():
    m = matrix([row(f"Regione {i:02d}") for i in range(20)])
    # 1.929 eventi di Trentino-Alto Adige (dry-run del 28/10) + 2 scritture di stato a regione
    assert len(m["regions"]) == 20 and m["writes"] >= 1_929 + 2
    assert m["writes"] <= BUDGET["writes"]


def test_matrice_solo_regioni_con_fonti_attive_e_quote_divise():
    m = matrix([row("Emilia-Romagna"), row("Emilia-Romagna"), row("Lombardia"), row("Veneto", "candidato")])
    assert (m["regions"], m["writes"], m["geocode"]) == (["emilia-romagna", "lombardia"], 7_500, 1_500)
    assert [j["reads"] for j in m["include"]] == [BUDGET["reads"] * 2 // 3, BUDGET["reads"] // 3]  # in proporzione alle fonti
    assert matrix([row("Lombardia"), row("Veneto")], only="Veneto")["regions"] == ["veneto"]
    assert matrix([])["regions"] == []


def test_riepilogo_unico_con_quote():
    stats = [{"region": "lombardia", "events": 100, "reads": 150, "writes": 10, "unchanged": 90, "hidden": 1,
              "sources": 5, "geocode": 7, "deferred": 0},
             {"region": "veneto", "events": 50, "reads": 60, "writes": 0, "unchanged": 50, "hidden": 0}]
    text = summary(stats, {"reads": 40, "deleted": 12, "due": 12})
    assert "| lombardia | 5 | 100 | 150 |  | 10 | 90 | 1 | 7 | 0 |" in text
    assert "| letture | 250 | 50000 | ok |" in text and "| cancellazioni | 12 | 20000 | ok |" in text
    assert "oltre il 75%" in summary([{"region": "x", "events": 1, "reads": 40_000, "writes": 0, "unchanged": 0, "hidden": 0}], None)


WEIGHTS = {f"r{i:02d}": w for i, w in enumerate([255, 157, 111, 86, 66, 54, 25, 16, 13, 12, 11, 90, 80, 70, 60, 50, 40, 30, 20, 10])}


def test_riconciliazione_deterministica_bilanciata_e_indipendente_dall_ordine():
    a = reconcile_days(WEIGHTS)
    assert a == reconcile_days(dict(reversed(list(WEIGHTS.items()))))
    load = [sum(w for r, w in WEIGHTS.items() if a[r] == d) for d in range(7)]
    assert max(load) - min(load) <= max(WEIGHTS.values()) and set(a.values()) == set(range(7))
    assert reconcile_days({}) == {} and reconcile_days({"x": 5}) == {"x": 0}


def test_flag_riconciliazione_solo_nel_giorno_assegnato_e_budget_entro_il_limite():
    rows = [row(r) for r, w in WEIGHTS.items() for _ in range(w)]
    days = reconcile_days(WEIGHTS)
    for weekday in range(7):
        m = matrix(rows, weekday=weekday)
        assert {j["region"] for j in m["include"] if j["reconcile"]} == {r for r, d in days.items() if d == weekday}
        assert sum(j["reads"] for j in m["include"]) <= BUDGET["reads"]
    assert all(j["reconcile"] for j in matrix(rows, force_reconcile=True)["include"])
    only = matrix(rows, only="r00", weekday=days["r00"])  # con una sola regione il giorno non cambia
    assert only["include"][0]["reconcile"] and only["include"][0]["reads"] <= BUDGET["reads"]


def test_simulazione_italia_nessun_giorno_oltre_l_80_per_cento():
    regions = {r: {"events": w * 20, "sources": w} for r, w in WEIGHTS.items()}  # scenario estremo: 20 eventi a fonte
    sim = simulate(regions)
    assert len(sim["days"]) == 7 and all(t["worst"] <= 0.8 for t in sim["days"])
    assert all(t["reads"] <= BUDGET["reads"] for t in sim["days"]) and QUOTA["reads"] > BUDGET["reads"]


# Run del 4/11/2026: 978 fonti attive, Piemonte (116) si riconciliava, Trentino-Alto Adige (88 fonti, ~1.800 eventi) ebbe 2.102 letture
# ma ne stimava 2.274 (manifest scaduto: rilettura dei suoi documenti) e non scrisse nulla.
OGGI = {"trentino-alto-adige": 88, "piemonte": 116, "lombardia": 270} | {f"altra-{i:02d}": w for i, w in enumerate([30] * 16 + [24])}


def giorno_piemonte():
    return reconcile_days(OGGI)["piemonte"]


def test_caso_trentino_budget_per_fonti_non_basta():
    m = matrix([row(r) for r, w in OGGI.items() for _ in range(w)], weekday=giorno_piemonte())
    budget = {j["region"]: j["reads"] for j in m["include"]}
    assert 1_900 < budget["trentino-alto-adige"] < 2_274  # ~2.102 come nel run: la stima 2.274 lo supera


def test_minimo_per_regione_dagli_eventi_dell_ultimo_import():
    rows = [row(r) for r, w in OGGI.items() for _ in range(w)]
    m = matrix(rows, weekday=giorno_piemonte(), sizes={"trentino-alto-adige": 1_773, "lombardia": 1_575})
    budget = {j["region"]: j["reads"] for j in m["include"]}
    assert budget["trentino-alto-adige"] >= 2_274 and budget["lombardia"] >= read_floor(1_575)
    assert sum(budget.values()) <= BUDGET["reads"]  # i minimi sono tolti dalla quota, non aggiunti
    assert all(j["reconcile"] for j in m["include"] if j["region"] == "piemonte")


def test_minimi_troppo_grandi_o_cache_assente_tornano_alla_proporzione():
    rows = [row(r) for r, w in OGGI.items() for _ in range(w)]
    base = matrix(rows)["include"]
    assert matrix(rows, sizes={})["include"] == base and matrix(rows, sizes=None)["include"] == base
    enormi = matrix(rows, sizes={"trentino-alto-adige": 60_000})["include"]
    assert enormi == base and sum(j["reads"] for j in enormi) <= BUDGET["reads"]
    una = matrix(rows, only="trentino-alto-adige", sizes={"trentino-alto-adige": 1_773})["include"]
    assert una[0]["reads"] == BUDGET["reads"]  # rilancio di una regione sola: tutto il budget


def test_dimensioni_aggiornate_dalle_statistiche_e_cache_illeggibile(tmp_path):
    assert update_sizes([{"region": "lombardia", "events": 1_575}, {"region": "x", "events": 0}, {}], {"veneto": 834, "x": 9}) == {
        "veneto": 834, "x": 9, "lombardia": 1_575}
    f = tmp_path / "sizes.json"
    assert load_sizes(f) == {}
    f.write_text("non json", encoding="utf-8")
    assert load_sizes(f) == {}
    f.write_text('{"veneto": 834}', encoding="utf-8")
    assert load_sizes(f) == {"veneto": 834}
