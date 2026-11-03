"""Siti comunali su design-comuni-plone (io-Comune): API REST pubblica ++api++."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterator

import httpx

from fetch import Fetcher
from mapping import to_event

PAGE_SIZE = 25


@dataclass(frozen=True)
class PloneAdapter:
    name: str
    base: str
    city: str
    province: str
    region: str
    viewbox: str | None = None
    fetcher: Fetcher | None = field(default=None, compare=False)  # solo per i test

    def fetch(self, client: httpx.Client, now: datetime) -> Iterator[dict]:
        """Eventi Plone non ancora finiti, pagina per pagina: robots.txt, 1 richiesta al secondo, retry (fetch.Fetcher)."""
        f = self.fetcher or Fetcher(client, retries=2, backoff=2.0)
        url = f"{self.base}/++api++/@search"
        params = {
            "portal_type": "Event", "end.query": now.strftime("%Y-%m-%d"), "end.range": "min",
            "sort_on": "start", "b_size": PAGE_SIZE, "fullobjects": 1,
        }
        while url:
            res = f.get_api(url, params=params, headers={"Accept": "application/json"})
            if res is None:  # robots.txt vieta le API
                return
            res.raise_for_status()
            data = res.json()
            yield from data.get("items", [])
            url, params = (data.get("batching") or {}).get("next"), None

    def events(self, client: httpx.Client, now: datetime, horizon_days: int) -> Iterator[dict]:
        for item in self.fetch(client, now):
            ev = to_event(item, {"city": self.city}, now, horizon_days)
            if ev is not None:
                yield ev
