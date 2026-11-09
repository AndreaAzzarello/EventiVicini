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


def test_health_e_stato_di_rete_nella_stessa_cache_e_mai_salvati_nel_dry_run():
    """health.json e unreachable.json (con le voci net:<subnet>) viaggiano insieme: stessi percorsi nel passo che salva
    (import vero) e in quello di solo ripristino (dry-run). Nessun passo che salva gira nel dry-run (ticket #16)."""
    text = WORKFLOW.read_text(encoding="utf-8")
    for needle in ("tools/importer/health.json", "tools/importer/unreachable.json"):
        steps = steps_with(text, needle)
        assert len(steps) == 2, f"{needle}: un passo di ripristino e uno che salva"
        for b in steps:
            if "actions/cache/restore@" in b:
                assert "if: ${{ inputs.dry_run }}" in b
            else:
                assert "if: ${{ !inputs.dry_run }}" in b, f"{needle}: il passo che salva deve saltare nel dry-run"
    stessi = [b for b in steps_with(text, "tools/importer/health.json") if "tools/importer/unreachable.json" in b]
    assert len(stessi) == 2, "health.json e unreachable.json stanno negli stessi passi di cache"
    salvano = [b for b in re.split(r"(?m)^      - ", text.replace("\r\n", "\n"))
               if "uses: actions/cache@" in b and ("health.json" in b or "unreachable.json" in b)]
    assert salvano and all("!inputs.dry_run" in b for b in salvano)
