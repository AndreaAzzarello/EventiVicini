"""Host dei Comuni che non rispondono: si ricordano tra un run e l'altro (file nella cache di GitHub Actions, non su Firestore)
e si riprovano dopo 1, 3, 7 giorni (poi ogni 7) invece di ogni giorno."""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

LADDER = (1, 3, 7)  # giorni di attesa dopo il 1°, 2°, 3° e successivi fallimenti consecutivi


def load(path: Path) -> dict[str, dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save(path: Path, state: dict[str, dict]) -> None:
    path.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")


def retry_on(state: dict[str, dict], host: str) -> date | None:
    """Primo giorno in cui riprovare l'host; None se non è tra quelli irraggiungibili."""
    h = state.get(host)
    if not h:
        return None
    return date.fromisoformat(h["last"]) + timedelta(days=LADDER[min(h["fails"], len(LADDER)) - 1])


def due(state: dict[str, dict], host: str, today: date) -> bool:
    on = retry_on(state, host)
    return on is None or today >= on


def fail(state: dict[str, dict], host: str, today: date, reason: str) -> None:
    state[host] = {"fails": state.get(host, {}).get("fails", 0) + 1, "last": today.isoformat(), "reason": reason[:120]}


def ok(state: dict[str, dict], host: str) -> None:
    state.pop(host, None)
