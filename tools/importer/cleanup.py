"""Pulizia giornaliera del database (gira dopo l'import, vedi .github/workflows/import-events.yml).

Regole:
  eventi scraper finiti da più di 7 giorni                       → eliminati
  eventi con removedAt da più di 30 giorni                       → eliminati
  eventi manual e user finiti da più di 30 giorni                → eliminati
  proposte rifiutate da più di 90 giorni, approvate da più di 30 → eliminate
  segnalazioni decise (rimosse o respinte) da più di 180 giorni   → eliminate; le aperte restano

Uso:  python cleanup.py --dry-run        # conta senza eliminare
      python cleanup.py                  # elimina, al massimo --max-deletes documenti per giro
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import logsafe
from run import BATCH, commit_in_batches

log = logging.getLogger("importer")
DAY = 86_400_000
SCRAPER_AFTER, OTHER_AFTER, REMOVED_AFTER = 7 * DAY, 30 * DAY, 30 * DAY
APPROVED_AFTER, REJECTED_AFTER = 30 * DAY, 90 * DAY
REPORT_AFTER = 180 * DAY  # segnalazioni DSA chiuse: tracciabilità delle decisioni, poi via (anche l'email di chi ha segnalato)
MAX_DELETES = 15_000  # quota Spark 20.000 cancellazioni al giorno, con margine


def ms(t) -> int | None:
    """Timestamp Firestore (datetime) o millisecondi → millisecondi."""
    return int(t.timestamp() * 1000) if isinstance(t, datetime) else t


def expired_events(docs: dict[str, dict], now_ms: int) -> list[str]:
    out = []
    for doc_id, d in docs.items():
        end, removed = d.get("endTime"), d.get("removedAt")
        after = SCRAPER_AFTER if d.get("source") == "scraper" else OTHER_AFTER
        if (end is not None and end < now_ms - after) or (removed and removed < now_ms - REMOVED_AFTER):
            out.append(doc_id)
    return out


def expired_submissions(docs: dict[str, dict], now_ms: int) -> list[str]:
    after = {"approved": APPROVED_AFTER, "rejected": REJECTED_AFTER}  # pending: mai
    return [i for i, d in docs.items()
            if d.get("status") in after and (r := ms(d.get("reviewedAt"))) is not None and r < now_ms - after[d["status"]]]


def expired_reports(docs: dict[str, dict], now_ms: int) -> list[str]:
    return [i for i, d in docs.items()
            if d.get("status") in ("removed", "dismissed") and (r := ms(d.get("decidedAt"))) is not None
            and r < now_ms - REPORT_AFTER]


def run(db, now: datetime, dry_run: bool = False, max_deletes: int = MAX_DELETES) -> dict:
    """Legge solo i candidati (query a campo singolo con proiezione) ed elimina a lotti, fino a max_deletes."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    now_ms = int(now.timestamp() * 1000)
    events, subs = db.collection("events"), db.collection("submissions")
    reads = 0
    docs: dict[str, dict] = {}
    for field, cutoff in (("endTime", now_ms - SCRAPER_AFTER), ("removedAt", now_ms - REMOVED_AFTER)):
        for d in events.where(filter=FieldFilter(field, "<", cutoff)).select(["source", "endTime", "removedAt"]).stream():
            reads += 1
            docs[d.id] = d.to_dict() or {}
    sub_docs: dict[str, dict] = {}
    cutoff = now - timedelta(milliseconds=min(APPROVED_AFTER, REJECTED_AFTER))
    for d in subs.where(filter=FieldFilter("reviewedAt", "<", cutoff)).select(["status", "reviewedAt"]).stream():
        reads += 1
        sub_docs[d.id] = d.to_dict() or {}
    reports = db.collection("reports")
    report_docs: dict[str, dict] = {}
    for d in reports.where(filter=FieldFilter("decidedAt", "<", now - timedelta(milliseconds=REPORT_AFTER))).select(["status", "decidedAt"]).stream():
        reads += 1
        report_docs[d.id] = d.to_dict() or {}
    targets = [events.document(i) for i in expired_events(docs, now_ms)]
    targets += [subs.document(i) for i in expired_submissions(sub_docs, now_ms)]
    targets += [reports.document(i) for i in expired_reports(report_docs, now_ms)]
    due = len(targets)
    if due > max_deletes:
        log.warning("Da eliminare %d documenti, oltre il tetto di %d: il resto al prossimo giro", due, max_deletes)
        targets = targets[:max_deletes]
    if not dry_run:
        commit_in_batches(db, [lambda b, r=r: b.delete(r) for r in targets])
    stats = {"reads": reads, "deleted": 0 if dry_run else len(targets), "due": due}
    log.info("Pulizia%s: %d da eliminare, %d eliminati, %d letture", " (dry-run)" if dry_run else "", due,
             stats["deleted"], reads)
    return stats


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="conta senza eliminare")
    p.add_argument("--max-deletes", type=int, default=MAX_DELETES)
    p.add_argument("--stats-out", type=Path, help="scrive qui le statistiche (JSON)")
    args = p.parse_args(argv)
    logsafe.setup()
    from db import client

    stats = run(client(), datetime.now(timezone.utc), args.dry_run, args.max_deletes)
    if args.stats_out:
        args.stats_out.write_text(json.dumps(stats), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
