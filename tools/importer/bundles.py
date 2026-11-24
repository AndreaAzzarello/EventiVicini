"""Bundle: liste di eventi precalcolate, lette dalla webapp al posto delle query sulla collezione events.

Una lettura per documento invece di una per evento. Collezione `bundles` (lettura pubblica, scrittura solo da qui):
  g_<geohash4>   eventi attivi e futuri di una cella di ~39×20 km        (home, mappa, /api/events)
  c_<citySlug>   eventi di una città                                     (/citta)
  sitemap        i 500 eventi che finiscono prima                        (sitemap.xml)
  coverage       copertura di tutte le regioni                           (ricerca luoghi, home senza luogo)
               la webapp usa le liste solo se esiste (finché manca, ripiega sulle query)
Ogni bundle è {json, hash, parts, n}: `json` è una lista di righe con i campi di FIELDS, nell'ordine; sopra MAX_PART
byte continua in `<nome>~1`, `<nome>~2`... Si riscrive solo se l'hash cambia; coverage porta anche `version`, aggiornata a ogni giro e scritta per ultima. FIELDS deve coincidere con
web/src/lib/server/bundles.ts (lo controlla tests/test_bundles.py).

Si parte dal bundle già scritto: un import parziale (--regione) non cancella gli eventi delle altre regioni nelle
celle di confine, e una fonte che oggi non risponde non svuota le sue celle.
shortcut: gli eventi creati o approvati dall'admin entrano al prossimo import (sono letti qui ogni volta);
un evento che cambia cella resta anche in quella vecchia fino alla fine (la webapp deduplica per id).
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections import defaultdict

log = logging.getLogger("importer")

COLL = "bundles"
FIELDS = ["id", "title", "startTime", "endTime", "category", "priceType", "venueName", "address", "locality", "city",
          "citySlug", "cityAlt", "province", "region", "lat", "lng", "imageUrl", "tags", "longRunning", "approxLocation"]
NUMBERS = {"startTime", "endTime", "lat", "lng"}
FLAGS = {"longRunning", "approxLocation"}
KIDS_TAGS = {"kids", "family"}  # gli unici tag che la webapp usa
LONG_RUNNING_MS = 14 * 86_400_000
CELL = 4
MAX_PART = 700_000  # byte di JSON per documento (limite Firestore 1 MiB)
MAX_COVERAGE = 900_000
SITEMAP_MAX = 500
GET_ALL_CHUNK = 300
BATCH = 400


def compact(ev: dict) -> list:
    row = []
    for f in FIELDS:
        v = ev.get(f)
        if f == "tags":
            v = [t for t in (v or []) if t in KIDS_TAGS]
        elif f == "longRunning":
            v = bool(v) or (ev.get("endTime") or 0) - (ev.get("startTime") or 0) > LONG_RUNNING_MS
        elif f in FLAGS:
            v = bool(v)
        elif f in NUMBERS:
            v = v or 0
        else:
            v = v or ""
        row.append(v)
    return row


def buckets_of(ev: dict) -> list[str]:
    out = []
    if ev.get("geohash"):
        out.append(f"g_{ev['geohash'][:CELL]}")
    if ev.get("citySlug"):
        out.append(f"c_{ev['citySlug']}")
    return out


def dumps(x) -> str:
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"))


def pack(rows: list[list]) -> list[str]:
    """Righe → uno o più JSON da al massimo MAX_PART byte, ordinate per id (hash stabile)."""
    parts: list[list[list]] = [[]]
    size = 2
    for r in sorted(rows, key=lambda r: r[0]):
        n = len(dumps(r).encode()) + 1
        if parts[-1] and size + n > MAX_PART:
            parts.append([])
            size = 2
        parts[-1].append(r)
        size += n
    return [dumps(p) for p in parts]


def digest(parts: list[str]) -> str:
    return hashlib.sha1("\n".join(parts).encode()).hexdigest()[:16]


def read(db, names: list[str]) -> tuple[dict[str, dict], int]:
    """name → {"json": [parti], "hash", "parts"} per i bundle esistenti; più le letture fatte."""
    out: dict[str, dict] = {}
    reads = 0
    docs = [db.collection(COLL).document(n) for n in sorted(set(names))]
    for i in range(0, len(docs), GET_ALL_CHUNK):
        for d in db.get_all(docs[i:i + GET_ALL_CHUNK]):
            reads += 1
            if d.exists:
                x = d.to_dict() or {}
                out[d.id] = {"json": [x.get("json", "[]")], "hash": x.get("hash"), "parts": x.get("parts", 1)}
    more = [(n, db.collection(COLL).document(f"{n}~{k}")) for n, b in out.items() for k in range(1, b["parts"])]
    for i in range(0, len(more), GET_ALL_CHUNK):
        chunk = more[i:i + GET_ALL_CHUNK]
        for (n, _), d in zip(chunk, db.get_all([r for _, r in chunk])):
            reads += 1
            out[n]["json"].append((d.to_dict() or {}).get("json", "[]") if d.exists else "[]")
    return out, reads


def rows_of(bundle: dict | None) -> list[list]:
    return [r for p in (bundle["json"] if bundle else []) for r in json.loads(p)]


def write_bucket(db, ops: list, name: str, parts: list[str], prev: dict | None, now_ms: int, extra: dict | None = None) -> int:
    """Accoda il gruppo di scritture di un bundle se è cambiato; restituisce quante operazioni.

    Ordine nel gruppo: prima le parti `~k`, poi la testa (parts=N), per ultime le cancellazioni delle parti in più: chi legge
    la testa trova sempre le sue parti. `extra`: campi in più nella testa (es. version di coverage).
    """
    h = digest(parts)
    if prev and prev["hash"] == h:
        return 0
    ref = lambda n: db.collection(COLL).document(n)  # noqa: E731
    head = {"json": parts[0], "hash": h, "parts": len(parts), "n": len(json.loads(parts[0])), "updatedAt": now_ms} | (extra or {})
    group = [lambda b, r=ref(f"{name}~{k}"), d={"json": p}: b.set(r, d) for k, p in enumerate(parts) if k]
    group.append(lambda b, r=ref(name), d=head: b.set(r, d))
    group += [lambda b, r=ref(f"{name}~{k}"): b.delete(r) for k in range(len(parts), prev["parts"] if prev else 1)]
    ops.append(group)
    return len(group)


def commit(db, groups: list[list]) -> None:
    """Un gruppo (un bundle) non si spezza tra due batch: se ci sta, entra intero in uno; se da solo supera BATCH, si scrive
    a pezzi nell'ordine del gruppo (parti, poi testa), quindi la testa è sempre l'ultima a diventare visibile."""
    pending: list = []

    def flush():
        if pending:
            b = db.batch()
            for op in pending:
                op(b)
            b.commit()
            pending.clear()

    for group in groups:
        if len(group) > BATCH:
            flush()
            for i in range(0, len(group), BATCH):
                pending.extend(group[i:i + BATCH])
                flush()
            continue
        if len(pending) + len(group) > BATCH:
            flush()
        pending.extend(group)
    flush()


def write_events(db, upserts: list[dict], removed: list[dict], now_ms: int, budget: int) -> dict:
    """Aggiorna i bundle delle celle, delle città e della sitemap.

    upserts: eventi (campi del documento + id) da inserire o aggiornare; removed: eventi nascosti (id e, se noti,
    geohash/citySlug). Restituisce le letture e le scritture fatte.
    """
    up: dict[str, dict[str, list]] = defaultdict(dict)  # bucket → id → riga
    gone: dict[str, set[str]] = defaultdict(set)
    for ev in upserts:
        if (ev.get("endTime") or 0) < now_ms:
            continue
        row = compact(ev)
        for b in buckets_of(ev) + ["sitemap"]:
            up[b][ev["id"]] = row
    for ev in removed:
        for b in buckets_of(ev) + ["sitemap"]:
            gone[b].add(ev["id"])
    names = sorted(set(up) | set(gone))
    prev, reads = read(db, names)
    ops: list = []
    planned: list[tuple[str, list[str], dict | None]] = []
    for name in names:
        rows = {r[0]: r for r in rows_of(prev.get(name)) if r[3] >= now_ms and r[0] not in gone[name]}
        rows |= up[name]
        merged = list(rows.values())
        if name == "sitemap":
            merged = sorted(merged, key=lambda r: (r[3], r[0]))[:SITEMAP_MAX]
        planned.append((name, pack(merged), prev.get(name)))
    # priorità se manca il budget: sitemap, poi celle, poi città
    planned.sort(key=lambda p: (p[0] != "sitemap", p[0].startswith("c_"), p[0]))
    writes = 0
    for name, parts, old in planned:
        probe: list = []
        cost = write_bucket(db, probe, name, parts, old, now_ms)
        if writes + cost > budget:
            log.warning("Bundle %s non scritto: budget di scritture esaurito (%d)", name, budget)
            continue
        ops += probe
        writes += cost
    commit(db, ops)
    log.info("Bundle: %d da aggiornare, %d scritture, %d letture", len(planned), writes, reads)
    return {"reads": reads, "writes": writes}


def write_coverage(db, docs: dict[str, dict], now_ms: int) -> dict:
    """docs: slug regione → documento coverage/{slug}. Unisce con quelli già nel bundle (import parziali)."""
    prev, reads = read(db, ["coverage"])
    old = json.loads(prev["coverage"]["json"][0]) if "coverage" in prev else []
    regions = {r["slug"]: r for r in old}
    for slug, d in docs.items():
        regions[slug] = {"slug": slug, "name": d["name"], "comuni": d["comuni"]}
    s = dumps(sorted(regions.values(), key=lambda r: r["name"]))
    if len(s.encode()) > MAX_COVERAGE:
        log.error("Bundle coverage troppo grande (%d byte): non scritto, la webapp usa i documenti per regione", len(s))
        return {"reads": reads, "writes": 0}
    ops: list = []
    # `version` cambia a ogni giro (anche a copertura invariata) ed è l'ultima cosa che il job scrive: la webapp la mette
    # nelle chiavi di cache, quindi una versione nuova è visibile solo a bundle completi.
    writes = write_bucket(db, ops, "coverage", [s], prev.get("coverage"), now_ms, {"version": now_ms})
    if not writes:
        ops.append([lambda b, r=db.collection(COLL).document("coverage"): b.set(r, {"version": now_ms}, merge=True)])
        writes = 1
    commit(db, ops)
    return {"reads": reads, "writes": writes}
