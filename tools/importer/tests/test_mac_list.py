"""#54: lista delle fonti scaricate dal Mac mini."""

from pathlib import Path

ROOT = Path(__file__).parents[3]


def test_la_lista_del_mac_ha_arquata_scrivia_una_sola_volta_e_ordinata():
    names = [r.strip() for r in (ROOT / "tools/importer/sources/mac-mini.txt").read_text(encoding="utf-8").splitlines() if r.strip() and not r.startswith("#")]
    assert names.count("arquata-scrivia") == 1 and names == sorted(names) and len(names) == len(set(names))
