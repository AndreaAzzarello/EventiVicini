"""#54: avvio di scarica-fonti.yml dal Worker; la riserva di GitHub non deve raddoppiare l'esecuzione."""

import re
from pathlib import Path

ROOT = Path(__file__).parents[3]
WF = (ROOT / ".github" / "workflows" / "scarica-fonti.yml").read_text(encoding="utf-8").replace("\r\n", "\n")


def test_la_riserva_di_github_parte_dopo_il_worker_e_prima_dell_import():
    m = re.search(r'cron: "(\d+) (\d+) \* \* \*"', WF)
    assert m and int(m.group(2)) * 60 + int(m.group(1)) > 6 * 60 + 45  # dopo le 06:45 del Worker
    assert int(m.group(2)) * 60 + int(m.group(1)) <= 7 * 60 + 45  # lascia 30 min prima dell'import (08:17)
    assert "workflow_dispatch:" in WF


def test_il_guard_salta_la_riserva_e_lo_scarica_dipende_da_lui():
    guard = WF.split("  guard:\n")[1].split("\n  scarica:\n")[0]
    assert "runs-on: ubuntu-latest" in guard and "actions: read" in guard and "contents: read" in guard
    assert 'EVENT" = "schedule"' in guard and "GITHUB_RUN_ID" in guard  # i dispatch del Worker passano sempre
    assert "status != " in guard and 'conclusion == ' in guard  # contano in corso, in coda e riusciti, non falliti/annullati
    scarica = WF.split("\n  scarica:\n")[1]
    assert "needs: guard" in scarica and "needs.guard.outputs.go == 'true'" in scarica
    assert "runs-on: [self-hosted, macOS, ARM64, mac-eventi]" in scarica
    assert "secrets." not in WF  # il Mac non riceve segreti


def test_resta_la_concurrency_senza_cancellare_il_run_in_corso():
    assert "group: scarica-fonti" in WF and "cancel-in-progress: false" in WF

