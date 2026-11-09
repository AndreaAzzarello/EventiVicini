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
    salvano = [b for b in re.split(r"(?m)^      - ", text.replace("\r\n", "\n"))
               if "uses: actions/cache@" in b and ("health.json" in b or "unreachable.json" in b)]
    assert salvano and all("!inputs.dry_run" in b for b in salvano)


def test_input_ip_interval_arriva_a_run_py_dall_ambiente_e_non_dentro_il_comando():
    """L'input è testo libero: si passa per variabile d'ambiente (nessuna iniezione di shell); vuoto = valore dell'importer."""
    text = WORKFLOW.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert re.search(r"(?m)^      ip_interval:\n        description: .+\n        type: string\n        default: \"\"$", text)
    assert "IP_INTERVAL: ${{ inputs.ip_interval }}" in text
    assert '${IP_INTERVAL:+--ip-interval "$IP_INTERVAL"}' in text
    assert text.count("inputs.ip_interval") == 1, "l'input compare solo nell'assegnazione dell'ambiente"


# Percorsi della cache dell'import com'erano quando main ha salvato le cache esistenti (importer-<regione>-<run>).
CACHE_ORIGINALE = ["tools/importer/geocache.json", "tools/importer/.httpcache", "tools/importer/unreachable.json",
                   "tools/importer/manifests"]


def paths_of(block: str) -> list[str]:
    after = block.split("path:", 1)[1]
    lines = after.split("\n")
    if lines[0].strip() and lines[0].strip() != "|":
        return [lines[0].strip()]
    out = []
    for line in lines[1:]:
        if not line.startswith("            ") or not line.strip():
            break
        out.append(line.strip())
    return out


def test_cache_dell_import_resta_compatibile_con_quelle_di_main_e_health_ha_la_sua():
    """La versione di una cache dipende dall'elenco dei percorsi: se cambia, le cache già salvate (anche quelle di main)
    non si ripristinano più e il run riparte senza geocache né .httpcache. Quindi l'elenco resta identico a quello di
    prima e health.json sta in una cache a parte, con un'altra chiave (che non può confondersi col prefisso importer-<regione>-)."""
    text = WORKFLOW.read_text(encoding="utf-8")
    principali = steps_with(text, "tools/importer/geocache.json")
    assert len(principali) == 2
    for b in principali:
        assert paths_of(b) == CACHE_ORIGINALE, "non aggiungere percorsi: la versione della cache cambierebbe"
        assert "key: importer-${{ matrix.region }}-${{ github.run_id }}" in b
    salute = steps_with(text, "key: importer-health-${{ matrix.region }}-${{ github.run_id }}")
    assert len(salute) == 2 and all(paths_of(b) == ["tools/importer/health.json"] for b in salute)
    assert all("restore-keys: importer-health-${{ matrix.region }}-" in b for b in salute)
    kinds = {("restore" if "actions/cache/restore@" in b else "save"): b for b in salute}
    assert set(kinds) == {"restore", "save"}
    assert "if: ${{ inputs.dry_run }}" in kinds["restore"] and "if: ${{ !inputs.dry_run }}" in kinds["save"]
    assert not any("health.json" in b for b in principali)


def test_dry_run_limita_il_geocoding():
    text = WORKFLOW.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert "--max-geocode ${{ inputs.dry_run && 20 || needs.plan.outputs.geocode }}" in text
