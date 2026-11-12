"""Registro delle fonti: un file per regione in sources/<regione>.csv (UTF-8 con BOM, separatore ";", si apre in Excel).

Stati: da_verificare (appena creata o dubbia) · candidato (CMS supportato, robots e licenza ok: serve la tua
conferma) · escluso (robots lo vieta o licenza restrittiva) · attivo (l'importer la legge) · manuale (a mano:
gli script automatici non la toccano mai).
"""

from __future__ import annotations

import csv
from pathlib import Path
from urllib.parse import urlsplit

from geo import slugify

USER_AGENT = "EventiVicini-importer/1.0 (+https://github.com/AndreaAzzarello/EventiVicini)"
SOURCES_DIR = Path(__file__).parent / "sources"
COLUMNS = ["regione", "provincia", "comune", "codice_istat", "sito", "url_eventi", "cms", "fornitore", "stato",
           "licenza", "robots_ok", "note", "comune_alt"]  # comune_alt: nome nell'altra lingua ufficiale (Bozen, Aoste)
PROTECTED = {"manuale", "attivo"}  # righe che gli script automatici non modificano


def _read(path: Path) -> list[dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return [{c: (r.get(c) or "").strip() for c in COLUMNS} for r in csv.DictReader(f, delimiter=";")]


def read_rows(path: Path = SOURCES_DIR) -> list[dict]:
    """Righe di un file CSV, oppure di tutti i *.csv di una cartella (default: sources/)."""
    if path.is_dir():
        return [r for f in sorted(path.glob("*.csv")) for r in _read(f)]
    return _read(path) if path.exists() else []


def write_rows(rows: list[dict], path: Path = SOURCES_DIR) -> None:
    """In un file CSV, oppure (cartella) un file per regione: <slug della regione>.csv."""
    if path.suffix == ".csv":
        groups = {path: rows}
    else:
        path.mkdir(parents=True, exist_ok=True)
        groups: dict[Path, list[dict]] = {}
        for r in rows:
            groups.setdefault(path / f"{slugify(r['regione'])}.csv", []).append(r)
    for file, group in groups.items():
        file.parent.mkdir(parents=True, exist_ok=True)
        with open(file, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, COLUMNS, delimiter=";", lineterminator="\r\n")
            w.writeheader()
            w.writerows(sorted(group, key=lambda r: (r["regione"], r["provincia"], r["comune"])))


def base_url(sito: str) -> str:
    """'www.comune.x.it/it' → 'https://www.comune.x.it' (solo origine)."""
    sito = sito.strip()
    if not sito:
        return ""
    if "://" not in sito:
        sito = "https://" + sito
    p = urlsplit(sito)
    return f"{p.scheme}://{p.netloc.lower()}"


def host_key(url_or_host: str) -> str:
    """Host in minuscolo senza «www.»: www e non-www sono lo stesso sito. Accetta un URL o un host (netloc)."""
    host = (urlsplit(url_or_host).netloc if "://" in url_or_host else url_or_host).lower()
    return host[4:] if host.startswith("www.") else host
