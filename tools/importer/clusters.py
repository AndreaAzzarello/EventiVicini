"""Cluster di rete: più siti dei Comuni sullo stesso hosting che smettono di rispondere insieme.

Il 7/11/2026 tutte le 91 fonti su 93.56.55.0/24 sono andate in timeout dal runner (il giorno prima rispondevano) e la scala
per host (1/3/7 giorni, unreachable.py) le ha tenute ferme per giorni anche quando il fornitore sarebbe tornato raggiungibile.

Qui si decide a livello di subnet: per ogni subnet con almeno MIN_SOURCES fonti nel giro si provano CANARIES sentinelle su host
diversi; se nessuna si connette il resto della subnet non si tenta, senza far avanzare la scala dei singoli host; alla prima
sentinella che risponde la subnet è di nuovo in gioco e i parcheggi dei suoi host si azzerano. Lo stato sta in unreachable.json,
sotto la chiave `net:<subnet>` (le chiavi degli host non contengono mai i due punti iniziali "net:")."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date

import unreachable

MIN_SOURCES = 5  # fonti nella stessa subnet, nel giro, perché valga la logica di cluster
CANARIES = 2  # sentinelle su host diversi: devono fallire tutte per dichiarare la subnet giù
PREFIX = "net:"


def key(subnet: str) -> str:
    return PREFIX + subnet


def groups(names: list[str], subnet_of: Callable[[str], str | None], min_sources: int = MIN_SOURCES) -> dict[str, list[str]]:
    """Subnet → fonti, solo per le subnet con almeno `min_sources` fonti. Gli host che non si risolvono (`host:<nome>`) non fanno cluster."""
    out: dict[str, list[str]] = {}
    for n in names:
        sub = subnet_of(n)
        if sub and not sub.startswith("host:"):
            out.setdefault(sub, []).append(n)
    return {s: g for s, g in out.items() if len(g) >= min_sources}


def pick_canaries(group: list[str], host_of: Callable[[str], str | None], state: dict[str, dict], n: int = CANARIES,
                  last_ok: Callable[[str], str] | None = None) -> list[str]:
    """Sentinelle su host diversi, preferendo quelli senza fallimenti ricordati e, tra questi, l'ultimo successo più recente
    (un host morto di suo non deve far dichiarare giù la subnet)."""
    ranked = sorted(group, key=lambda s: last_ok(s) if last_ok else "", reverse=True)  # stabile: a parità resta l'ordine del gruppo
    ranked = sorted(ranked, key=lambda s: host_of(s) in state)
    out: list[str] = []
    seen: set[str | None] = set()
    for s in ranked:
        h = host_of(s)
        if h not in seen:
            seen.add(h)
            out.append(s)
        if len(out) == n:
            break
    return out


def is_down(kinds: list[str]) -> bool:
    """Giù solo se tutte le sentinelle hanno fallito la connessione (un 403 o un errore di lettura vuol dire che l'host risponde)."""
    return bool(kinds) and all(k == "connect" for k in kinds)


def mark_down(state: dict[str, dict], subnet: str, today: date, reason: str, sources: int) -> str:
    """Registra la subnet come giù; restituisce da quando (ISO)."""
    since = state.get(key(subnet), {}).get("since", today.isoformat())
    state[key(subnet)] = {"since": since, "last": today.isoformat(), "reason": reason[:120], "sources": sources}
    return since


def mark_up(state: dict[str, dict], subnet: str) -> str | None:
    """La subnet risponde: toglie la voce e restituisce da quando era giù (None se non lo era)."""
    entry = state.pop(key(subnet), None)
    return entry["since"] if entry else None


def parked_hosts(group: list[str], host_of: Callable[[str], str | None], state: dict[str, dict]) -> list[str]:
    """Host del gruppo con una scala di attesa in corso."""
    return sorted({h for s in group if (h := host_of(s)) and h in state})


def should_release(recovered_from: str | None, parked: list[str]) -> bool:
    """Alla ripresa si azzerano i parcheggi se la subnet era dichiarata giù, oppure (stato di prima di questa logica) se almeno
    MIN_SOURCES host del gruppo erano fermi: pochi host morti in una subnet sana tengono la loro scala."""
    return recovered_from is not None or len(parked) >= MIN_SOURCES


def release(state: dict[str, dict], hosts: list[str]) -> None:
    for h in hosts:
        unreachable.ok(state, h)
