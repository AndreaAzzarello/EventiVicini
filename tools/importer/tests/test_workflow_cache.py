"""Ticket #16: il dry-run non deve salvare la cache con manifest e unreachable.json (testo del workflow, senza dipendenze YAML)."""

import re
from pathlib import Path

WORKFLOW = Path(__file__).parents[3] / ".github" / "workflows" / "import-events.yml"


def steps_with(text: str, needle: str) -> list[str]:
    blocks = re.split(r"(?m)^      - ", text.replace("\r\n", "\n"))
    return [b for b in blocks if needle in b and "uses: actions/cache" in b]


def test_cache_dell_import_nel_dry_run_solo_in_lettura():
    steps = steps_with(WORKFLOW.read_text(encoding="utf-8"), "tools/importer/unreachable.json")
    kinds = {("restore" if "actions/cache/restore@" in b else "save"): b for b in steps}
    assert set(kinds) == {"restore", "save"}, "serve un passo di solo ripristino (dry-run) e uno che salva (import vero)"
    assert "if: ${{ inputs.dry_run }}" in kinds["restore"]
    assert "if: ${{ !inputs.dry_run }}" in kinds["save"]
    for b in steps:  # stessa chiave e stessi percorsi: il dry-run legge ciò che l'import vero ha salvato
        assert "tools/importer/manifests" in b and "restore-keys: importer-${{ matrix.region }}-" in b
