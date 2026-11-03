"""Misure per fonte: richieste HTTP e secondi del thread che sta scaricando una fonte (hook di httpx)."""

from __future__ import annotations

import threading
import time

import httpx


class SourceMeter:
    def __init__(self) -> None:
        self._t = threading.local()

    def start(self) -> None:
        self._t.n, self._t.t0 = 0, time.monotonic()

    def stop(self) -> tuple[float, int]:
        """(secondi, richieste) dall'ultimo start; il geocoding gira nel thread principale e non passa di qui."""
        out = (time.monotonic() - self._t.t0, self._t.n)
        del self._t.n
        return out

    def _hook(self, request: httpx.Request) -> None:
        if hasattr(self._t, "n"):
            self._t.n += 1

    def attach(self, client: httpx.Client | None) -> None:
        if client is None:  # alcuni test chiamano collect senza client
            return
        hooks = client.event_hooks["request"]
        if self._hook not in hooks:
            hooks.append(self._hook)
