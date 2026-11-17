"""Scarica dal Mac mini (IP di casa) gli eventi grezzi delle fonti che il runner GitHub non raggiunge (#54).

Legge l'elenco in sources/mac-mini.txt e, per ogni fonte, scrive <out>/<fonte>.json con gli eventi così come li
restituisce l'adapter (nessun geocoding, nessuna deduplica, nessun accesso a Firestore: il Mac non ha segreti).
Un file per fonte, con l'ora del download: chi lo rilegge decide per ogni fonte se è abbastanza fresco.

    python scarica.py --list sources/mac-mini.txt --out fonti-mac [--state ~/.cache/scarica-fonti]

Con --state il Mac ricorda l'ultimo download riuscito di ogni fonte e ricontrolla (404/410/redirect = sparita) le pagine
degli eventi che oggi non sono più in lista: l'esito per URL va in <out>/_liveness.json e l'importer lo usa al posto della
richiesta dal runner GitHub, che quelle pagine non le raggiunge (#70). Gli spariti restano «pendenti» in <state>/_pending.json
(fino a 2 verdetti `gone`, alla fine dell'evento o dopo 14 giorni), così il secondo giro della pulizia trova il verdetto anche
il giorno dopo. Senza stato o senza esito vale «nel dubbio visibile»: GitHub non rifà mai il controllo per queste fonti.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx

import fetch as httpfetch
import logsafe
import run
from liveness import LiveChecker
from meter import BudgetExceeded
from netcluster import NetGate

log = logging.getLogger("importer")
HERE = Path(__file__).parent
VERSION = 1
LIST_FILE = HERE / "sources" / "mac-mini.txt"
# Secondi per fonte: dal Mac le fonti sane impiegano 5-45 s (misure del 12/11); oltre 3 minuti la fonte è bloccata, si segna in errore e si passa alla prossima.
SOURCE_BUDGET = 180
LIVENESS_FILE = "_liveness.json"
PENDING_FILE = "_pending.json"  # nello stato del Mac: eventi spariti da ricontrollare nei giorni dopo (non va nell'artifact)
PENDING_MAX_DAYS = 14
MAX_GONE_CHECKS = 150  # richieste di controllo per run: oltre, gli altri URL restano «nel dubbio visibili»


def read_list(path: Path = LIST_FILE) -> list[str]:
    """Nomi delle fonti, uno per riga; righe vuote e commenti (#) ignorati; ripetizioni tolte."""
    names: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        name = line.split("#", 1)[0].strip()
        if name and name not in names:
            names.append(name)
    return names


def download(names: list[str], out: Path, client: httpx.Client, now: datetime, horizon_days: int,
             budget: float | None = None) -> dict[str, dict]:
    """Scrive un file per fonte e restituisce {nome: {"events": n, "error": str|None}}. Un nome sconosciuto o regionale
    è un errore dell'elenco, non della rete: non si scarica e si segnala."""
    out.mkdir(parents=True, exist_ok=True)
    run.METER.attach(client)
    result: dict[str, dict] = {}
    for name in names:
        source = run.SOURCES.get(name)
        if source is None or getattr(source, "regional", False):
            result[name] = {"events": 0, "error": "fonte sconosciuta o regionale: non va nell'elenco del Mac"}
            log.error("%s: %s", name, result[name]["error"])
            continue
        run.METER.start(budget)
        events: list[dict] = []
        error = None
        try:
            events = list(source.events(client, now, horizon_days))
        except BudgetExceeded as e:
            error = f"saltata: {e}"
        except httpx.HTTPError as e:
            error = logsafe.redact(str(e)) or type(e).__name__
        except Exception as e:  # un bug o una pagina anomala in una fonte non ferma le altre
            log.exception("%s: errore imprevisto", name)
            error = logsafe.redact(f"{type(e).__name__}: {e}")
        seconds, requests = run.METER.stop()
        log.info("%s: %.1f s, %d richieste, %s", name, seconds, requests,
                 f"errore ({error[:120]})" if error else f"ok, {len(events)} eventi grezzi")
        doc = {"version": VERSION, "source": name, "host": urlsplit(source.base).netloc,
               "fetchedAt": now.isoformat(), "horizonDays": horizon_days, "ok": error is None,
               "error": error, "events": [] if error else events}
        tmp = out / f"{name}.json.tmp"
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(out / f"{name}.json")
        result[name] = {"events": len(doc["events"]), "error": error}
    return result


def _read_ok(path: Path) -> dict | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and doc.get("ok") else None


def _load_pending(state: Path) -> dict[str, dict]:
    """url → {source, endTime, since, gone}: eventi spariti da una lista e non ancora chiusi; {} se il file manca o è guasto."""
    try:
        doc = json.loads((state / PENDING_FILE).read_text(encoding="utf-8"))
        items = doc["items"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    if not isinstance(items, dict):
        return {}
    num = (int, float)
    return {u: {"source": e["source"], "endTime": int(e["endTime"]), "since": int(e["since"]), "gone": int(e["gone"])}
            for u, e in items.items() if isinstance(u, str) and isinstance(e, dict) and isinstance(e.get("source"), str)
            and all(isinstance(e.get(k), num) and not isinstance(e.get(k), bool) for k in ("endTime", "since", "gone"))}


def _save_pending(state: Path, items: dict[str, dict]) -> None:
    state.mkdir(parents=True, exist_ok=True)
    tmp = state / (PENDING_FILE + ".tmp")
    tmp.write_text(json.dumps({"version": VERSION, "items": items}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(state / PENDING_FILE)


def collect_candidates(state: Path, out: Path, names: list[str], now_ms: int,
                       pending: dict[str, dict] | None = None) -> tuple[list[tuple[str, str, int]], set[str]]:
    """([(url, fonte, fine evento)] dal più vicino, URL di oggi). Candidati: eventi non ancora finiti del download precedente che
    la stessa fonte, riuscita anche oggi, non elenca più, più i «pendenti» dei giorni scorsi (stato `_pending.json`) che non sono
    ricomparsi: così un evento sparito ieri si ricontrolla anche oggi e domani (2° verdetto), non solo il giorno dopo la sparizione.
    Una fonte fallita oggi o ieri non ha candidati (non si sa cosa sia sparito)."""
    found: dict[str, tuple[str, int]] = {}
    today_urls: set[str] = set()
    ok_today: set[str] = set()
    for name in names:
        today = _read_ok(out / f"{name}.json")
        if today is None:
            continue
        ok_today.add(name)
        now_urls = {e["sourceUrl"] for e in today["events"] if e.get("sourceUrl")}
        today_urls |= now_urls
        before = _read_ok(state / f"{name}.json")
        for e in (before or {}).get("events", []):
            url = e.get("sourceUrl")
            when = int(e.get("endTime") or e.get("startTime") or now_ms)
            if url and url not in now_urls and when >= now_ms and url not in found:
                found[url] = (name, when)
    for url, e in (pending or {}).items():
        if url not in found and url not in today_urls and e["source"] in ok_today and e["endTime"] >= now_ms:
            found[url] = (e["source"], e["endTime"])
    return [(u, n, w) for u, (n, w) in sorted(found.items(), key=lambda kv: (kv[1][1], kv[0]))], today_urls


def gone_candidates(state: Path, out: Path, names: list[str], now_ms: int,
                    pending: dict[str, dict] | None = None) -> tuple[list[str], set[str]]:
    """(URL da ricontrollare, URL di oggi): vedi collect_candidates."""
    cands, today_urls = collect_candidates(state, out, names, now_ms, pending)
    return [u for u, _, _ in cands], today_urls


def next_pending(old: dict[str, dict], checked: list[tuple[str, str, int]], verdicts: dict[str, str], names: list[str],
                 today_urls: set[str], now_ms: int) -> dict[str, dict]:
    """Nuovo elenco dei pendenti. Esce chi è ricomparso, finito, risultato `gone` per la 2ª volta o pendente da oltre
    PENDING_MAX_DAYS giorni; un dubbio (nessun esito) non azzera né conta. I pendenti di una fonte oggi fallita restano."""
    items: dict[str, dict] = {}
    for url, e in old.items():
        if url not in today_urls and e["endTime"] >= now_ms and e["source"] in names:
            items[url] = dict(e)
    for url, name, when in checked:
        e = items.get(url) or {"source": name, "endTime": when, "since": now_ms, "gone": 0}
        if verdicts.get(url) == "gone":
            e["gone"] += 1
        items[url] = e
    return {u: e for u, e in items.items() if e["gone"] < 2 and now_ms - e["since"] <= PENDING_MAX_DAYS * 86_400_000}


def check_gone(out: Path, state: Path, names: list[str], client: httpx.Client, now: datetime,
               max_checks: int = MAX_GONE_CHECKS) -> dict[str, str]:
    """Ricontrolla i candidati e scrive <out>/_liveness.json con gli esiti certi (online | gone); gli altri non si scrivono."""
    now_ms = int(now.timestamp() * 1000)
    first_run = not state.exists() or not any(state.glob("*.json"))
    old_pending = _load_pending(state)
    candidates, today_urls = collect_candidates(state, out, names, now_ms, old_pending)
    if first_run:
        log.info("Controllo pagine spariti: nessuno stato precedente, primo giro: niente da ricontrollare oggi")
    checker = LiveChecker(client, today_urls, None, max_checks)
    results: dict[str, str] = {}
    verdicts: dict[str, str] = {}
    per_source: dict[str, dict[str, int]] = {}
    for url, name, _ in candidates:
        v = checker.verdict(url)
        verdicts[url] = v
        if v in ("online", "gone"):
            results[url] = v
        c = per_source.setdefault(name, {"online": 0, "gone": 0, "dubbi": 0})
        c[v if v in ("online", "gone") else "dubbi"] += 1
    doc = {"version": VERSION, "checkedAt": now.isoformat(), "results": results}
    (out / LIVENESS_FILE).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    _save_pending(state, next_pending(old_pending, candidates, verdicts, names, today_urls, now_ms))
    for name, c in sorted(per_source.items()):
        log.info("%s: %d pagine controllate (online %d, gone %d, dubbi %d)", name, sum(c.values()), c["online"], c["gone"], c["dubbi"])
    log.info("Controllo pagine spariti: %d candidati (%d già pendenti), %d esiti (%s); %d dubbi", len(candidates),
             sum(1 for u, _, _ in candidates if u in old_pending), len(results),
             ", ".join(f"{k} {v}" for k, v in checker.stats.items() if v), checker.stats["unknown"])
    if checker.unknown_by_host:
        log.info("Pagine «unknown» per host (motivo, numero): %s", checker.unknown_summary())
    return results


def save_state(out: Path, state: Path, names: list[str]) -> None:
    """Tiene l'ultimo download riuscito di ogni fonte: una fonte fallita oggi non cancella il riferimento di ieri."""
    state.mkdir(parents=True, exist_ok=True)
    for name in names:
        if _read_ok(out / f"{name}.json") is not None:
            shutil.copyfile(out / f"{name}.json", state / f"{name}.json")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--list", type=Path, default=LIST_FILE)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--horizon-days", type=int, default=60)
    p.add_argument("--source-budget", type=float, default=SOURCE_BUDGET)
    p.add_argument("--state", type=Path, help="cartella dove il Mac ricorda l'ultimo download riuscito (controllo delle pagine sparite, #70)")
    args = p.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    httpfetch.DEFAULT_GATE = NetGate(ip_interval=run.IP_INTERVAL, subnet_concurrency=run.SUBNET_CONCURRENCY)
    logsafe.setup()
    names = read_list(args.list)
    if not names:
        log.error("Elenco vuoto: %s", args.list)
        return 1
    now = datetime.now(timezone.utc)
    timeout = httpx.Timeout(30, connect=run.CONNECT_TIMEOUT)
    with httpx.Client(headers={"User-Agent": run.USER_AGENT}, timeout=timeout, follow_redirects=True) as client:
        result = download(names, args.out, client, now, args.horizon_days, args.source_budget or None)
        if args.state:
            try:
                check_gone(args.out, args.state, names, client, now)
                save_state(args.out, args.state, names)
            except Exception:  # il controllo è un di più: non deve far fallire un download riuscito
                log.exception("Controllo delle pagine sparite saltato")
    ok = [n for n, r in result.items() if not r["error"]]
    log.info("Scaricate %d fonti su %d, %d eventi grezzi", len(ok), len(result), sum(r["events"] for r in result.values()))
    # Riuscire per metà non è un errore del job (le altre fonti restano valide); nessuna fonte riuscita sì.
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
