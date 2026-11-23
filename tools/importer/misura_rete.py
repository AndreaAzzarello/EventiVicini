"""Misura della rete di un import dai log di GitHub Actions (#81): per regione e per IP le richieste e le attese, per fornitore
le richieste di dettaglio, i dettagli saltati e la coda della sitemap ancora da esplorare. Serve a confrontare prima e dopo.

Uso:  python misura_rete.py 44265652927                       # un run (gh run view --log; serve `gh` autenticato)
      python misura_rete.py log.txt                           # un log già salvato
      python misura_rete.py 44265652927 45000000000           # confronto prima/dopo
      python misura_rete.py --regione piemonte --regione toscana 44265652927

Legge solo i log e il registro delle fonti (sources/*.csv): nessuna richiesta verso i siti.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from geo import slugify
from registry import read_rows

JOB = re.compile(r"^import \(([a-z0-9-]+),")
SOURCE_REQ = re.compile(r"Z (\S+): ([\d,]+) s, (\d+) richieste")
SOURCE_DET = re.compile(r"Z (\S+): (\d+) pagine evento lette, (\d+) futuri")
SOURCE_SKIP = re.compile(r"Z (\S+): dettagli saltati \(finiti\): (\d+), riletti a rotazione: (\d+), coda da esplorare: (\d+)(?:, dettagli dalla cache: (\d+))?")
NET = re.compile(r"Z Rete: (\d+) IP, (\d+) s di attesa per i limiti \((\d+) pause di subnet\); più colpiti: (.*)$")
IP_ENTRY = re.compile(r"(\d+\.\d+\.\d+\.\d+) (\d+) ric\., picco (\d+)/min")
DETAILS_LINE = re.compile(r"Z Dettagli \(([^)]+)\): richieste di dettaglio (\d+), saltati \(finiti\) (\d+), riletti a rotazione (\d+), "
                          r"coda da esplorare (\d+) \(fonti con coda (\d+)\), sitemap vuote saltate (\d+)")


def parse_log(text: str) -> dict[str, dict]:
    """{regione: {"ips": {ip: (richieste, picco)}, "n_ips", "wait_s", "sources": {fonte: {...}}, "details": {...}}}."""
    out: dict[str, dict] = {}
    for line in text.splitlines():
        head, _, rest = line.partition("\t")
        m = JOB.match(head)
        if not m:
            continue
        r = out.setdefault(m[1], {"ips": {}, "n_ips": 0, "wait_s": 0, "sources": {}, "details": {}})
        if m2 := NET.search(rest):
            r["n_ips"], r["wait_s"] = int(m2[1]), int(m2[2])
            r["ips"] = {ip: (int(n), int(p)) for ip, n, p in IP_ENTRY.findall(m2[4])}
        elif m2 := SOURCE_REQ.search(rest):
            s = r["sources"].setdefault(m2[1], {})
            s["seconds"], s["requests"] = float(m2[2].replace(",", ".")), int(m2[3])
        elif m2 := SOURCE_DET.search(rest):
            r["sources"].setdefault(m2[1], {}).update(details=int(m2[2]), future=int(m2[3]))
        elif m2 := SOURCE_SKIP.search(rest):
            r["sources"].setdefault(m2[1], {}).update(skipped=int(m2[2]), rotated=int(m2[3]), tail=int(m2[4]))
            if m2[5]:  # liste ASP.NET (#85): dettagli ricostruiti dal corpo in cache, senza richiesta
                r["sources"][m2[1]]["cached"] = int(m2[5])
        elif m2 := DETAILS_LINE.search(rest):
            r["details"] = {"gets": int(m2[2]), "skipped": int(m2[3]), "rotated": int(m2[4]), "tail": int(m2[5]),
                            "tail_sources": int(m2[6]), "sitemap_skipped": int(m2[7])}
    return out


def vendors() -> dict[tuple[str, str], str]:
    """(regione, fonte) → fornitore dal registro (l'importer chiama la fonte slugify(comune))."""
    return {(slugify(r["regione"]), slugify(r["comune"])): r["fornitore"] or "?" for r in read_rows()}


def by_vendor(region: str, sources: dict[str, dict], vend: dict[tuple[str, str], str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name, s in sources.items():
        v = out.setdefault(vend.get((region, name), "?"), {"sources": 0})
        v["sources"] += 1
        for k in ("requests", "seconds", "details", "future", "skipped", "rotated", "tail", "cached"):
            v[k] = v.get(k, 0) + s.get(k, 0)
    return dict(sorted(out.items(), key=lambda kv: -kv[1].get("requests", 0)))


def gh_run(run_id: str) -> tuple[str, dict[str, float]]:
    """(log, {regione: minuti del job import}) di un run, con `gh`."""
    log = subprocess.run(["gh", "run", "view", run_id, "--log"], capture_output=True, text=True, encoding="utf-8", check=True).stdout
    jobs = json.loads(subprocess.run(["gh", "run", "view", run_id, "--json", "jobs"], capture_output=True, text=True,
                                     encoding="utf-8", check=True).stdout)["jobs"]
    return log, job_minutes(jobs)


def job_minutes(jobs: list[dict]) -> dict[str, float]:
    out = {}
    for j in jobs:
        m = JOB.match(j.get("name", ""))
        if m and j.get("startedAt") and j.get("completedAt"):
            a, b = (datetime.fromisoformat(j[k].replace("Z", "+00:00")) for k in ("startedAt", "completedAt"))
            out[m[1]] = round((b - a).total_seconds() / 60, 1)
    return out


def load(arg: str) -> tuple[dict[str, dict], dict[str, float]]:
    if Path(arg).is_file():
        return parse_log(Path(arg).read_text(encoding="utf-8", errors="replace")), {}
    if arg.isdigit():
        text, minutes = gh_run(arg)
        return parse_log(text), minutes
    raise SystemExit(f"{arg}: né un file né un id di run")


def _num(x: float) -> str:
    return f"{x:.1f}".replace(".", ",") if isinstance(x, float) and x != int(x) else str(int(x))


def render(report: dict[str, dict], minutes: dict[str, float], vend: dict, only: list[str] | None = None) -> str:
    lines = []
    for region, r in sorted(report.items()):
        if only and region not in only:
            continue
        job = f" · job {_num(minutes[region])} min" if region in minutes else ""
        lines.append(f"== {region}{job} · attesa {r['wait_s']} s · {r['n_ips']} IP")
        for ip, (n, peak) in r["ips"].items():
            lines.append(f"   IP {ip}: {n} ric., picco {peak}/min")
        for v, a in by_vendor(region, r["sources"], vend).items():
            lines.append(f"   {v}: {a['sources']} fonti, {a['requests']} ric., {_num(round(a['seconds']))} s, dettagli {a['details']} "
                         f"(futuri {a['future']}), saltati {a['skipped']}, ruotati {a['rotated']}, coda {a['tail']}"
                         + (f", dalla cache {a['cached']}" if a.get("cached") else ""))
        if r["details"]:
            d = r["details"]
            lines.append(f"   Dettagli: {d['gets']} richieste, saltati {d['skipped']}, ruotati {d['rotated']}, coda {d['tail']} "
                         f"(fonti con coda {d['tail_sources']}), sitemap vuote saltate {d['sitemap_skipped']}")
    return "\n".join(lines)


def _delta(a: float, b: float) -> str:
    return f"{_num(a)} → {_num(b)}" + (f" ({(b - a) / a * 100:+.0f}%)" if a else "")


def compare(before: dict, min_before: dict, after: dict, min_after: dict, vend: dict, only: list[str] | None = None) -> str:
    lines = []
    for region in sorted(set(before) & set(after)):
        if only and region not in only:
            continue
        a, b = before[region], after[region]
        lines.append(f"== {region}")
        if region in min_before and region in min_after:
            lines.append(f"   job (min): {_delta(min_before[region], min_after[region])}")
        lines.append(f"   attesa per i limiti (s): {_delta(a['wait_s'], b['wait_s'])}")
        for ip in dict.fromkeys([*a["ips"], *b["ips"]]):
            lines.append(f"   IP {ip}: ric. {_delta(a['ips'].get(ip, (0, 0))[0], b['ips'].get(ip, (0, 0))[0])}")
        va, vb = by_vendor(region, a["sources"], vend), by_vendor(region, b["sources"], vend)
        for v in dict.fromkeys([*va, *vb]):
            lines.append(f"   {v}: ric. {_delta(va.get(v, {}).get('requests', 0), vb.get(v, {}).get('requests', 0))}, "
                         f"dettagli {_delta(va.get(v, {}).get('details', 0), vb.get(v, {}).get('details', 0))}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("fonti", nargs="+", help="id di un run o file di log; due argomenti = confronto prima/dopo")
    p.add_argument("--regione", action="append", help="solo questa regione (slug, ripetibile)")
    args = p.parse_args(argv)
    if len(args.fonti) > 2:
        p.error("al massimo due argomenti (prima e dopo)")
    sys.stdout.reconfigure(encoding="utf-8")
    vend = vendors()
    loaded = [load(a) for a in args.fonti]
    if len(loaded) == 1:
        print(render(loaded[0][0], loaded[0][1], vend, args.regione))
    else:
        print(compare(loaded[0][0], loaded[0][1], loaded[1][0], loaded[1][1], vend, args.regione))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
