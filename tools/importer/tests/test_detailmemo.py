"""Memoria dei dettagli finiti (#81): soglia, rotazione, pulizia, salvataggio atomico, persistenza nel workflow. Nessuna rete."""

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import detailmemo  # noqa: E402
from detailmemo import DetailMemo, finished_cutoff_ms, in_rotation  # noqa: E402
from fetch import CACHE_DIR  # noqa: E402
from mapping import ROME  # noqa: E402

TODAY = date(2026, 11, 18)


def ms(d: date, h: int = 12) -> int:
    return int(datetime(d.year, d.month, d.day, h, tzinfo=ROME).timestamp() * 1000)


def test_soglia_due_giorni_a_mezzanotte_di_roma():
    cut = finished_cutoff_ms(TODAY)
    assert cut == int(datetime(2026, 11, 16, 0, 0, tzinfo=ROME).timestamp() * 1000)
    assert ms(date(2026, 11, 15), 23) < cut   # oggi−3: finito
    assert ms(date(2026, 11, 16), 0) == cut   # esattamente la soglia: non è < soglia, si legge
    assert ms(date(2026, 11, 17)) >= cut      # oggi−1: si legge


def test_soglia_al_cambio_dora():
    # 26/10/2026 passa all'ora solare: la mezzanotte di Roma del 25/10 è UTC+2, quella del 27/10 è UTC+1
    assert finished_cutoff_ms(date(2026, 10, 27)) == int(datetime(2026, 10, 25, 0, 0, tzinfo=ROME).timestamp() * 1000)
    assert finished_cutoff_ms(date(2026, 10, 28)) == int(datetime(2026, 10, 26, 0, 0, tzinfo=ROME).timestamp() * 1000)


def test_rotazione_deterministica_e_copre_tutti_in_20_giorni():
    urls = [f"https://x.it/eventi/e{i}" for i in range(1000)]
    day = lambda n: TODAY + timedelta(days=n)  # noqa: E731
    assert [u for u in urls if in_rotation(u, day(0))] == [u for u in urls if in_rotation(u, day(0))]
    per_day = [{u for u in urls if in_rotation(u, day(n))} for n in range(20)]
    assert set().union(*per_day) == set(urls)                      # in 20 giorni passano tutti
    assert sum(len(s) for s in per_day) == len(urls)               # ciascuno una sola volta
    assert all(25 <= len(s) <= 80 for s in per_day)                # ~5% al giorno (50 su 1000)
    assert per_day[0] == {u for u in urls if in_rotation(u, day(20))}  # il ciclo si ripete


def test_salvataggio_atomico_e_rilettura(tmp_path):
    p = tmp_path / "_ended.json"
    m = DetailMemo(p)
    m.record("https://x.it/e/1", ms(date(2026, 10, 1)), TODAY)
    m.record("https://x.it/e/2", None, TODAY)
    m.mark_sitemap("https://x.it/sitemap.xml", True, TODAY)
    m.save(TODAY)
    assert not p.with_suffix(".tmp").exists()
    again = DetailMemo(p)
    assert again.known("https://x.it/e/1") and again.ended_ms("https://x.it/e/1") == ms(date(2026, 10, 1))
    assert again.known("https://x.it/e/2") and again.ended_ms("https://x.it/e/2") is None
    assert not again.known("https://x.it/e/3")


@pytest.mark.parametrize("content", ["", "{non json", "[1,2]", '{"v": 99, "details": {"u": [1, 2]}}',
                                     '{"v": 1, "details": {"u": "x", "w": [1]}, "emptySitemaps": {"s": "no"}}'])
def test_file_assente_o_corrotto_vale_memoria_vuota(tmp_path, content):
    p = tmp_path / "_ended.json"
    if content:
        p.write_text(content, encoding="utf-8")
    m = DetailMemo(p)
    assert m.details == {} and m.empty_sitemaps == {}


def test_pulizia_voci_vecchie_non_viste_e_tetto(tmp_path, monkeypatch):
    m = DetailMemo(tmp_path / "_ended.json")
    old_end = ms(TODAY - timedelta(days=200))
    m.details = {
        "vecchia-non-vista-oggi": [old_end, TODAY.toordinal() - 5],
        "vecchia-vista-oggi": [old_end, TODAY.toordinal()],
        "recente": [ms(TODAY - timedelta(days=10)), TODAY.toordinal() - 5],
        "sparita": [ms(TODAY - timedelta(days=10)), TODAY.toordinal() - 91],
        "senza-data": [None, TODAY.toordinal() - 30],
    }
    m.empty_sitemaps = {"s1": TODAY.toordinal() - 3, "s2": TODAY.toordinal() - 31}
    m.prune(TODAY)
    assert set(m.details) == {"vecchia-vista-oggi", "recente", "senza-data"}
    assert set(m.empty_sitemaps) == {"s1"}
    monkeypatch.setattr(detailmemo, "MAX_ENTRIES", 3)
    m.details = {f"u{i}": [ms(TODAY), TODAY.toordinal() - i] for i in range(10)}
    m.prune(TODAY)
    assert set(m.details) == {"u0", "u1", "u2"}  # restano le viste più di recente


def test_sitemap_vuota_saltata_per_7_giorni_e_ricontrollata_all_ottavo(tmp_path):
    m = DetailMemo(tmp_path / "_ended.json")
    m.mark_sitemap("https://x.it/sitemap.xml", True, TODAY)
    assert not m.sitemap_skipped("https://x.it/sitemap.xml", TODAY)  # il giorno stesso l'ha appena controllata chi la marca
    assert all(m.sitemap_skipped("https://x.it/sitemap.xml", TODAY + timedelta(days=n)) for n in range(1, 8))
    assert not m.sitemap_skipped("https://x.it/sitemap.xml", TODAY + timedelta(days=8))
    m.mark_sitemap("https://x.it/sitemap.xml", False, TODAY + timedelta(days=8))
    assert not m.sitemap_skipped("https://x.it/sitemap.xml", TODAY + timedelta(days=9))


def test_memoria_dentro_la_cache_http_salvata_da_actions():
    assert detailmemo.shared(CACHE_DIR).path.parent == CACHE_DIR
    assert detailmemo.shared(None) is None
    detailmemo.reset()


def test_workflow_salva_httpcache_per_regione_con_chiave_nuova_a_ogni_run():
    """Senza questo la memoria non sopravvive tra un giro e l'altro e il risparmio è zero (#81). Analisi testuale: PyYAML non è tra le dipendenze."""
    import re

    text = (Path(__file__).parents[3] / ".github" / "workflows" / "import-events.yml").read_text(encoding="utf-8")
    steps = re.split(r"\n      - ", text.split("\n  import:")[1].split("\n  cleanup:")[0])
    saving = [s for s in steps if s.startswith("uses: actions/cache@") and "tools/importer/.httpcache" in s]
    assert len(saving) == 1
    s = saving[0]
    assert re.search(r"if: \$\{\{ !inputs\.dry_run \}\}", s)                       # il dry-run non sposta in avanti la cache
    assert "key: importer-${{ matrix.region }}-${{ github.run_id }}" in s            # una chiave per regione, nuova a ogni run
    assert "restore-keys: importer-${{ matrix.region }}-" in s                       # ripristina la più recente della regione
    assert "tools/importer/geocache.json" in s and "tools/importer/manifests" in s   # elenco dei percorsi invariato (vedi commento nel workflow)
