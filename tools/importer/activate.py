"""Attivazione automatica delle fonti, con la regola approvata. Una riga diventa "attivo" SOLO se:

  a) esiste un adapter per il suo CMS (plone, wordpress-dci, design_comuni_html);
  b) licenses.py ha classificato le note legali come licenza dei CONTENUTI, aperta e senza restrizioni:
     CC0 o CC-BY (mai NC, ND, SA, "esclusiva proprietà" o "tutti i diritti riservati");
  c) robots.txt permette i percorsi usati (robots_ok e controllo di licenses.py);
  d) il dry-run del comune produce almeno 1 evento futuro valido: titolo, date e coordinate dentro la provincia
     (se la fonte non dà le coordinate vale il centro del comune, geocodificato una volta e tenuto in cache).

Tutte le altre restano "da_verificare" con il motivo in `note` ("attivazione: …"). Le righe "manuale", "escluso"
e quelle già "attivo" non si toccano.

Uso:  python activate.py --regione lombardia [--dry-run] [--workers 8]
      python activate.py --tutte --only-reason "nessun evento futuro valido"   # ricontrollo settimanale
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import httpx

import logsafe
from adapters import CMS_ADAPTERS, load_sources
from fetch import Blocked, RobotsUnknown
from geo import PROVINCES, in_viewbox, slugify
from geocode import Geocoder
from registry import USER_AGENT, read_rows, write_rows

log = logging.getLogger("importer")
TODO = {"da_verificare", "candidato"}
HORIZON_DAYS = 45  # solo per l'attivazione dei comuni (prova di una fonte); l'import vero usa run.py --horizon-days (60)
HERE = Path(__file__).parent
NOTE_TAG = re.compile(r"^licenza\[([a-z]+)\]( conflitto)?")
REASON = re.compile(r"^attivazione: [^|]*\| ?")
OPEN_CONTENT = re.compile(r"CC0|CC-BY(-\d\.\d)?")  # fullmatch: niente -SA, -NC, -ND, IODL


def check(row: dict) -> str | None:
    """Condizioni a–c sulla riga del registro: il motivo del rifiuto, o None se si può passare al dry-run."""
    if row["cms"] not in CMS_ADAPTERS:
        return f"nessun adapter per il CMS {row['cms'] or 'non rilevato'}"
    if row["cms"] == "design_comuni_html" and not row["url_eventi"]:
        return "pagina eventi non trovata"
    m = NOTE_TAG.match(REASON.sub("", row["note"]))  # dopo un primo passaggio la nota comincia con "attivazione: …"
    if not m:
        return "licenza dei contenuti non verificata (serve licenses.py)"
    if m.group(2):
        return "clausola restrittiva sui contenuti (esclusiva proprietà / diritti riservati)"
    if not OPEN_CONTENT.fullmatch(row["licenza"]):
        return f"licenza dei contenuti non aperta o non chiara ({row['licenza'] or 'assente'})"
    if m.group(1) != "attivare":
        return "robots.txt o note legali da controllare a mano"
    if row["robots_ok"] != "si":
        return "robots.txt non permette i percorsi usati"
    return None


def judge(events: list[dict], viewbox: str | None, now_ms: int, center: tuple[float, float] | None) -> str | None:
    """Condizione d: il motivo del rifiuto, o None se c'è almeno un evento futuro valido."""
    future = [e for e in events if e.get("title") and e.get("startTime") and (e.get("endTime") or 0) >= now_ms
              and e["endTime"] >= e["startTime"]]
    if not future:
        return "dry-run: nessun evento futuro valido"
    for e in future:
        if e.get("lat") is not None and in_viewbox(e["lat"], e["lng"], viewbox):
            return None
        if e.get("lat") is None and center is not None:  # senza coordinate: vale il centro del comune
            return None
    return "dry-run: coordinate fuori provincia o non trovate"


def fetch_events(row: dict, client: httpx.Client, now: datetime) -> tuple[list[dict], str | None]:
    """Solo rete (1 richiesta/s per host): può girare in parallelo."""
    source = load_sources([row | {"stato": "attivo"}])[slugify(row["comune"])]
    try:
        return [dict(e) for e in source.events(client, now, HORIZON_DAYS)], None
    except Blocked:
        return [], "dry-run: robots.txt vieta i percorsi usati"
    except (RobotsUnknown, httpx.HTTPError) as e:
        return [], f"dry-run: fonte non raggiungibile ({str(e) or type(e).__name__})"
    except Exception as e:  # un sito difettoso (URL non valido, HTML inatteso) non ferma le altre centinaia
        return [], f"dry-run: errore imprevisto ({type(e).__name__}: {str(e)[:80]})"


def select(rows: list[dict], regions: set[str] | None, only_reason: str = "") -> list[dict]:
    """Solo da_verificare e candidato delle regioni indicate (None = tutte): manuale, escluso e attivo non si toccano mai.

    only_reason: solo le righe respinte l'ultima volta con questo motivo di dry-run (ricontrollo periodico)."""
    prefix = f"attivazione: dry-run: {only_reason}" if only_reason else ""
    return [r for r in rows if (regions is None or slugify(r["regione"]) in regions) and r["stato"] in TODO
            and (not only_reason or (r["stato"] == "da_verificare" and r["note"].startswith(prefix)))]


def summary_md(todo: list[dict], reasons: dict[str, str | None]) -> str:
    """Riepilogo per GITHUB_STEP_SUMMARY: per regione, comuni rivalutati, attivati (nomi) e ancora respinti."""
    lines = ["## Ricontrollo fonti", "", "| regione | rivalutati | attivati | ancora respinti |", "|---|---|---|---|"]
    names: dict[str, list[str]] = {}
    for region in sorted({r["regione"] for r in todo}):
        rows = [r for r in todo if r["regione"] == region]
        on = [r["comune"] for r in rows if reasons[r["codice_istat"]] is None]
        names[region] = on
        lines.append(f"| {region} | {len(rows)} | {len(on)} | {len(rows) - len(on)} |")
    total = sum(len(v) for v in names.values())
    lines += ["", f"**Totale**: {len(todo)} rivalutati, {total} attivati."]
    for region, on in names.items():
        if on:
            lines += ["", f"Attivati in {region}: {', '.join(sorted(on))}."]
    return "\n".join(lines)


def note_with_reason(row: dict, reason: str | None) -> str:
    note = REASON.sub("", row["note"])
    return note if reason is None else f"attivazione: {reason} | {note}".rstrip(" |")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--regione", action="append", help="regione (ripetibile), per esempio lombardia")
    p.add_argument("--tutte", action="store_true", help="tutte le regioni")
    p.add_argument("--only-reason", default="",
                   help='solo le righe respinte con questo motivo di dry-run, per esempio "nessun evento futuro valido"')
    p.add_argument("--dry-run", action="store_true", help="stampa l'esito senza scrivere i CSV")
    p.add_argument("--workers", type=int, default=8, help="comuni in parallelo (1 richiesta/s per host)")
    args = p.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    logsafe.setup(logging.WARNING)

    if not args.regione and not args.tutte:
        p.error("indica --regione <nome> (ripetibile) oppure --tutte")
    regions = None if args.tutte else {slugify(r) for r in args.regione}
    rows = read_rows()
    todo = select(rows, regions, args.only_reason)
    reasons: dict[str, str | None] = {}
    now = datetime.now(timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    candidates = []
    for r in todo:
        reasons[r["codice_istat"]] = check(r)
        if reasons[r["codice_istat"]] is None:
            candidates.append(r)
    print(f"{len(todo)} comuni da valutare, {len(candidates)} passano le condizioni a–c: dry-run in corso", flush=True)

    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True) as client:
        with ThreadPoolExecutor(args.workers) as pool:
            done = []

            def work(r: dict) -> tuple[list[dict], str | None]:
                out = fetch_events(r, client, now)
                done.append(r["comune"])
                if len(done) % 25 == 0:
                    print(f"  scaricati {len(done)}/{len(candidates)}", flush=True)
                return out

            fetched = list(pool.map(work, candidates))
        geocoder = Geocoder(client, HERE / "geocache.json")
        try:
            for r, (events, error) in zip(candidates, fetched):
                box = load_sources([r | {"stato": "attivo"}])[slugify(r["comune"])].viewbox
                reason = error
                if reason is None:
                    center = None
                    if any(e.get("lat") is None for e in events):  # 1 richiesta per comune, poi in cache
                        center = geocoder.lookup(f"{r['comune']}, {PROVINCES.get(r['provincia'], (r['provincia'],))[0]}", box)
                    reason = judge(events, box, now_ms, center)
                reasons[r["codice_istat"]] = reason
                print(f"{r['comune']:<28} {len(events):>3} eventi  {'ATTIVO' if reason is None else reason}", flush=True)
        finally:
            geocoder.save()

    for r in todo:
        reason = reasons[r["codice_istat"]]
        if not args.dry_run:
            r["stato"] = "attivo" if reason is None else "da_verificare"
            r["note"] = note_with_reason(r, reason)
    if not args.dry_run:
        write_rows(rows)
    by_reason = Counter(re.sub(r"\(.*", "", v).strip() for v in reasons.values() if v)
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(path, "a", encoding="utf-8") as f:
            f.write(summary_md(todo, reasons) + "\n")
    print(f"\nAttivi: {sum(1 for v in reasons.values() if v is None)} su {len(todo)}")
    for reason, n in by_reason.most_common():
        print(f"  {n:>4}  {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
