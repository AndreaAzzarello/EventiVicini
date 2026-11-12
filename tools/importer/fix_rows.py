"""Corregge `sito` e `url_eventi` di righe già attive del registro (gli altri script non le toccano: PROTECTED).

Prima di scrivere controlla ogni nuovo indirizzo: https, risposta 200 con il nostro user-agent, robots.txt che lo consente,
dominio coerente tra `sito` e `url_eventi` (stesso host, www a parte). Senza `--apply` stampa soltanto cosa cambierebbe.
Modifica solo le colonne sito, url_eventi e note (con la data e i valori precedenti), via registry.write_rows.

Uso (da tools/importer):
    python fix_rows.py fixes.json             # prova: controlla e stampa
    python fix_rows.py fixes.json --apply     # scrive nei CSV
fixes.json: [{"regione": "Lazio", "comune": "Fondi", "sito": "https://comune.fondi.lt.it", "url_eventi": "https://…"}]
(`sito` e `url_eventi` sono facoltativi: si cambia solo quello che c'è.)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from urllib import robotparser
from urllib.parse import urlsplit

import httpx

from registry import SOURCES_DIR, USER_AGENT, read_rows, write_rows

FIELDS = ("sito", "url_eventi")


def host_key(url: str) -> str:
    """Host in minuscolo senza «www.»: www e non-www sono lo stesso sito."""
    host = urlsplit(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def http_fetch(url: str) -> tuple[int, str]:
    """(stato, URL finale) con il nostro user-agent, seguendo i redirect."""
    res = httpx.get(url, headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=20)
    return res.status_code, str(res.url)


def http_robots(url: str) -> bool:
    """True se il robots.txt dell'host consente l'URL al nostro user-agent (robots assente = consentito)."""
    p = urlsplit(url)
    res = httpx.get(f"{p.scheme}://{p.netloc}/robots.txt", headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=20)
    if res.status_code >= 400:
        return True
    rp = robotparser.RobotFileParser()
    rp.parse(res.text.splitlines())
    return rp.can_fetch(USER_AGENT, url)


def problems(row: dict, fix: dict, fetch=None, robots=None) -> list[str]:
    """Motivi per cui la correzione non si applica; lista vuota = ok. `fetch` e `robots` sostituibili nei test."""
    fetch, robots = fetch or http_fetch, robots or http_robots
    new = {f: fix.get(f, row[f]) for f in FIELDS}
    out: list[str] = []
    if row["stato"] != "attivo":
        out.append(f"la riga non è attiva ({row['stato']}): usa gli script normali")
    if not any(f in fix for f in FIELDS):
        out.append("niente da cambiare")
    for f in FIELDS:
        if f in fix and not new[f].startswith("https://"):
            out.append(f"{f}: serve https")
    if new["sito"] and new["url_eventi"] and host_key(new["sito"]) != host_key(new["url_eventi"]):
        out.append(f"host diversi: {host_key(new['sito'])} / {host_key(new['url_eventi'])}")
    if out:
        return out
    for f in FIELDS:
        if f not in fix:
            continue
        try:
            status, final = fetch(new[f])
            if status != 200:
                out.append(f"{f}: HTTP {status}")
            elif host_key(final) != host_key(new[f]):
                out.append(f"{f}: reindirizza a un altro host ({host_key(final)})")
            if not robots(new[f]):
                out.append(f"{f}: robots.txt lo vieta")
        except httpx.HTTPError as e:
            out.append(f"{f}: errore di rete ({type(e).__name__})")
    return out


def apply_fixes(rows: list[dict], fixes: list[dict], today: str, fetch=None, robots=None) -> list[tuple[dict, dict, list[str]]]:
    """Modifica `rows` sul posto per le correzioni senza problemi. Restituisce (riga, correzione, problemi) per ognuna."""
    report = []
    for fix in fixes:
        found = [r for r in rows if r["regione"] == fix.get("regione") and r["comune"] == fix.get("comune")]
        if len(found) != 1:
            report.append(({"regione": fix.get("regione"), "comune": fix.get("comune")}, fix,
                           [f"{len(found)} righe trovate, ne serve una"]))
            continue
        row = found[0]
        errs = problems(row, fix, fetch, robots)
        if not errs:
            before = ", ".join(f"{f}={row[f] or '-'}" for f in FIELDS if f in fix)
            for f in FIELDS:
                if f in fix:
                    row[f] = fix[f]
            row["note"] = " | ".join(x for x in (row["note"], f"fix_rows {today}: corretti {before}") if x)
        report.append((row, fix, errs))
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("fixes", type=Path, help="file JSON con le correzioni")
    ap.add_argument("--apply", action="store_true", help="scrive nei CSV (senza: solo controllo)")
    ap.add_argument("--sources", type=Path, default=SOURCES_DIR)
    args = ap.parse_args(argv)
    fixes = json.loads(args.fixes.read_text(encoding="utf-8"))
    rows = read_rows(args.sources)
    report = apply_fixes(rows, fixes, date.today().isoformat())
    bad = 0
    for row, fix, errs in report:
        label = f"{row.get('regione')} / {row.get('comune')}"
        changes = ", ".join(f"{f}: {fix[f]}" for f in FIELDS if f in fix)
        print(f"{'NO' if errs else 'OK'}  {label}  {changes}" + (f"  → {'; '.join(errs)}" if errs else ""))
        bad += bool(errs)
    if args.apply and bad < len(report):
        write_rows(rows, args.sources)
        print(f"scritte {len(report) - bad} correzioni in {args.sources}")
    elif not args.apply:
        print("prova: nessun file modificato (usa --apply)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
