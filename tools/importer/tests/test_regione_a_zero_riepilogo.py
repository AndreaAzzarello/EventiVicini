"""Regione tenuta nel riepilogo CI: sezione gialla, avviso, nessun calo né storico (ci_report.py)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import run  # noqa: E402


def test_riepilogo_regione_tenuta_tabella_avviso_e_nessun_calo_ne_storico():
    import ci_report
    from ci_report import check_drop, skipped_report, update_sizes

    assert ci_report.HOLD_DAYS_TXT == run.HOLD_DAYS
    held = {"region": "molise", "events": 0, "sources": 3, "skipped_sources": [], "source_events": {},
            "held_regions": [{"region": "molise", "before": 2, "days": 1, "left": 1}]}
    lines, warnings = skipped_report([held])
    text = "\n".join(lines)
    assert "Regioni a zero eventi: 1" in text and "| molise | 2 | 1 | 1 |" in text
    assert "Fonti saltate" not in text  # le fonti di una regione tenuta hanno risposto: niente tabella «non hanno risposto»
    assert warnings == ["::warning title=Import: regione a zero eventi::molise: 0 eventi oggi, ieri 2; tenuti quelli di ieri (giorno 1 di 3)."]
    last = skipped_report([held | {"held_regions": [{"region": "molise", "before": 2, "days": 2, "left": 0}]}])[1][0]
    assert "domani il job fallisce se resta a zero" in last
    # storico e avviso di calo: la regione tenuta non entra (uno 0 abbasserebbe le medie e raddoppierebbe l'avviso)
    storico = {"days": {f"2026-11-{d}": {"regions": {"molise": 40}, "sources": {}} for d in (20, 21, 22, 23)}}
    msgs, new = check_drop([held], storico, "2026-11-28")
    assert msgs == [] and "molise" not in new["days"].get("2026-11-28", {"regions": {}})["regions"]
    msgs, _ = check_drop([held | {"held_regions": []}], storico, "2026-11-28")  # senza «tenuta» lo stesso 0 avvisa
    assert msgs and "Regione molise" in msgs[0]
    assert update_sizes([held], {"molise": 2}) == {"molise": 2}
