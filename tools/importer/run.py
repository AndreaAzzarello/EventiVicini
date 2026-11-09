"""Importer degli eventi pubblici dai siti dei Comuni (fonti in adapters/).

Uso:  python run.py --dry-run            # stampa senza scrivere
      python run.py                      # upsert su Firestore + pulizia scaduti
      python run.py --source modena      # una sola fonte
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import uuid
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit

import httpx
from concurrent.futures import ThreadPoolExecutor

import bundles
import clusters
import logsafe
import sourcehealth
import unreachable
import manifest
from adapters import SOURCES, Adapter, fallback_place
from geo import PROVINCES, enrich, in_viewbox, slugify
import fetch as httpfetch  # `fetch` è anche una funzione locale di collect()
from fetch import CONNECT_FAILED
from geocode import Geocoder
from netcluster import NetGate, interleave
from meter import BudgetExceeded, SourceMeter
from mapping import ROME, content_hash, dedupe_key, html_to_text, is_long_running, one_line
from registry import USER_AGENT, read_rows
from relevance import exclusion_reason

HERE = Path(__file__).parent
WORKERS = 4  # fonti scaricate in parallelo
METER = SourceMeter()
# 5 s tagliava host che col vecchio timeout di 30 s funzionavano (dry-run del 3/11: Veroli, Casorate Sempione...); i morti ora costano 15 s, una volta
CONNECT_TIMEOUT = 15
IP_INTERVAL = 1.0  # secondi tra due richieste allo stesso IP (host diversi sullo stesso hosting contano insieme)
SUBNET_CONCURRENCY = 2  # richieste in volo nella stessa subnet (/24): i 4 worker non si concentrano su un fornitore
SOURCE_BUDGET = 600  # secondi per fonte: una fonte sana ha impiegato da 41 a 223 s (Albiano d'Ivrea, prova del 3/11); da tarare sul riepilogo "Fonti più lente"
log = logging.getLogger("importer")


class Got(NamedTuple):
    """Esito del download di una fonte; kind: "" | "connect" (host che non risponde) | "parked" (saltata, attesa in corso) | "budget" (tempo esaurito)."""
    found: list[dict]
    error: str | None
    seconds: float
    requests: int
    kind: str = ""


def collect(client: httpx.Client, geocoder: Geocoder, names: list[str], now: datetime,
            horizon_days: int, stats: dict[str, dict] | None = None, excluded: list[dict] | None = None,
            retry_wait: float | None = None, unreachable_state: dict[str, dict] | None = None,
            source_budget: float | None = None, health: dict | None = None) -> list[dict]:
    """stats (opzionale): per fonte {"events", "skipped", "excluded", "error"}; "error" None = la fonte ha risposto.
    excluded (opzionale): riceve le pagine scartate dal filtro anti-avvisi, {"id", "title", "reason", "source", "region"}.
    retry_wait (opzionale): a fine giro le fonti che non hanno risposto si riprovano una volta dopo tanti secondi; in stats
    compaiono "retry" ("ok" o "fallito") e "first_error".
    unreachable_state (opzionale, vedi unreachable.py): gli host che non rispondono si saltano finché non scade l'attesa
    (stats "parked") e si aggiornano con l'esito di oggi; chi fallisce la connessione ("connect") non va al secondo giro.
    source_budget (opzionale): secondi concessi a ciascuna fonte dei Comuni; oltre, la fonte è saltata ("budget"), con gli eventi
    letti fin lì scartati: la copertura di ieri resta valida e non si riprova nello stesso giro.
    health (opzionale, vedi sourcehealth.py): si aggiorna con l'esito di ogni fonte e con le interruzioni di rete risolte."""
    events: dict[tuple, dict] = {}
    owner: dict[tuple, str] = {}  # chiave di deduplica → fonte che ha tenuto l'evento
    stats = {} if stats is None else stats

    METER.attach(client)
    today = now.date()

    def host_of(name: str) -> str | None:
        """Host da ricordare: solo i siti dei Comuni (le fonti regionali sono API uniche, non si parcheggiano)."""
        a = SOURCES[name]
        return None if unreachable_state is None or getattr(a, "regional", False) else urlsplit(a.base).netloc

    def fetch(name: str, force: bool = False) -> Got:
        """Solo rete (un host per fonte, 1 richiesta/s ciascuno): può girare in parallelo. force: le sentinelle di un cluster
        si provano anche se il loro host è parcheggiato."""
        host = host_of(name)
        if host and not force and not unreachable.due(unreachable_state, host, today):
            h = unreachable_state[host]
            return Got([], f"host irraggiungibile ({h['fails']} tentativi falliti, {h['reason']}): riprovo dal "
                           f"{unreachable.retry_on(unreachable_state, host):%d/%m}", 0.0, 0, "parked")
        METER.start(None if getattr(SOURCES[name], "regional", False) else source_budget)  # le fonti regionali (API uniche) hanno i loro limiti
        kind = ""
        try:
            found, error = list(SOURCES[name].events(client, now, horizon_days)), None
        except httpx.HTTPError as e:
            found, error = [], logsafe.redact(str(e)) or type(e).__name__
            kind = "connect" if isinstance(e, CONNECT_FAILED) else ""
        except BudgetExceeded as e:
            found, error, kind = [], f"saltata: {e}", "budget"
        except Exception as e:  # un bug o una pagina anomala in una fonte non deve fermare le altre
            log.exception("%s: errore imprevisto", name)
            found, error = [], logsafe.redact(f"{type(e).__name__}: {e}")
        seconds, requests = METER.stop()
        log.info("%s: %s s, %d richieste, %s", name, f"{seconds:.1f}".replace(".", ","), requests,
                 f"errore ({error[:120]})" if error else f"ok, {len(found)} eventi grezzi")  # subito: lo stdout del job si legge mentre gira
        return Got(found, error, seconds, requests, kind)

    def probe_clusters(batch: list[str]) -> dict[str, Got]:
        """Sentinelle per subnet (vedi clusters.py). Restituisce gli esiti già pronti: le sentinelle e, per le subnet giù, tutte le
        altre fonti del gruppo, che non si tentano né si parcheggiano. Senza limiti di rete o senza stato degli host non fa nulla."""
        gate = httpfetch.DEFAULT_GATE
        if gate is None or unreachable_state is None:
            return {}
        cand = [n for n in batch if host_of(n)]
        subnet = {n: gate.net.subnet(host_of(n)) for n in cand}  # già risolte da process()
        grouped = clusters.groups(cand, subnet.get)
        chosen = {s: clusters.pick_canaries(g, host_of, unreachable_state, last_ok=lambda n: sourcehealth.last_ok(health, n))
                  for s, g in grouped.items()}
        chosen = {s: c for s, c in chosen.items() if len(c) == clusters.CANARIES}
        sentinels = [n for c in chosen.values() for n in c]
        if not sentinels:
            return {}
        with ThreadPoolExecutor(WORKERS) as pool:
            tried = dict(zip(sentinels, pool.map(lambda n: fetch(n, force=True), sentinels)))
        pre: dict[str, Got] = {}
        for sub, canaries in chosen.items():
            group = grouped[sub]
            if clusters.is_down([tried[n].kind for n in canaries]):
                since = clusters.mark_down(unreachable_state, sub, today, tried[canaries[0]].error or "", len(group))
                why = (f"rete del fornitore non raggiungibile ({sub}, {len(canaries)} sentinelle senza risposta, "
                       f"dal {date.fromisoformat(since):%d/%m}): riprovo al prossimo import")
                for n in group:
                    pre[n] = tried[n]._replace(kind="cluster") if n in tried else Got([], why, 0.0, 0, "cluster")
                log.warning("Rete: %d fonti in %s non tentate (%d sentinelle su %d senza risposta, giù dal %s)",
                            len(group) - len(canaries), sub, len(canaries), len(canaries), f"{date.fromisoformat(since):%d/%m}")
            else:
                for n in canaries:
                    pre[n] = tried[n]
                parked = [h for h in clusters.parked_hosts(group, host_of, unreachable_state)]
                back = clusters.mark_up(unreachable_state, sub)
                if back and health is not None:
                    sourcehealth.record_outage(health, sub, back, today)
                if clusters.should_release(back, parked):
                    clusters.release(unreachable_state, parked)
                    log.warning("Rete: %s risponde (%s), azzero i parcheggi di %d host", sub,
                                f"era giù dal {date.fromisoformat(back):%d/%m}" if back else "molti host erano fermi", len(parked))
        return pre

    def process(batch: list[str], probe: bool = True) -> None:
        pre: dict[str, Got] = {}
        with ThreadPoolExecutor(WORKERS) as pool:
            order = batch
            if (gate := httpfetch.DEFAULT_GATE) is not None:  # i worker non si concentrano su un solo hosting
                gate.net.prefetch(urlsplit(SOURCES[n].base).netloc for n in batch)  # DNS in parallelo, una volta
                order = interleave(batch, lambda n: gate.net.subnet(urlsplit(SOURCES[n].base).netloc))
                pre = probe_clusters(batch) if probe else {}
            todo = [n for n in order if n not in pre]
            done = pre | dict(zip(todo, pool.map(fetch, todo)))
            fetched = [done[n] for n in batch]
        # Geocoding (Nominatim, 1 richiesta/s in tutto) in sequenza, dagli eventi più vicini nel tempo: se il budget
        # di richieste del giro finisce, i più lontani restano senza geocoding e lo prendono nei giorni dopo.
        pending = []
        for name, got in zip(batch, fetched):
            found, error = got.found, got.error
            stats[name] = {"events": 0, "skipped": 0, "excluded": 0, "duplicates": 0, "error": error,
                           "seconds": round(got.seconds, 1), "requests": got.requests}
            if got.kind:  # "parked" (saltata senza rete), "cluster" (subnet giù), "connect" (connessione fallita) o "budget" (tempo esaurito): niente secondo giro
                stats[name][got.kind] = True
            if (host := host_of(name)) and got.kind not in ("parked", "cluster"):  # lo stato degli host si aggiorna nel thread principale
                if error is None:
                    unreachable.ok(unreachable_state, host)
                elif got.kind == "connect":
                    unreachable.fail(unreachable_state, host, today, error)
            if error:
                log.error("%s: fonte non raggiungibile (%s), la salto", name, error)
            pending += [(name, ev) for ev in found]
        pending.sort(key=lambda p: (p[1]["startTime"], p[1]["sourceUrl"]))
        for name, ev in pending:
            source: Adapter = SOURCES[name]
            year = datetime.fromtimestamp(ev["startTime"] / 1000, ROME).year
            if reason := ev.pop("_excluded", None) or exclusion_reason(ev["title"], year):  # prima del geocoding: costa una richiesta
                stats[name]["excluded"] += 1
                if excluded is not None:
                    excluded.append({"id": ev["id"], "title": ev["title"], "reason": reason, "source": name,
                                     "region": slugify(source.region)})
                continue
            locate(ev, source, geocoder)
            if ev["lat"] is None:
                stats[name]["skipped"] += 1
                log.warning("  senza coordinate, scartato: %s", ev["sourceUrl"])
                continue
            enrich(ev, ev.pop("_place", None) or place_of(geocoder, ev, source), fallback_place(source))
            use_italian_name(ev)
            clean_texts(ev)
            if is_long_running(ev):
                ev["longRunning"] = True
            ev["importRegion"] = slugify(source.region)  # regione del registro, non quella di Nominatim
            ev["contentHash"] = content_hash(ev)
            key, kept = dedupe_key(ev), owner.get(dedupe_key(ev))
            if kept == name and getattr(source, "sessions", False) and events[key]["startTime"] != ev["startTime"]:
                # due spettacoli dello stesso titolo nello stesso giorno e comune, a orari diversi (Ticketmaster): sono sessioni, non doppioni
                key = key + (ev["startTime"],)
                kept = owner.get(key)
            # stesso evento da più fonti: vince quella comunale, più ricca, su una fonte regionale (Open Data Hub)
            if kept is None or (getattr(SOURCES[kept], "regional", False) and not getattr(source, "regional", False)):
                if kept is not None:
                    stats[kept]["events"] -= 1
                    stats[kept]["duplicates"] += 1
                    keep_ticket(ev, events[key])
                events[key], owner[key] = ev, name
                stats[name]["events"] += 1
            else:
                stats[name]["duplicates"] += 1
                keep_ticket(events[key], ev)
        for name in batch:
            log.info("%s: %d eventi, %d senza coordinate, %d esclusi, %d doppioni", name, stats[name]["events"],
                     stats[name]["skipped"], stats[name]["excluded"], stats[name]["duplicates"])

    process(names)
    failed = [n for n in names if stats[n]["error"] and not any(stats[n].get(k) for k in ("parked", "cluster", "connect", "budget"))]
    if failed and retry_wait is not None:
        log.warning("%d fonti non raggiungibili: riprovo tra %d s", len(failed), retry_wait)
        time.sleep(retry_wait)
        first = {n: stats[n]["error"] for n in failed}
        process(failed, probe=False)
        for n in failed:
            stats[n] |= {"retry": "fallito" if stats[n]["error"] else "ok", "first_error": first[n]}
        log.info("Secondo tentativo: %d fonti recuperate su %d", sum(1 for n in failed if not stats[n]["error"]), len(failed))
    if health is not None:
        sourcehealth.update(health, stats, today)
    return list(events.values())


def keep_ticket(winner: dict, loser: dict) -> None:
    """Stesso evento da due fonti: il vincitore senza link d'acquisto prende quello dell'altra (Ticketmaster)."""
    if not winner["ticketUrl"] and loser["ticketUrl"]:
        winner["ticketUrl"] = loser["ticketUrl"]
        winner["contentHash"] = content_hash(winner)


def alt_index(rows: list[dict]) -> dict[tuple[str, str], tuple[str, str]]:
    """(sigla provincia, slug di ogni grafia) → (nome italiano, alias): "Bolzano - Bozen" e "Bozen" portano a Bolzano."""
    out = {}
    for r in rows:
        if r["comune_alt"]:
            it, alt = r["comune"], r["comune_alt"]
            for name in (it, alt, f"{it} - {alt}", f"{alt} - {it}", f"{it}/{alt}", f"{alt}/{it}"):
                out[(r["provincia"], slugify(name))] = (it, alt)
    return out


ALT = alt_index(read_rows())


def use_italian_name(ev: dict) -> None:
    """Comuni bilingui: city e citySlug restano il nome ufficiale italiano (slug stabile), l'alias va in cityAlt."""
    hit = ALT.get((ev["province"], ev["citySlug"]))
    if ev.get("region"):
        ev["region"] = ev["region"].split("/")[0].strip()  # "Trentino-Alto Adige/Südtirol" → nome italiano (slug della pagina regione)
    if hit:
        ev["city"], ev["citySlug"], ev["cityAlt"] = hit[0], slugify(hit[0]), hit[1]
        if ev.get("locality") and ALT.get((ev["province"], slugify(ev["locality"]))) == hit:
            del ev["locality"]  # Nominatim ripete il comune come frazione


def clean_texts(ev: dict) -> None:
    """Ultimo controllo su tutti gli adapter: niente tag né entità HTML nei testi (la descrizione tiene gli a capo)."""
    ev["shortDescription"] = html_to_text(ev["shortDescription"])
    for k in ("title", "venueName", "address"):
        ev[k] = one_line(ev[k])


def safe_lookup(geocoder: Geocoder, query: str, viewbox: str | None, **kw) -> tuple[float, float] | None:
    """geocoder.lookup che, se Nominatim non risponde (503, timeout), dà "non trovato": un errore momentaneo non deve fermare la regione."""
    try:
        return geocoder.lookup(query, viewbox, **kw)
    except httpx.HTTPError as e:
        log.warning("  geocoding non riuscito (%s), passo oltre", str(e)[:80])
        return None


def locate(ev: dict, source: Adapter, geocoder: Geocoder) -> None:
    """Coordinate dell'evento, sempre dentro la provincia della fonte.

    Quelle della fonte fuori provincia si scartano (capita: Umbria, Varsi…); si prova con gli indirizzi
    (comune e provincia nella query, risultato nel riquadro); in ultima istanza il centro del comune,
    con approxLocation=True.
    """
    queries = ev.pop("_geocode")
    if ev["lat"] is not None and not in_viewbox(ev["lat"], ev["lng"], source.viewbox):
        log.warning("  coordinate fuori provincia (%s, %s), le ignoro: %s", ev["lat"], ev["lng"], ev["sourceUrl"])
        ev["lat"] = ev["lng"] = None
    prov = PROVINCES.get(source.province, (source.province, None))[0]
    for q in queries:
        if ev["lat"] is not None:
            return
        hit = safe_lookup(geocoder, f"{q}, {prov}", source.viewbox)
        if hit:
            ev["lat"], ev["lng"] = hit
    if ev["lat"] is None:
        city = queries[0].rsplit(",", 1)[-1].strip() if queries else source.city
        # il centro del comune vale anche a budget finito (essential): meglio un punto approssimato che perdere l'evento
        hit = (safe_lookup(geocoder, f"{city}, {prov}", source.viewbox, essential=True)
               or safe_lookup(geocoder, f"{source.city}, {prov}", source.viewbox, essential=True))
        if hit:
            ev["lat"], ev["lng"] = hit
            ev["approxLocation"] = True
            log.warning("  luogo non trovato, uso il centro di %s: %s", city, ev["sourceUrl"])


def place_of(geocoder: Geocoder, ev: dict, source: Adapter) -> dict | None:
    """Comune, frazione, provincia e regione dalle coordinate; se Nominatim non risponde, non dà un comune
    o cade in un'altra provincia vale il comune della fonte."""
    try:
        return geocoder.reverse(ev["lat"], ev["lng"], source.city, source.province)
    except httpx.HTTPError as e:
        log.warning("  reverse geocoding non riuscito (%s), uso il comune della fonte", e)
        return None


MISSING_RUNS_TO_REMOVE = 2
BATCH = 400  # limite Firestore 500 operazioni per batch
GET_ALL_CHUNK = 300  # documenti per chiamata get_all (primo import di una regione grande)
MAX_WRITES = 15_000  # quota Spark 20.000 scritture al giorno, con margine
MAX_GEOCODE = 3_000  # richieste nuove a Nominatim per giro
MAX_READS = 40_000  # quota Spark 50.000 letture al giorno, con margine
#: campi letti in una sola query di proiezione: bastano a decidere cosa scrivere
PROJECTION = ["source", "contentHash", "removedAt", "missingRuns", "sourceUrl", "startTime", "endTime", "createdAt",
              "importRegion", "geohash", "citySlug"]


class QuotaExceeded(Exception):
    pass


def stale_updates(docs: dict[str, dict], seen_ids: set[str], ok_hosts: set[str], now_ms: int,
                  horizon_ms: int) -> dict[str, dict]:
    """Aggiornamenti per gli eventi scraper non ancora finiti che la loro fonte non pubblica più.

    docs: id → campi (source, sourceUrl, startTime, endTime, missingRuns, removedAt). Solo le fonti che in
    questo giro hanno risposto (ok_hosts) contano, e solo gli eventi che iniziano entro l'orizzonte (gli altri
    non erano nella lista letta). Al 2° import consecutivo senza l'evento: removedAt (nascosto, non cancellato).
    """
    out: dict[str, dict] = {}
    for doc_id, d in docs.items():
        if doc_id in seen_ids or d.get("source") != "scraper" or d.get("removedAt") or (d.get("endTime") or 0) < now_ms:
            continue
        if urlsplit(d.get("sourceUrl") or "").netloc not in ok_hosts or (d.get("startTime") or 0) > now_ms + horizon_ms:
            continue
        missing = (d.get("missingRuns") or 0) + 1
        out[doc_id] = {"missingRuns": missing} | ({"removedAt": now_ms} if missing >= MISSING_RUNS_TO_REMOVE else {})
    return out


def plan_writes(events: list[dict], existing: dict[str, dict], ok_hosts: set[str], now_ms: int,
                horizon_ms: int, excluded: set[str] = frozenset()) -> dict:
    """Cosa scrivere: solo gli eventi nuovi o con hash diverso (o da ripristinare), più gli spariti dalla fonte.

    existing: id → campi del documento già nel database (PROJECTION). Gli eventi con `source == manual`
    (modificati dall'admin) non si toccano. excluded: id scartati dal filtro anti-avvisi; se sono già nel
    database si nascondono subito (removedAt), senza aspettare il 2° giro.
    """
    write, unchanged, kept_manual = [], 0, 0
    for ev in events:
        old = existing.get(ev["id"])
        if old is None:
            write.append(ev)
        elif old.get("source") == "manual":
            kept_manual += 1
        elif old.get("contentHash") == ev["contentHash"] and not old.get("removedAt") and not old.get("missingRuns"):
            unchanged += 1
        else:
            write.append(ev)
    stale = stale_updates(existing, {ev["id"] for ev in events} | excluded, ok_hosts, now_ms, horizon_ms)
    for doc_id in excluded:
        d = existing.get(doc_id)
        if d and d.get("source") == "scraper" and not d.get("removedAt"):
            stale[doc_id] = {"removedAt": now_ms}
    return {"write": write, "unchanged": unchanged, "kept_manual": kept_manual, "stale": stale}


def commit_in_batches(db, ops: list) -> None:
    """ops: funzioni (batch) → None, committate a gruppi di BATCH."""
    for i in range(0, len(ops), BATCH):
        b = db.batch()
        for op in ops[i:i + BATCH]:
            op(b)
        b.commit()


class Retry(Exception):
    """Il manifest non rispecchia più Firestore (documento sparito): si rifà il giro con la riconciliazione completa."""

    def __init__(self, reads: int):
        self.reads = reads


def from_manifest(db, coll, regions: set[str], now_ms: int, directory: Path):
    """(existing, letture, manifest per regione) dal manifest locale più i soli eventi manuali; None se serve la
    riconciliazione (manifest assente, vecchio o non coerente con importState)."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    manifests = {r: manifest.load(directory, r, now_ms) for r in regions}
    if any(m is None for m in manifests.values()):
        return None
    reads = len(regions)
    for d in db.get_all([db.collection(manifest.STATE).document(r) for r in sorted(regions)]):
        if not d.exists or (d.to_dict() or {}).get("token") != manifests[d.id]["token"]:
            return None
    existing: dict[str, dict] = {}
    for m in manifests.values():
        existing |= manifest.prune(m["docs"], now_ms)
    # le modifiche dell'admin (source manual) non passano dal manifest: si rileggono sempre, sono poche
    manual = (coll.where(filter=FieldFilter("importRegion", "in", sorted(regions)))
              .where(filter=FieldFilter("source", "==", "manual")))
    found = {d.id: d.to_dict() or {} for d in manual.select(PROJECTION).stream()}
    return existing | found, reads + max(1, len(found)), manifests


def write(events: list[dict], now: datetime, ok_hosts: set[str] | None = None, horizon_days: int = 60,
          regions: set[str] | None = None, db=None, max_writes: int = MAX_WRITES, max_reads: int = MAX_READS,
          excluded: set[str] = frozenset(), manifest_dir: Path | None = None, reconcile: bool = False,
          with_bundles: bool = False) -> dict:
    """Upsert incrementale. Il confronto parte dal manifest locale (manifest_dir) o, se manca/è vecchio/non coerente
    o con reconcile=True, da una lettura di proiezione degli eventi scraper delle regioni; poi si scrive solo ciò che è
    cambiato. Si ferma prima di scrivere se le quote stimate superano max_writes/max_reads.
    Restituisce le statistiche (letti, scritti, invariati, nascosti, fonte del confronto)."""
    kw = dict(events=events, now=now, ok_hosts=ok_hosts, horizon_days=horizon_days, regions=regions, db=db,
              max_writes=max_writes, max_reads=max_reads, excluded=excluded, manifest_dir=manifest_dir,
              with_bundles=with_bundles)
    try:
        return _write(**kw, reconcile=reconcile)
    except Retry as r:
        log.warning("Il manifest non rispecchia Firestore: riconciliazione completa")
        stats = _write(**kw, reconcile=True)
        stats["reads"] += r.reads
        return stats


def _write(events, now, ok_hosts, horizon_days, regions, db, max_writes, max_reads, excluded, manifest_dir,
           reconcile, with_bundles) -> dict:
    from google.api_core.exceptions import NotFound
    from google.cloud.firestore_v1.base_query import FieldFilter

    if db is None:
        from db import client as firestore_client  # solo qui: il dry-run non richiede credenziali

        db = firestore_client()
    coll = db.collection("events")
    now_ms = int(now.timestamp() * 1000)
    regions = regions or {ev["importRegion"] for ev in events}
    loaded = from_manifest(db, coll, regions, now_ms, manifest_dir) if manifest_dir and not reconcile else None
    if loaded:
        existing, reads, old = loaded
        compare = "manifest"
    else:
        old, compare = {}, "firestore"
        query = coll.where(filter=FieldFilter("importRegion", "in", sorted(regions)))
        indexed = query.count().get()[0][0].value  # 1 lettura ogni 1000 voci
        reads = max(1, -(-indexed // 1000))
        if reads + indexed > max_reads:
            raise QuotaExceeded(f"letture stimate {reads + indexed} > {max_reads}: non scrivo")
        existing = {d.id: d.to_dict() or {} for d in query.select(PROJECTION).stream()}
        reads += len(existing)
    # Id non trovati (nuovi, o vecchi documenti senza importRegion): un get_all per createdAt e source manual.
    missing = [ev["id"] for ev in events if ev["id"] not in existing]  # gli esclusi sono tutti nella proiezione o non esistono
    if reads + len(missing) > max_reads:
        raise QuotaExceeded(f"letture stimate {reads + len(missing)} > {max_reads}: non scrivo")
    elsewhere = {d.id: d.to_dict() or {} for i in range(0, len(missing), GET_ALL_CHUNK)
                 for d in db.get_all([coll.document(x) for x in missing[i:i + GET_ALL_CHUNK]], field_paths=PROJECTION)
                 if d.exists}
    reads += len(missing)
    known = existing | elsewhere
    plan = plan_writes(events, known, ok_hosts or set(), now_ms, horizon_days * 86_400_000, excluded)
    # protocollo importState: segnaposto prima, token nuovo dopo; senza modifiche e col manifest valido non si scrive nulla
    track = bool(manifest_dir) and (compare == "firestore" or bool(plan["write"] or plan["stale"]))
    n_writes = len(plan["write"]) + len(plan["stale"]) + (2 * len(regions) if track else 0)
    if n_writes > max_writes:
        raise QuotaExceeded(f"scritture stimate {n_writes} > {max_writes}: non scrivo")

    def state(region: str, token: str):
        return lambda b: b.set(db.collection(manifest.STATE).document(region), {"token": token, "savedAt": now_ms})

    ops, docs = [], {}
    for ev in plan["write"]:
        doc = {k: v for k, v in ev.items() if k != "id"}
        doc["createdAt"] = known.get(ev["id"], {}).get("createdAt") or now_ms
        doc["updatedAt"] = now_ms
        docs[ev["id"]] = {k: doc[k] for k in PROJECTION if k in doc}
        ops.append(lambda b, ref=coll.document(ev["id"]), doc=doc: b.set(ref, doc))
    for doc_id, fields in plan["stale"].items():
        ops.append(lambda b, ref=coll.document(doc_id), fields=fields: b.update(ref, fields))
    token = uuid.uuid4().hex
    try:
        if track:
            commit_in_batches(db, [state(r, "pending") for r in sorted(regions)])
        commit_in_batches(db, ops)
        if track:
            commit_in_batches(db, [state(r, token) for r in sorted(regions)])
    except NotFound:
        if compare == "manifest":
            raise Retry(reads) from None
        raise
    if track:
        scraper = {i: d for i, d in known.items() if d.get("source") == "scraper"}
        for doc_id, fields in plan["stale"].items():
            if doc_id in scraper:
                scraper[doc_id] = scraper[doc_id] | fields
        scraper |= docs
        for r in regions:
            manifest.save(manifest_dir, r, {
                "token": token, "savedAt": now_ms,
                "reconciledAt": old[r]["reconciledAt"] if compare == "manifest" else now_ms,
                "docs": {i: d for i, d in scraper.items() if d.get("importRegion") == r}})
    hidden = sum(1 for f in plan["stale"].values() if "removedAt" in f)
    if with_bundles:
        extra = write_bundles(db, coll, events, plan, known, now_ms, max_writes - n_writes, max_reads - reads)
        reads += extra["reads"]
        n_writes += extra["writes"]
    stats = {"reads": reads, "written": len(plan["write"]), "unchanged": plan["unchanged"],
             "kept_manual": plan["kept_manual"], "stale": len(plan["stale"]), "hidden": hidden,
             "writes": n_writes, "deleted": 0, "compare": compare}
    log.info("Confronto da %s · letture %d · scritti %d · invariati %d · lasciati al manuale %d · spariti dalla fonte %d "
             "(%d nascosti con removedAt)", compare, reads, stats["written"], stats["unchanged"], stats["kept_manual"],
             stats["stale"], hidden)
    return stats


def write_bundles(db, coll, events: list[dict], plan: dict, known: dict[str, dict], now_ms: int, max_writes: int,
                  max_reads: int) -> dict:
    """Bundle delle liste (bundles.py): gli eventi di questo giro più quelli manuali e degli utenti, che l'import non vede."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    query = coll.where(filter=FieldFilter("source", "in", ["manual", "user"]))
    manual = {}
    if query.count().get()[0][0].value < max_reads:  # i manuali sono pochi; se non lo fossero, niente lettura
        manual = {d.id: (d.to_dict() or {}) | {"id": d.id} for d in query.stream()}
    reads = len(manual) + 1
    upserts = [ev for ev in events if ev["id"] not in manual] + [m for m in manual.values() if not m.get("removedAt")]
    removed = [{"id": i} | known.get(i, {}) for i, f in plan["stale"].items() if "removedAt" in f]
    out = bundles.write_events(db, upserts, removed, now_ms, max_writes)
    return {"reads": reads + out["reads"], "writes": out["writes"]}


def coverage_doc(region: str, sources: list, events: list[dict], centers: dict[tuple[str, str], tuple[float, float]],
                 now_ms: int, previous: dict | None = None, failed: frozenset[str] | set[str] = frozenset(),
                 regional_failed: bool = False) -> dict:
    """Documento coverage/{regione}: le città con eventi di oggi (qualunque fonte) più i comuni delle fonti attive.

    Lo legge la webapp per la ricerca dei luoghi, la scelta regione → comune e le pagine /regione/[slug]. Un comune di
    una fonte attiva ha il centro geocodificato (resta fuori senza); una città nata solo dagli eventi (fonte
    regionale, Open Data Hub, futuri aggregatori) ha il centro medio dei suoi eventi e, se bilingue, l'alias.

    Una fonte che oggi non ha risposto (`failed`: slug dei suoi comuni) non azzera il comune: restano i dati del documento di
    ieri (`previous`), perché i suoi eventi in Firestore ci sono ancora. Se a mancare è la fonte regionale (`regional_failed`)
    restano anche le città di ieri che oggi non compaiono.
    """
    old = {c["slug"]: c for c in (previous or {}).get("comuni", [])}
    mine = [ev for ev in events if ev["importRegion"] == slugify(region)]
    counts = Counter(ev["citySlug"] for ev in mine)
    comuni: dict[str, dict] = {}
    for s in sources:
        slug = slugify(s.city)
        if (region, slug) in centers:
            lat, lng = centers[(region, slug)]
            alt = ALT.get((s.province, slug))
            comuni[slug] = {"name": s.city, "slug": slug, "province": s.province, "lat": round(lat, 4),
                            "lng": round(lng, 4), "events": counts.get(slug, 0), **({"alt": alt[1]} if alt else {})}
            if slug in failed and slug in old:
                comuni[slug] = old[slug] | {"events": max(old[slug].get("events", 0), counts.get(slug, 0))}
        elif slug in failed and slug in old:  # niente centro oggi (geocoding): quello di ieri
            comuni[slug] = old[slug]
    by_city: dict[str, list[dict]] = {}
    for ev in mine:
        if ev["citySlug"] not in comuni:
            by_city.setdefault(ev["citySlug"], []).append(ev)
    for slug, evs in by_city.items():
        points = [e for e in evs if not e.get("approxLocation")] or evs  # i punti approssimati contano solo se non ce ne sono altri
        first = evs[0]
        comuni[slug] = {"name": first["city"], "slug": slug, "province": first["province"],
                        "lat": round(sum(e["lat"] for e in points) / len(points), 4),
                        "lng": round(sum(e["lng"] for e in points) / len(points), 4), "events": len(evs),
                        **({"alt": first["cityAlt"]} if first.get("cityAlt") else {})}
    if regional_failed:
        comuni |= {slug: c for slug, c in old.items() if slug not in comuni}
    return {"name": region, "updatedAt": now_ms, "comuni": sorted(comuni.values(), key=lambda c: c["name"])}


def previous_coverage(db, regions: set[str]) -> dict[str, dict]:
    """coverage/{regione} di ieri (una lettura per regione): serve a non azzerare i comuni le cui fonti oggi non rispondono."""
    refs = [db.collection("coverage").document(r) for r in sorted(regions)]
    return {d.id: d.to_dict() or {} for d in db.get_all(refs) if d.exists} if refs else {}


def find_centers(names: list[str], geocoder: Geocoder) -> dict[tuple[str, str], tuple[float, float]]:
    """Centro di ogni comune coperto, (regione, slug) → (lat, lng): dalla cache del geocoder, 1 richiesta la prima volta."""
    centers = {}
    for n in names:
        s = SOURCES[n]
        if getattr(s, "regional", False):
            continue  # fonte regionale: non è un comune
        try:
            hit = geocoder.lookup(f"{s.city}, {PROVINCES.get(s.province, (s.province,))[0]}", s.viewbox, essential=True)
        except httpx.HTTPError as e:
            log.warning("  centro di %s non trovato (%s)", s.city, e)
            hit = None
        if hit:
            centers[(s.region, slugify(s.city))] = hit
    return centers


def write_coverage(db, events: list[dict], names: list[str], centers: dict, now_ms: int,
                   failed: set[str] | frozenset[str] = frozenset(), previous: dict[str, dict] | None = None) -> int:
    """Una scrittura al giorno per regione (coverage/{slug}). `failed`: fonti che oggi non hanno risposto (vedi coverage_doc)."""
    by_region: dict[str, list] = {}
    docs: dict[str, dict] = {}
    for n in names:  # anche le regioni con sole fonti regionali: le loro città vengono dagli eventi
        by_region.setdefault(SOURCES[n].region, [])
        if not getattr(SOURCES[n], "regional", False):
            by_region[SOURCES[n].region].append(SOURCES[n])
    for region, sources in by_region.items():
        bad = [SOURCES[n] for n in failed if SOURCES[n].region == region]
        docs[slugify(region)] = coverage_doc(
            region, sources, events, centers, now_ms, (previous or {}).get(slugify(region)),
            {slugify(a.city) for a in bad if not getattr(a, "regional", False)}, any(getattr(a, "regional", False) for a in bad))
        db.collection("coverage").document(slugify(region)).set(docs[slugify(region)])
    return len(by_region) + bundles.write_coverage(db, docs, now_ms)["writes"]


def month_bounds(now: datetime) -> tuple[str, int, int]:
    """Mese di Roma di `now`: ("2026-11", inizio, fine esclusa) in millisecondi."""
    start = now.astimezone(ROME).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = (start + timedelta(days=32)).replace(day=1)
    return f"{start:%Y-%m}", int(start.timestamp() * 1000), int(end.timestamp() * 1000)


TOP_CITIES = 10


def month_stats_doc(region: str, name: str, month: str, month_events: list[dict], before: dict, now_ms: int) -> dict:
    """Documento stats/{regione}_{AAAA-MM}: eventi attivi nel mese, comuni con eventi e città principali.

    L'import vede solo gli eventi in corso o futuri: gli id già contati nei giorni scorsi (campo `ids`, per comune)
    si uniscono a quelli di oggi, così un evento finito a metà mese resta nel totale.
    """
    ids: dict[str, list[str]] = {k: list(v) for k, v in (before.get("ids") or {}).items()}
    names: dict[str, str] = dict(before.get("names") or {})
    for ev in month_events:
        slug = ev["citySlug"]
        names[slug] = ev["city"]
        if ev["id"] not in ids.setdefault(slug, []):
            ids[slug].append(ev["id"])
    top = sorted(ids, key=lambda k: (-len(ids[k]), k))[:TOP_CITIES]
    return {"region": region, "name": name, "month": month, "events": sum(len(v) for v in ids.values()),
            "comuni": len(ids), "cities": [{"slug": k, "name": names.get(k, k), "n": len(ids[k])} for k in top],
            "names": names, "ids": ids, "updatedAt": now_ms}


def write_month_stats(db, events: list[dict], regions: dict[str, str], now: datetime) -> tuple[int, int]:
    """Una lettura e una scrittura al giorno per regione. Restituisce (letture, scritture)."""
    month, start, end = month_bounds(now)
    refs = {r: db.collection("stats").document(f"{r}_{month}") for r in sorted(regions)}  # slug → nome
    before = {d.reference.path: d.to_dict() or {} for d in db.get_all(list(refs.values()))}
    batch = db.batch()
    for r, ref in refs.items():
        mine = [e for e in events if e["importRegion"] == r and e["startTime"] < end and e["endTime"] >= start]
        batch.set(ref, month_stats_doc(r, regions[r], month, mine, before.get(ref.path, {}), int(now.timestamp() * 1000)))
    batch.commit()
    return len(refs), len(refs)


def excluded_report(excluded: list[dict], sample: int = 20) -> str:
    """Per regione: quanti avvisi il filtro ha lasciato fuori e per quale motivo; poi i titoli di esempio."""
    lines = ["Esclusi dal filtro anti-avvisi:"]
    for region in sorted({x["region"] for x in excluded}):
        mine = [x for x in excluded if x["region"] == region]
        by_reason = ", ".join(f"{r} {n}" for r, n in Counter(x["reason"] for x in mine).most_common())
        lines.append(f"  {region}: {len(mine)} ({by_reason})")
    if not excluded:
        lines.append("  nessuno")
    step = max(1, len(excluded) // sample)  # esempi sparsi su tutte le regioni, non solo i primi
    lines += [f"  - [{x['region']}/{x['source']}] {x['title']} ({x['reason']})" for x in excluded[::step][:sample]]
    return "\n".join(lines)


def skipped_sources(collected: dict[str, dict], previous: dict[str, dict]) -> list[dict]:
    """Fonti che non hanno risposto nemmeno al secondo tentativo, con gli eventi che il comune aveva ieri (copertura):
    li legge ci_report.py per avvisare. Per una fonte regionale vale il totale degli eventi della regione."""
    out = []
    for name, st in sorted(collected.items()):
        if not st["error"]:
            continue
        a, region = SOURCES[name], slugify(SOURCES[name].region)
        comuni = previous.get(region, {}).get("comuni", [])
        if getattr(a, "regional", False):
            before = sum(c.get("events", 0) for c in comuni)
        else:
            before = next((c.get("events", 0) for c in comuni if c["slug"] == slugify(a.city)), 0)
        out.append({"source": name, "city": a.city, "region": region, "error": str(st["error"])[:160], "before": before})
    return out


def summary(stats: dict[str, dict], sources: dict) -> str:
    """Tabella eventi per comune, errori e comuni a zero; va anche nel riepilogo del job GitHub."""
    lines = ["| comune | eventi | senza coordinate | errore |", "|---|---|---|---|"]
    for name, st in sorted(stats.items()):
        retried = " (anche al secondo tentativo)" if st.get("retry") == "fallito" else ""
        done = "riuscita al secondo tentativo" if st.get("retry") == "ok" else ""
        lines.append(f"| {sources[name].city} | {st['events']} | {st['skipped']} | {(st['error'] or '') + retried}{done} |")
    zero = [sources[n].city for n, st in sorted(stats.items()) if st["events"] == 0]
    errors = [sources[n].city for n, st in sorted(stats.items()) if st["error"]]
    slow = sorted(((st.get("seconds", 0), n) for n, st in stats.items()), reverse=True)[:10]
    if slow and slow[0][0]:
        lines += ["", "Fonti più lente:", "| comune | secondi | richieste | esito |", "|---|---|---|---|"]
        lines += [f"| {sources[n].city} | {sec:.0f} | {stats[n].get('requests', 0)} | {'errore' if stats[n]['error'] else 'ok'} |"
                  for sec, n in slow]
    lines += ["", f"Totale: {sum(st['events'] for st in stats.values())} eventi da {len(stats)} comuni",
              f"Comuni a zero ({len(zero)}): {', '.join(zero) or '-'}",
              f"Comuni con errori ({len(errors)}): {', '.join(errors) or '-'}"]
    text = "\n".join(lines)
    print(text)  # il riepilogo unico del workflow lo scrive ci_report.py
    return text


def persist_state(state_file: Path, state: dict | None, health_file: Path, health: dict | None, dry_run: bool) -> bool:
    """Salva lo stato degli host (con le subnet giù) e la salute delle fonti. Nel dry-run no: non deve spostare in avanti
    né parcheggi né cluster né lastOkAt (ticket #16; nel workflow la cache del dry-run è comunque solo in lettura)."""
    if dry_run:
        return False
    if state is not None:
        unreachable.save(state_file, state)
    if health is not None:
        sourcehealth.save(health_file, health)
    return True


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    finally:
        httpfetch.DEFAULT_GATE = None  # lo stato globale non esce dall'import (i test chiamano main più volte)


def _main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="stampa gli eventi senza scrivere")
    p.add_argument("--source", action="append", choices=sorted(SOURCES), help="fonte (ripetibile)")
    p.add_argument("--solo-ticketmaster", action="store_true",
                   help="solo le fonti Ticketmaster (tutte le regioni, o quelle di --regione), senza i comuni; vale come --source")
    p.add_argument("--dump", type=Path, help="con --dry-run: scrive gli eventi in questo file JSON (per i controlli)")
    p.add_argument("--regione", action="append", help="regione del registro (ripetibile), per esempio lombardia")
    p.add_argument("--max-writes", type=int, default=MAX_WRITES, help="si ferma prima di scrivere oltre N documenti")
    p.add_argument("--max-reads", type=int, default=MAX_READS, help="si ferma prima di leggere oltre N documenti")
    p.add_argument("--reconcile", action="store_true",
                   help="ignora il manifest locale e rilegge da Firestore (riconciliazione completa)")
    p.add_argument("--stats-out", type=Path, help="scrive qui le statistiche dell'import (JSON)")
    p.add_argument("--max-geocode", type=int, default=MAX_GEOCODE,
                   help="richieste nuove a Nominatim per giro (le altre, dagli eventi più lontani, nei giorni dopo)")
    p.add_argument("--horizon-days", type=int, default=60, help="importa eventi che iniziano entro N giorni")
    p.add_argument("--source-budget", type=float, default=SOURCE_BUDGET,
                   help="secondi concessi a ogni fonte dei Comuni (0 = nessun tetto); oltre, la fonte è saltata")
    p.add_argument("--retry-wait", type=float, default=300,
                   help="secondi prima di riprovare, a fine giro, le fonti non raggiungibili (0 = subito, -1 = non riprovare)")
    p.add_argument("--ip-interval", type=float, default=IP_INTERVAL,
                   help="secondi minimi tra due richieste allo stesso IP, qualunque sia l'host (0 = nessun limite per IP)")
    p.add_argument("--subnet-concurrency", type=int, default=SUBNET_CONCURRENCY,
                   help="richieste in volo al massimo nella stessa subnet /24")
    args = p.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    gate = NetGate(ip_interval=args.ip_interval, subnet_concurrency=args.subnet_concurrency)
    httpfetch.DEFAULT_GATE = gate  # lo usano tutti i Fetcher creati dagli adapter
    logsafe.setup()

    now = datetime.now(timezone.utc)
    if args.solo_ticketmaster:  # come --source: niente coverage né statistiche mensili, che sarebbero parziali
        args.source = [n for n, a in SOURCES.items() if n.startswith("ticketmaster-")
                       and (not args.regione or slugify(a.region) in args.regione)]
        if not args.source:
            log.error("Nessuna fonte Ticketmaster: imposta TICKETMASTER_API_KEY")
            return 1
    names = args.source or [n for n, a in SOURCES.items() if not args.regione or slugify(a.region) in args.regione]
    if not names:
        log.error("Nessuna fonte attiva per questa selezione")
        return 1
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(30, connect=CONNECT_TIMEOUT), follow_redirects=True) as client:
        geocoder = Geocoder(client, HERE / "geocache.json", args.max_geocode,
                            float(os.environ.get("NOMINATIM_INTERVAL", "1")))
        stats: dict[str, dict] = {}
        excluded: list[dict] = []
        state_file = HERE / "unreachable.json"
        state = None if args.source else unreachable.load(state_file)  # con --source (prove a mano) nessun salto né scrittura
        health_file = HERE / "health.json"
        health = None if args.source else sourcehealth.load(health_file)
        try:
            events = collect(client, geocoder, names, now, args.horizon_days, stats, excluded,
                             None if args.retry_wait < 0 else args.retry_wait, state, args.source_budget or None, health)
            centers = {} if args.dry_run or args.source else find_centers(names, geocoder)
        finally:
            geocoder.save()
            persist_state(state_file, state, health_file, health, args.dry_run)
    summary(stats, SOURCES)
    print(excluded_report(excluded))
    log.info("Totale dopo deduplica: %d (richieste Nominatim: %d)", len(events), geocoder.requests)
    net = gate.stats()
    busiest = ", ".join(f"{ip} {v['requests']} ric., picco {v['peak60']}/min" for ip, v in list(net["top_ips"].items())[:3])
    log.info("Rete: %d IP, %.0f s di attesa per i limiti (%d pause di subnet); più colpiti: %s",
             net["ips"], net["throttle_s"], net["cooldowns"], busiest or "-")
    if geocoder.deferred:
        log.warning("Geocoding: %d richieste rimandate oltre il budget di %d, servono circa %d giorni "
                    "(gli eventi più vicini nel tempo hanno la precedenza)", len(geocoder.deferred), args.max_geocode,
                    -(-len(geocoder.deferred) // max(1, args.max_geocode)))
    if not events:
        log.error("Nessun evento raccolto: controlla le fonti")
        return 1

    if args.dry_run:
        if args.dump:
            args.dump.write_text(json.dumps(events, ensure_ascii=False, indent=1), encoding="utf-8")
        for ev in sorted(events, key=lambda e: e["startTime"]):
            start = datetime.fromtimestamp(ev["startTime"] / 1000, ROME)
            print(f"{start:%d/%m %H:%M}  {ev['category']:<8} {ev['priceType']:<7} "
                  f"{ev['title'][:55]:<55}  {ev['city'][:18]:<18} {ev['province']:<2} {ev['geohash']}")
        return 0
    ok_hosts = {urlsplit(SOURCES[n].base).netloc for n, st in stats.items() if st["error"] is None}
    collected = stats  # `write` restituisce le sue statistiche con lo stesso nome
    try:
        stats = write(events, now, ok_hosts, args.horizon_days, {slugify(SOURCES[n].region) for n in names},
                      max_writes=args.max_writes, max_reads=args.max_reads, excluded={x["id"] for x in excluded},
                      manifest_dir=HERE / "manifests", reconcile=args.reconcile, with_bundles=True)
    except QuotaExceeded as e:
        log.error("%s", e)
        return 2
    from db import client as firestore_client

    db = firestore_client()
    failed = {n for n, st in collected.items() if st["error"]}
    previous = previous_coverage(db, {slugify(SOURCES[n].region) for n in failed})
    stats["reads"] += len({slugify(SOURCES[n].region) for n in failed})
    if not args.source:  # con --source il conteggio per comune sarebbe parziale
        stats["writes"] += write_coverage(db, events, names, centers, int(now.timestamp() * 1000), failed, previous)
        reads, writes = write_month_stats(db, events, {slugify(SOURCES[n].region): SOURCES[n].region for n in names
                                                       if not getattr(SOURCES[n], "regional", False)}, now)
        stats["reads"] += reads
        stats["writes"] += writes
    if args.stats_out:
        args.stats_out.write_text(json.dumps(stats | {
            "region": "+".join(sorted({slugify(SOURCES[n].region) for n in names})), "events": len(events), "excluded": len(excluded),
            "sources": len(names), "geocode": geocoder.requests, "deferred": len(geocoder.deferred),
            "skipped_sources": skipped_sources(collected, previous), "net": net,
            "retried_ok": sorted(SOURCES[n].city for n, st in collected.items() if st.get("retry") == "ok")}), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
