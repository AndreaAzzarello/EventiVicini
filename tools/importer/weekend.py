"""«Questo weekend» della home (#22): finestra, righe candidate di una regione e bundle `bundles/weekend`.

Stessa strada della sitemap (sitemap.py), così nessun job scrive lo stesso documento in parallelo:
  1. ogni job `import` aggiunge alla sua parte `sitemap-<regione>.json` le righe candidate (`part_rows`): gli eventi che
     iniziano nel weekend, al massimo PER_CITY per città e PER_REGION in tutto, nel formato dei bundle (`bundles.compact`);
     sono tutti gli eventi raccolti nel giro, non solo quelli cambiati;
  2. il job `cleanup` unisce le parti (`merge`: finestra di adesso, nessun doppione, regioni alternate) e scrive il bundle
     `weekend` solo se il contenuto è cambiato (`write`): al massimo 1 lettura e 1 scrittura al giorno.
Il web legge il bundle con la chiave di cache legata alla version e sceglie i 5 eventi da mostrare (web/src/lib/weekend.ts).

Finestra: da venerdì 18:00 a domenica 23:59:59,999, ora italiana. Da lunedì al venerdì sera è il weekend che arriva; da
venerdì 18:00 a domenica è quello in corso. I casi di prova sono in docs/schema/parity.json (`weekendWindows`), letti anche
dai test del web: Python e TypeScript devono dare la stessa finestra.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, time, timedelta

from bundles import FIELDS, LONG_RUNNING_MS, commit, compact, pack, read, write_bucket
from mapping import ROME

log = logging.getLogger(__name__)

NAME = "weekend"
PER_CITY = 2  # eventi per città nella parte di una regione: la scelta finale ne prende uno solo per città
PER_REGION = 60  # righe per regione nella parte (≈ 18 KB)
TOTAL = 200  # righe nel bundle (≈ 60 KB), alternate tra le regioni

_AT = {f: FIELDS.index(f) for f in ("id", "startTime", "endTime", "citySlug", "longRunning", "approxLocation")}


def window(now_ms: int) -> tuple[int, int]:
    """(inizio, fine) in ms del weekend di riferimento, fine compresa: ven 18:00 – dom 23:59:59,999 in ora italiana."""
    local = datetime.fromtimestamp(now_ms / 1000, ROME)
    friday = local.date() + timedelta(days=4 - local.weekday())  # lun-ven: il venerdì di questa settimana; sab -1, dom -2
    start = datetime.combine(friday, time(18, 0), tzinfo=ROME)
    end = datetime.combine(friday + timedelta(days=3), time(0, 0), tzinfo=ROME)  # lunedì 00:00, escluso
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000) - 1


def _order(ev_id: str) -> str:
    return hashlib.md5(ev_id.encode()).hexdigest()  # ordine casuale ma stabile: lo stesso input dà la stessa parte


def part_rows(events: list[dict], now_ms: int) -> list[list]:
    """Righe candidate di una regione: iniziano nella finestra, non finiti, posizione esatta, non di lunga durata."""
    lo, hi = window(now_ms)
    by_city: dict[str, list[dict]] = {}
    for ev in events:
        start, end = int(ev.get("startTime") or 0), int(ev.get("endTime") or 0)
        if not (ev.get("id") and ev.get("citySlug") and ev.get("lat") and ev.get("lng")):
            continue
        if not (lo <= start <= hi and end >= now_ms) or ev.get("approxLocation") or ev.get("longRunning") or end - start > LONG_RUNNING_MS:
            continue
        by_city.setdefault(ev["citySlug"], []).append(ev)
    ranked: list[tuple[int, str, dict]] = []
    for evs in by_city.values():
        for i, ev in enumerate(sorted(evs, key=lambda e: (e["startTime"], e["id"]))[:PER_CITY]):
            ranked.append((i, _order(ev["id"]), ev))
    ranked.sort(key=lambda t: (t[0], t[1]))  # prima un evento per città, poi il secondo
    return [compact(ev) for _, _, ev in ranked[:PER_REGION]]


def merge(parts: dict[str, list[list]], now_ms: int) -> list[list]:
    """Parti delle regioni (anche vecchie, dalla cache) → righe del bundle: solo la finestra di adesso, un id una volta sola,
    regioni alternate così nessuna riempie da sola il bundle."""
    lo, hi = window(now_ms)
    seen: set[str] = set()
    queues: list[list[list]] = []
    for region in sorted(parts):
        keep = []
        for r in parts[region]:
            if len(r) <= max(_AT.values()) or r[_AT["id"]] in seen:
                continue
            start, end = int(r[_AT["startTime"]] or 0), int(r[_AT["endTime"]] or 0)
            if lo <= start <= hi and end >= now_ms and not r[_AT["approxLocation"]] and not r[_AT["longRunning"]]:
                seen.add(r[_AT["id"]])
                keep.append(r)
        queues.append(keep)
    out: list[list] = []
    for i in range(max((len(q) for q in queues), default=0)):
        out += [q[i] for q in queues if i < len(q)]
    return out[:TOTAL]


def write(db, rows: list[list], now_ms: int) -> dict:
    """Scrive il bundle se è cambiato (anche vuoto: la webapp nasconde la fascia). 1 lettura, 0 o più scritture (testa + parti)."""
    prev, reads = read(db, [NAME])
    ops: list = []
    writes = write_bucket(db, ops, NAME, pack(rows), prev.get(NAME), now_ms)
    commit(db, ops)
    return {"reads": reads, "writes": writes}


def summary(rows: list[list]) -> str:
    return f"{len(rows)} righe, {len({r[_AT['citySlug']] for r in rows})} città"
