"""Memoria locale delle pagine di dettaglio già lette (#81): url → fine dell'evento, in .httpcache/_ended.json.

Serve a non rileggere ogni giorno i dettagli di eventi finiti. Manifest e Firestore non bastano: contengono solo gli eventi
emessi (futuri) e le pagine passate non vi sono mai entrate. Sta dentro .httpcache, che la cache di Actions per regione
salva già (nessun percorso nuovo nel workflow). La memoria decide solo cosa saltare: se manca, è corrotta o vecchia si
rilegge di più, mai di meno, quindi la sua perdita non fa perdere eventi.

Formato: {"v": 1, "details": {url: [endMs | null, ultimoGiornoVisto]}, "emptySitemaps": {url: giorno}}; i giorni sono
ordinali (date.toordinal()). endMs null = pagina letta senza data valida (errore HTTP, nessuna data).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

from mapping import ROME

log = logging.getLogger("importer")

NAME = "_ended.json"
VERSION = 1
FINISHED_AFTER_DAYS = 2        # "finito": fine < mezzanotte di (oggi − 2 giorni), fuso Europe/Rome
ROTATION_DAYS = 20             # ogni giorno si rilegge 1/20 (5%) dei dettagli finiti: tutti in 20 giorni
UNSEEN_DAYS = 90               # voci non viste tra i candidati da tanto: URL spariti dal sito
OLD_END_DAYS = 180             # fine più vecchia di tanto (e non vista oggi): si toglie
MAX_ENTRIES = 60_000           # tetto del file; oltre, escono le voci viste meno di recente
EMPTY_SITEMAP_KEEP_DAYS = 30
EMPTY_SITEMAP_SKIP_DAYS = 7    # una sitemap senza URL utili si salta per 7 giorni, si ricontrolla all'8°


def finished_cutoff_ms(today: date) -> int:
    """Mezzanotte (Europe/Rome) di oggi − 2 giorni: gli eventi con fine prima di questo istante sono "finiti"."""
    return int(datetime.combine(today - timedelta(days=FINISHED_AFTER_DAYS), datetime.min.time(), ROME).timestamp() * 1000)


def in_rotation(url: str, today: date) -> bool:
    """True per il ~5% di URL riletto oggi: deterministico per data e URL; in ROTATION_DAYS giorni passano tutti, una volta."""
    return int(hashlib.sha1(url.encode()).hexdigest(), 16) % ROTATION_DAYS == today.toordinal() % ROTATION_DAYS


class DetailMemo:
    def __init__(self, path: Path | None):
        self.path = path
        self._lock = threading.Lock()
        self.details: dict[str, list] = {}
        self.empty_sitemaps: dict[str, int] = {}
        self.counters: dict[str, dict[str, int]] = {}  # per fonte, solo per il log
        self._load()

    def _load(self) -> None:
        """Lettura tollerante: file assente, illeggibile o di un'altra versione = memoria vuota (si legge tutto, come prima)."""
        if self.path is None:
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not (isinstance(data, dict) and data.get("v") == VERSION):
                return
            details = {u: v for u, v in (data.get("details") or {}).items()
                       if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int) and (v[0] is None or isinstance(v[0], int))}
            empty = {u: d for u, d in (data.get("emptySitemaps") or {}).items() if isinstance(d, int)}
        except (OSError, ValueError, AttributeError):
            return
        self.details, self.empty_sitemaps = details, empty

    # -- dettagli
    def known(self, url: str) -> bool:
        with self._lock:
            return url in self.details

    def ended_ms(self, url: str) -> int | None:
        with self._lock:
            v = self.details.get(url)
            return v[0] if v else None

    def record(self, url: str, end_ms: int | None, today: date) -> None:
        with self._lock:
            self.details[url] = [end_ms, today.toordinal()]

    def touch(self, url: str, today: date) -> None:
        with self._lock:
            if url in self.details:
                self.details[url][1] = today.toordinal()

    # -- sitemap
    def sitemap_skipped(self, url: str, today: date) -> bool:
        with self._lock:
            d = self.empty_sitemaps.get(url)
        return d is not None and 0 < today.toordinal() - d <= EMPTY_SITEMAP_SKIP_DAYS

    def mark_sitemap(self, url: str, empty: bool, today: date) -> None:
        with self._lock:
            if empty:
                self.empty_sitemaps[url] = today.toordinal()
            else:
                self.empty_sitemaps.pop(url, None)

    # -- contatori per il log
    def count(self, source: str, **inc: int) -> None:
        with self._lock:
            c = self.counters.setdefault(source, {})
            for k, v in inc.items():
                c[k] = c.get(k, 0) + v

    def set_counter(self, source: str, **vals: int) -> None:
        with self._lock:
            self.counters.setdefault(source, {}).update(vals)

    # -- pulizia e salvataggio
    def prune(self, today: date) -> None:
        """Toglie voci non viste da UNSEEN_DAYS, voci con fine più vecchia di OLD_END_DAYS (se non viste oggi), poi tiene al massimo
        MAX_ENTRIES voci (le viste più di recente). Le sitemap vuote si ricordano per EMPTY_SITEMAP_KEEP_DAYS."""
        now_ord = today.toordinal()
        old_end = int(datetime.combine(today - timedelta(days=OLD_END_DAYS), datetime.min.time(), ROME).timestamp() * 1000)
        with self._lock:
            kept = {u: v for u, v in self.details.items()
                    if now_ord - v[1] <= UNSEEN_DAYS and (v[1] == now_ord or v[0] is None or v[0] >= old_end)}
            if len(kept) > MAX_ENTRIES:
                kept = dict(sorted(kept.items(), key=lambda kv: (-kv[1][1], kv[0]))[:MAX_ENTRIES])
            self.details = kept
            self.empty_sitemaps = {u: d for u, d in self.empty_sitemaps.items() if now_ord - d <= EMPTY_SITEMAP_KEEP_DAYS}

    def save(self, today: date) -> None:
        """Pulisce e scrive in modo atomico (.tmp + os.replace): un run interrotto non lascia un file a metà."""
        if self.path is None:
            return
        self.prune(today)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            with self._lock:
                payload = {"v": VERSION, "details": self.details, "emptySitemaps": self.empty_sitemaps}
            tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError as e:  # la memoria è un'ottimizzazione: un disco pieno non deve fermare l'import
            log.warning("Memoria dei dettagli non salvata: %s", e)

    def summary(self, region_of: dict[str, str]) -> dict[str, dict[str, int]]:
        """Contatori sommati per regione (region_of: fonte → regione)."""
        out: dict[str, dict[str, int]] = {}
        with self._lock:
            for source, c in self.counters.items():
                r = out.setdefault(region_of.get(source, "?"), {})
                for k, v in c.items():
                    r[k] = r.get(k, 0) + v
                r["sources"] = r.get("sources", 0) + 1
                if c.get("tail_left"):
                    r["tail_sources"] = r.get("tail_sources", 0) + 1
        return out


_SHARED: dict[Path, DetailMemo] = {}
_SHARED_LOCK = threading.Lock()


def shared(cache_dir: Path | None) -> DetailMemo | None:
    """La memoria condivisa da tutti gli adapter del processo (una per cartella di cache); None senza cache su disco."""
    if cache_dir is None:
        return None
    path = Path(cache_dir) / NAME
    with _SHARED_LOCK:
        if path not in _SHARED:
            _SHARED[path] = DetailMemo(path)
        return _SHARED[path]


def save_all(today: date) -> None:
    with _SHARED_LOCK:
        memos = list(_SHARED.values())
    for m in memos:
        m.save(today)


def reset() -> None:
    """Dimentica le istanze condivise (i test chiamano main più volte; lo stato non esce dal processo)."""
    with _SHARED_LOCK:
        _SHARED.clear()
