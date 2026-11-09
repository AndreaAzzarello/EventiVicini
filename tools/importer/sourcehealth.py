"""Salute delle fonti tra un import e l'altro: ultimo successo, serie di fallimenti, interruzioni di rete.

File nella cache di GitHub Actions, accanto a unreachable.json (non su Firestore: nessuna lettura o scrittura in più).
Come unreachable.json non si salva nel dry-run (ticket #16): vedi run.persist_state."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

MAX_OUTAGES = 10  # interruzioni di rete ricordate (la più recente in fondo)


def load(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    if not isinstance(data.get("sources"), dict):
        data["sources"] = {}
    if not isinstance(data.get("outages"), list):
        data["outages"] = []
    return data


def save(path: Path, health: dict) -> None:
    path.write_text(json.dumps(health, indent=1, sort_keys=True, ensure_ascii=False), encoding="utf-8")


def update(health: dict, stats: dict[str, dict], today: date) -> None:
    """Aggiorna lastOkAt, lastEventsAt, failStreak e ultimo errore di ogni fonte con l'esito di oggi. Una fonte saltata
    (parcheggiata o in un cluster giù) non ha consegnato dati: conta come giorno senza successo."""
    for name, st in stats.items():
        h = health["sources"].setdefault(name, {})
        if st.get("error") is None:
            h["lastOkAt"], h["failStreak"] = today.isoformat(), 0
            h.pop("lastError", None)
            h.pop("lastKind", None)
            if st.get("events", 0) > 0:
                h["lastEventsAt"] = today.isoformat()
        else:
            h["failStreak"] = h.get("failStreak", 0) + 1
            h["lastError"] = str(st["error"])[:120]
            h["lastKind"] = next((k for k in ("parked", "cluster", "connect", "budget") if st.get(k)), "")


def last_ok(health: dict | None, name: str) -> str:
    """Data ISO dell'ultimo successo della fonte, "" se mai riuscita (o senza registro)."""
    return (health or {}).get("sources", {}).get(name, {}).get("lastOkAt", "")


def record_outage(health: dict, subnet: str, since: str, until: date) -> None:
    """Una subnet è tornata raggiungibile: si ricorda da quando a quando era giù (durata del blocco)."""
    health["outages"].append({"subnet": subnet, "since": since, "until": until.isoformat()})
    del health["outages"][:-MAX_OUTAGES]
