"""Regione a zero eventi (Molise, 27 e 28/11: liste vuote a intermittenza): rilettura senza cache, poi «tenuta» come fonte saltata
se ieri aveva eventi, exit 1 solo se mai avuta o a zero da HOLD_DAYS giorni. Fonti finte, nessuna rete."""

import sys
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))
import fetch as httpfetch  # noqa: E402
import run  # noqa: E402
import sourcehealth  # noqa: E402
from mapping import ROME  # noqa: E402
from test_collect import PLACE, START, evento  # noqa: E402

NOW = datetime(2026, 11, 28, 8, 20, tzinfo=ROME)
TODAY = date(2026, 11, 28)


class Sequenza:
    """Fonte finta del Molise: a ogni chiamata restituisce la lista successiva (l'ultima si ripete); registra FRESH."""
    region, city, province, viewbox, regional, sessions = "Molise", "Montelongo", "CB", None, False, False

    def __init__(self, *giri, base="https://www.comune.montelongo.cb.it"):
        self.giri, self.chiamate, self.fresh, self.base = list(giri), 0, [], base

    def events(self, client, now, horizon):
        self.fresh.append(httpfetch.FRESH)
        giro = self.giri[min(self.chiamate, len(self.giri) - 1)]
        self.chiamate += 1
        return [dict(e, _place=dict(PLACE), _geocode=[]) for e in giro]


def esegui(monkeypatch, sources, health=None, ieri=5, reread_wait=60, force_zero=None):
    monkeypatch.setattr(run, "SOURCES", sources)
    sleeps: list[float] = []
    monkeypatch.setattr(run.time, "sleep", sleeps.append)
    stats, held = {}, {}
    health = {"sources": {}, "outages": []} if health is None else health
    out = run.collect(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200))), SimpleNamespace(), list(sources),
                      NOW, 60, stats, health=health, reread_wait=reread_wait, yesterday_of=lambda slug: ieri, held_out=held,
                      force_zero=force_zero)
    return out, stats, held, health, sleeps


def test_ieri_con_eventi_oggi_zero_anche_alla_rilettura_la_regione_si_tiene(monkeypatch):
    f = Sequenza([])
    out, stats, held, health, sleeps = esegui(monkeypatch, {"montelongo": f})
    assert out == [] and sleeps == [60] and f.chiamate == 2
    assert f.fresh == [False, True] and httpfetch.FRESH is False  # la rilettura è senza cache e il flag non resta acceso
    st = stats["montelongo"]
    assert st["held"] is True and st["error"] == run.HELD_ERROR and st["reread"] == "vuota"
    assert held == {"molise": {"before": 5, "days": 1, "left": 1}}
    assert health["regions"]["molise"]["zeroSince"] == "2026-11-28"
    assert health["sources"]["montelongo"]["failStreak"] == 1 and health["sources"]["montelongo"]["lastKind"] == "held"


def test_tenuta_come_fonte_saltata_fuori_dagli_host_ok_e_dal_registro_delle_non_risposte(monkeypatch):
    _, stats, _, _, _ = esegui(monkeypatch, {"montelongo": Sequenza([])})
    ok_hosts = set().union(*(run.source_hosts(run.SOURCES[n]) for n, st in stats.items() if st["error"] is None))
    assert ok_hosts == set()  # stale_updates non nasconde nulla: nessun removedAt per assenza
    assert run.skipped_sources(stats, {}) == []  # ha risposto: la riporta held_regions, non «non ha risposto»


def test_la_rilettura_che_recupera_non_tiene_nulla(monkeypatch):
    f = Sequenza([], [evento(url="https://www.comune.montelongo.cb.it/e/1")])
    out, stats, held, health, sleeps = esegui(monkeypatch, {"montelongo": f})
    assert len(out) == 1 and sleeps == [60] and held == {}
    st = stats["montelongo"]
    assert st["error"] is None and "held" not in st and st["reread"] == "recuperata" and st["events"] == 1
    assert health["regions"]["molise"]["lastEvents"] == 1 and "zeroSince" not in health["regions"]["molise"]


def test_regione_mai_avuta_non_si_rilegge_e_non_si_tiene(monkeypatch):
    f = Sequenza([])
    out, stats, held, health, sleeps = esegui(monkeypatch, {"montelongo": f}, ieri=0)
    assert out == [] and sleeps == [] and f.chiamate == 1 and held == {}
    assert stats["montelongo"]["error"] is None and "held" not in stats["montelongo"]


def test_giorni_a_zero_si_tiene_fino_al_secondo_poi_no(monkeypatch):
    for since, tenuta, days in (("2026-11-27", True, 2), ("2026-11-26", False, 3), ("2026-11-20", False, 9)):
        health = {"sources": {}, "outages": [], "regions": {"molise": {"lastEvents": 2, "zeroSince": since}}}
        _, stats, held, _, _ = esegui(monkeypatch, {"montelongo": Sequenza([])}, health=health)
        assert ("molise" in held) is tenuta, since
        assert stats["montelongo"].get("held") is (True if tenuta else None)
        if tenuta:
            assert held["molise"] == {"before": 5, "days": days, "left": 0}


def test_rilanciare_lo_stesso_giorno_non_conta_due_volte(monkeypatch):
    """Il ritento del job rilegge lo stesso health.json: il secondo passaggio del giorno è ancora il giorno 1."""
    _, _, held1, health, _ = esegui(monkeypatch, {"montelongo": Sequenza([])})
    _, _, held2, health, _ = esegui(monkeypatch, {"montelongo": Sequenza([])}, health=health)
    assert held1["molise"]["days"] == held2["molise"]["days"] == 1


def test_senza_health_nessuna_logica_di_regione(monkeypatch):
    monkeypatch.setattr(run, "SOURCES", {"montelongo": Sequenza([])})
    monkeypatch.setattr(run.time, "sleep", lambda s: pytest.fail("nessuna rilettura con --source"))
    stats: dict = {}
    run.collect(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200))), SimpleNamespace(), ["montelongo"], NOW, 60,
                stats, health=None, reread_wait=60, yesterday_of=lambda s: 5)
    assert stats["montelongo"]["error"] is None


def test_rilettura_disattivata_con_reread_wait_negativo_ma_la_regione_si_tiene(monkeypatch):
    f = Sequenza([])
    _, stats, held, _, sleeps = esegui(monkeypatch, {"montelongo": f}, reread_wait=None)
    assert sleeps == [] and f.chiamate == 1 and "molise" in held


def test_ieri_sconosciuto_vale_ne_aveva(monkeypatch):
    _, _, held, _, sleeps = esegui(monkeypatch, {"montelongo": Sequenza([])}, ieri=None)
    assert sleeps == [60] and held["molise"]["before"] == 0


def test_forza_zero_scarta_il_primo_giro_la_rilettura_recupera(monkeypatch):
    f = Sequenza([evento(url="https://www.comune.montelongo.cb.it/e/1")])
    out, stats, held, _, _ = esegui(monkeypatch, {"montelongo": f}, force_zero=("molise", False))
    assert len(out) == 1 and held == {} and stats["montelongo"]["reread"] == "recuperata"


def test_forza_zero_sempre_scarta_anche_la_rilettura_e_la_regione_si_tiene(monkeypatch):
    f = Sequenza([evento(url="https://www.comune.montelongo.cb.it/e/1")])
    out, stats, held, _, _ = esegui(monkeypatch, {"montelongo": f}, force_zero=("molise", True))
    assert out == [] and "molise" in held


def test_zero_reason_distingue_mai_avuta_da_a_zero_da_giorni():
    h = {"regions": {"molise": {"lastEvents": 2, "zeroSince": "2026-11-26"}}}
    assert run.zero_reason(h, "molise", TODAY) == "a zero da 3 giorni (soglia 3)"
    assert run.zero_reason({"regions": {}}, "molise", TODAY).startswith("mai avuto eventi")
    assert sourcehealth.region_zero_days(h, "molise", TODAY) == 3


def test_le_fonti_in_errore_di_una_regione_tenuta_restano_tra_le_saltate(monkeypatch):
    stats = {"montelongo": {"error": run.HELD_ERROR, "held": True}, "provvidenti": {"error": "host irraggiungibile", "held": True}}
    fonti = {"montelongo": Sequenza([]), "provvidenti": Sequenza([], base="https://comune.provvidenti.cb.it")}
    fonti["provvidenti"].city = "Provvidenti"
    monkeypatch.setattr(run, "SOURCES", fonti)
    assert [x["source"] for x in run.skipped_sources(stats, {})] == ["provvidenti"]


def main_molise(monkeypatch, tmp_path, health, existing=None, fonte=None, extra=()):
    """run.main completo sul Molise con Firestore finto: fonti finte, niente rete, manifest assente (confronto da Firestore)."""
    import json

    import db as dbmod
    from fake_firestore import FakeFirestore

    monkeypatch.setattr(run, "HERE", tmp_path)
    monkeypatch.setattr(run, "SOURCES", {"montelongo": fonte or Sequenza([])})
    monkeypatch.setattr(run, "find_centers", lambda names, geocoder: {})
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    fs = FakeFirestore(existing or {})
    monkeypatch.setattr(dbmod, "client", lambda: fs)
    coverage: dict = {}  # write_coverage ha i suoi test (tests/test_fonti_saltate.py): qui basta sapere quali fonti risultano saltate
    monkeypatch.setattr(run, "write_coverage", lambda db, events, names, centers, now_ms, failed=frozenset(), previous=None, docs_out=None:
                        coverage.update(failed=sorted(failed)) or 0)
    (tmp_path / "health.json").write_text(json.dumps(health), encoding="utf-8")
    code = run.main(["--regione", "molise", "--stats-out", str(tmp_path / "stats.json"), "--sitemap-out", str(tmp_path / "sm.json"),
                     "--retry-wait", "-1", "--reread-wait", "0", "--no-liveness", "--max-geocode", "0", *extra])
    fs.coverage = coverage
    return code, fs


def esistente():
    return {"events/ev1": {"importRegion": "molise", "source": "scraper", "sourceUrl": "https://www.comune.montelongo.cb.it/e/1",
                           "startTime": START, "endTime": START + 3_600_000, "contentHash": "h1", "createdAt": 1}}


def test_main_regione_tenuta_esce_con_zero_senza_toccare_eventi_mese_e_sitemap(monkeypatch, tmp_path):
    import json

    health = {"sources": {}, "outages": [], "regions": {"molise": {"lastEvents": 2, "lastEventsAt": "2026-11-27"}}}
    code, fs = main_molise(monkeypatch, tmp_path, health, esistente())
    assert code == 0 and fs.coverage == {"failed": ["montelongo"]}  # la copertura di ieri si riusa: la fonte conta come saltata
    assert fs.data["events/ev1"].get("removedAt") is None and fs.data["events/ev1"]["contentHash"] == "h1"  # niente nascosto, niente cancellato
    assert not any(k.startswith("stats/") for k in fs.data), "niente statistiche del mese a zero"
    assert not (tmp_path / "sm.json").exists(), "nessuna parte di sitemap vuota per la regione"
    stats = json.loads((tmp_path / "stats.json").read_text(encoding="utf-8"))
    assert stats["events"] == 0 and stats["held_regions"] == [{"region": "molise", "before": 2, "days": 1, "left": 1}]
    assert stats["skipped_sources"] == []


def test_main_regione_mai_avuta_esce_con_1_e_dice_il_perche(monkeypatch, tmp_path, capsys):
    # nessun registro e Firestore senza coverage di ieri: «mai avuta» (zero eventi ieri)
    code, _ = main_molise(monkeypatch, tmp_path, {"sources": {}, "outages": []})
    assert code == 1
    assert "Nessun evento raccolto: controlla le fonti (molise: mai avuto eventi" in capsys.readouterr().err


def test_main_a_zero_da_tre_giorni_esce_con_1(monkeypatch, tmp_path, capsys):
    from datetime import timedelta, timezone

    since = (datetime.now(timezone.utc).date() - timedelta(days=2)).isoformat()  # oggi è il 3° giorno a zero
    health = {"sources": {}, "outages": [], "regions": {"molise": {"lastEvents": 2, "zeroSince": since}}}
    code, _ = main_molise(monkeypatch, tmp_path, health)
    assert code == 1
    assert "molise: a zero da 3 giorni (soglia 3)" in capsys.readouterr().err


def test_senza_yesterday_of_collect_non_rilegge_ne_tiene_nulla(monkeypatch):
    monkeypatch.setattr(run, "SOURCES", {"montelongo": Sequenza([])})
    monkeypatch.setattr(run.time, "sleep", lambda s: pytest.fail("nessuna rilettura senza yesterday_of"))
    stats: dict = {}
    health = {"sources": {}, "outages": []}
    run.collect(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200))), SimpleNamespace(), ["montelongo"], NOW, 60,
                stats, health=health, reread_wait=60)
    assert stats["montelongo"]["error"] is None and health["sources"]["montelongo"]["lastOkAt"] == "2026-11-28"
