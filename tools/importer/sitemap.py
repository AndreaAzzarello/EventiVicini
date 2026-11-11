"""Sitemap dall'importer (#20, #51): il Worker serve XML già pronto, senza calcoli né letture di eventi.

Come arriva il dato, senza leggere i bundle g_* da Firestore:
  1. ogni job `import` scrive `sitemap-<regione>.json` con gli eventi che ha appena costruito (id, titolo già in slug, città, fine):
     è lo stesso elenco che usa per i bundle, quindi zero letture in più (`part_rows`, `write_part`);
  2. il job `cleanup` scarica le parti (le regioni non rigirate restano quelle della cache), le unisce con la copertura
     (bundles/coverage: una lettura) e scrive i documenti `bundles/sm_*` solo se il contenuto è cambiato (`build`, `write`).
Sono assenti solo gli eventi che non passano da un import di regione (inseriti a mano) e quelli che una fonte non pubblica più:
le loro pagine restano raggiungibili dalle pagine città, che sono in sitemap.

Documenti (collezione bundles, stesso campo `json` dei bundle, qui con XML):
  sm_index       <sitemapindex> con sm_luoghi e le pagine eventi
  sm_luoghi      home, regioni, città con eventi, pagine legali
  sm_eventi_<n>  fino a PAGE_URLS eventi, ordinati per id (le pagine restano stabili tra un import e l'altro)
Gli URL hanno il segnaposto {{BASE}}: lo sostituisce il Worker con l'indirizzo del sito (siteUrl()).
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

from bundles import COLL, commit, digest, read, rows_of
from geo import slugify

log = logging.getLogger(__name__)

PAGE_URLS = 1000  # ben sotto i 50.000 URL e i 50 MB di una sitemap; ~110 KB per documento (limite Firestore: 1 MiB)
MAX_PAGES = 40
LEGAL = ["/privacy", "/cookie", "/termini"]
BASE = "{{BASE}}"


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def part_rows(events: list[dict], now_ms: int) -> list[list]:
    """[id, slug del titolo, citySlug, endTime] degli eventi non ancora finiti, ordinati per id."""
    rows = {
        e["id"]: [e["id"], slugify(e.get("title", "")) or "evento", e.get("citySlug") or "", int(e.get("endTime") or 0)]
        for e in events
        if e.get("id") and int(e.get("endTime") or 0) >= now_ms
    }
    return [rows[i] for i in sorted(rows)]


def write_part(path: Path, region: str, rows: list[list], now_ms: int) -> None:
    path.write_text(json.dumps({"region": region, "at": now_ms, "rows": rows}, separators=(",", ":")), encoding="utf-8")


def load_parts(directory: Path) -> dict[str, list[list]]:
    """regione → righe, dai file sitemap-*.json della cartella (file illeggibili ignorati)."""
    out: dict[str, list[list]] = {}
    for p in sorted(directory.glob("sitemap-*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out[str(d["region"])] = [list(r) for r in d["rows"]]
        except (OSError, ValueError, KeyError, TypeError):
            log.warning("parte di sitemap illeggibile, ignorata: %s", p.name)
    return out


def _urlset(urls: list[str]) -> str:
    body = "\n".join(urls)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{body}\n</urlset>\n'


def build(parts: dict[str, list[list]], coverage: list[dict], now_ms: int) -> dict[str, str]:
    """Nome documento → XML. Gli eventi finiti (endTime < adesso) e i doppioni (stesso id in più regioni) sono esclusi."""
    seen: dict[str, list] = {}
    for rows in parts.values():
        for r in rows:
            if int(r[3]) >= now_ms:
                seen.setdefault(r[0], r)
    events = [seen[i] for i in sorted(seen)]
    cities = sorted({r[2] for r in events if r[2]} | {c["slug"] for reg in coverage for c in reg.get("comuni", []) if c.get("events", 0) > 0})
    regions = sorted(reg["slug"] for reg in coverage if reg.get("comuni"))
    places = (
        [f"<url><loc>{BASE}/</loc><changefreq>daily</changefreq></url>"]
        + [f"<url><loc>{BASE}/regione/{esc(s)}</loc><changefreq>daily</changefreq></url>" for s in regions]
        + [f"<url><loc>{BASE}/citta/{esc(s)}</loc><changefreq>daily</changefreq></url>" for s in cities]
        + [f"<url><loc>{BASE}{p}</loc></url>" for p in LEGAL]
    )
    docs = {"sm_luoghi": _urlset(places)}
    chunks = [events[i:i + PAGE_URLS] for i in range(0, len(events), PAGE_URLS)][:MAX_PAGES]
    for n, chunk in enumerate(chunks, 1):
        docs[f"sm_eventi_{n}"] = _urlset([f"<url><loc>{BASE}/eventi/{esc(r[1])}-{esc(r[0])}</loc></url>" for r in chunk])
    names = ["sm_luoghi"] + [f"sm_eventi_{n}" for n in range(1, len(chunks) + 1)]
    entries = "\n".join(f"<sitemap><loc>{BASE}/{'sitemap-luoghi' if n == 'sm_luoghi' else 'sitemap-eventi-' + n.rsplit('_', 1)[1]}.xml</loc></sitemap>" for n in names)
    docs["sm_index"] = f'<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{entries}\n</sitemapindex>\n'
    return docs


def write(db, docs: dict[str, str], now_ms: int) -> dict:
    """Scrive i documenti cambiati (hash diverso) e toglie le pagine eventi che non servono più. Letture: sm_index + i documenti."""
    prev_index, reads = read(db, ["sm_index"])
    old_pages = 0
    if "sm_index" in prev_index:
        old_pages = (prev_index["sm_index"].get("json") or [""])[0].count("sitemap-eventi-")
    names = sorted(set(docs) | {f"sm_eventi_{n}" for n in range(1, old_pages + 1)})
    prev, r = read(db, [n for n in names if n != "sm_index"])
    prev.update(prev_index)
    reads += r
    ops: list = []
    writes = 0
    ref = lambda n: db.collection(COLL).document(n)  # noqa: E731
    for name in names:
        if name not in docs:
            if name in prev:
                ops.append(lambda b, r=ref(name): b.delete(r))
                writes += 1
            continue
        h = digest([docs[name]])
        if prev.get(name, {}).get("hash") == h:
            continue
        ops.append(lambda b, r=ref(name), d={"json": docs[name], "hash": h, "parts": 1, "n": docs[name].count("<loc>"), "updatedAt": now_ms}: b.set(r, d))
        writes += 1
    commit(db, ops)
    return {"reads": reads, "writes": writes}


def main(argv: list[str] | None = None) -> int:
    """Per il job cleanup: python sitemap.py build <cartella con sitemap-*.json> [--dry-run]."""
    import argparse
    import time

    p = argparse.ArgumentParser(description="Costruisce e scrive la sitemap (documenti bundles/sm_*).")
    p.add_argument("command", choices=["build"])
    p.add_argument("parts", type=Path, help="cartella con i file sitemap-<regione>.json")
    p.add_argument("--dry-run", action="store_true", help="costruisce e stampa i conteggi senza scrivere (legge la copertura)")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    from db import client

    db = client()
    now_ms = int(time.time() * 1000)
    parts = load_parts(args.parts)
    if not parts:
        log.warning("Nessuna parte di sitemap in %s: non scrivo nulla", args.parts)
        return 0
    cov, reads = read(db, ["coverage"])
    coverage = rows_of(cov.get("coverage")) if "coverage" in cov else []
    docs = build(parts, coverage, now_ms)
    n_events = sum(d.count("/eventi/") for d in docs.values())
    log.info("Sitemap: %d regioni nelle parti, %d URL evento in %d pagine", len(parts), n_events, len(docs) - 2)
    if args.dry_run:
        return 0
    out = write(db, docs, now_ms)
    log.info("Sitemap scritta: %d letture, %d scritture", reads + out["reads"], out["writes"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
