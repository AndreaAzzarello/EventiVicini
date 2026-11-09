"""Da host a IP e subnet: i siti dei Comuni stanno spesso su pochi hosting condivisi (il 9/11/2026 119 host su 93.56.55.0/24),
e un fornitore che non risponde al runner lo fa per tutti i suoi siti insieme. I limiti di frequenza e il rilevamento dei
cluster ragionano quindi per IP e per subnet (/24 per IPv4, /48 per IPv6), non solo per host."""

from __future__ import annotations

import ipaddress
import socket
import threading
import time
from collections import defaultdict
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

Resolver = Callable[[str], str | None]
PREFIX = {4: 24, 6: 48}


def system_resolver(host: str) -> str | None:
    """Primo indirizzo del sistema per l'host; None se il DNS non risponde."""
    try:
        return socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)[0][4][0]
    except (OSError, IndexError):
        return None


def bare_host(netloc: str) -> str:
    """Nome dell'host senza porta né credenziali, in minuscolo."""
    host = netloc.rsplit("@", 1)[-1]
    if host.startswith("["):  # IPv6 letterale: [::1]:8080
        return host[1:].split("]", 1)[0].lower()
    return host.split(":", 1)[0].lower()


def subnet_of(ip: str) -> str:
    """"93.56.55.249" → "93.56.55.0/24"; IPv6 → /48."""
    addr = ipaddress.ip_address(ip)
    return str(ipaddress.ip_network(f"{addr}/{PREFIX[addr.version]}", strict=False))


class Network:
    """Risolve gli host una volta sola. Un host che non si risolve ha come IP e come subnet un nome tutto suo
    ("host:<nome>"): non entra in nessun cluster e non frena gli altri."""

    def __init__(self, resolver: Resolver = system_resolver):
        self._resolver = resolver
        self._ip: dict[str, str] = {}
        self._lock = threading.Lock()

    def ip(self, netloc: str) -> str:
        host = bare_host(netloc)
        with self._lock:
            if host in self._ip:
                return self._ip[host]
        found = self._resolver(host)  # fuori dal lock: il DNS può essere lento
        with self._lock:
            return self._ip.setdefault(host, found or f"host:{host}")

    def subnet(self, netloc: str) -> str:
        ip = self.ip(netloc)
        return ip if ip.startswith("host:") else subnet_of(ip)

    def prefetch(self, netlocs: Iterable[str], workers: int = 16) -> None:
        """Risolve in parallelo gli host che servono al giro (qualche centinaio di richieste DNS)."""
        todo = sorted({bare_host(n) for n in netlocs} - set(self._ip))
        if todo:
            with ThreadPoolExecutor(min(workers, len(todo))) as pool:
                list(pool.map(self.ip, todo))


class NetGate:
    """Limiti condivisi da tutti i Fetcher del processo (ogni adapter ne crea uno suo, quindi lo stato sta qui):

    - intervallo minimo tra due richieste allo stesso IP (`ip_interval`), qualunque sia l'host;
    - al massimo `subnet_concurrency` richieste in volo nella stessa subnet;
    - pausa di subnet: dopo `cooldown_after` timeout di connessione consecutivi nella subnet, nessuna richiesta per `cooldown` secondi.

    Misura anche quanto tempo si perde ad aspettare e quante richieste per minuto riceve ogni IP (`stats`)."""

    def __init__(self, net: Network | None = None, ip_interval: float = 1.0, subnet_concurrency: int = 2,
                 cooldown_after: int = 3, cooldown: float = 60.0):
        self.net = net or Network()
        self.ip_interval, self.subnet_concurrency = max(0.0, ip_interval), max(1, subnet_concurrency)
        self.cooldown_after, self.cooldown = cooldown_after, cooldown
        self._lock = threading.Lock()
        self._next_ip: dict[str, float] = {}
        self._sem: dict[str, threading.BoundedSemaphore] = {}
        self._fails: dict[str, int] = {}
        self._until: dict[str, float] = {}
        self._stamps: dict[str, list[float]] = defaultdict(list)
        self.throttle_s = 0.0
        self.cooldowns = 0

    @contextmanager
    def slot(self, netloc: str):
        """Da usare attorno a ogni richiesta HTTP: aspetta il proprio turno e tiene un posto nella subnet finché dura."""
        ip, sub = self.net.ip(netloc), self.net.subnet(netloc)
        with self._lock:
            t0 = time.monotonic()
            at = max(t0, self._next_ip.get(ip, 0.0), self._until.get(sub, 0.0))
            self._next_ip[ip] = at + self.ip_interval
            sem = self._sem.setdefault(sub, threading.BoundedSemaphore(self.subnet_concurrency))
        if at > t0:
            time.sleep(at - t0)
        sem.acquire()
        try:
            with self._lock:
                pause = self._until.get(sub, 0.0) - time.monotonic()  # una pausa scattata mentre si aspettava il posto
            if pause > 0:
                time.sleep(pause)
            with self._lock:
                now = time.monotonic()
                self.throttle_s += now - t0
                self._stamps[ip].append(now)
            yield
        finally:
            sem.release()

    def report(self, netloc: str, ok: bool) -> None:
        """Esito di una richiesta: una risposta HTTP qualsiasi azzera i timeout consecutivi, un timeout di connessione li conta."""
        sub = self.net.subnet(netloc)
        with self._lock:
            if ok:
                self._fails[sub] = 0
                return
            n = self._fails.get(sub, 0) + 1
            if n >= self.cooldown_after:
                self._until[sub] = time.monotonic() + self.cooldown
                self.cooldowns += 1
                n = 0
            self._fails[sub] = n

    def stats(self, top: int = 10) -> dict:
        """Attese e richieste per IP (picco in 60 s), per il riepilogo e per --stats-out."""
        with self._lock:
            ips = {}
            for ip, stamps in self._stamps.items():
                ts, start, peak = sorted(stamps), 0, 0
                for i, t in enumerate(ts):
                    while t - ts[start] >= 60:
                        start += 1
                    peak = max(peak, i - start + 1)
                ips[ip] = {"requests": len(ts), "peak60": peak}
            busiest = sorted(ips.items(), key=lambda kv: (-kv[1]["requests"], kv[0]))[:top]
            return {"throttle_s": round(self.throttle_s, 1), "cooldowns": self.cooldowns, "ip_interval": self.ip_interval,
                    "subnet_concurrency": self.subnet_concurrency, "ips": len(ips), "top_ips": dict(busiest)}


def interleave(items: list[str], key: Callable[[str], str]) -> list[str]:
    """Riordina gli elementi spargendo ogni gruppo (stessa chiave, per esempio la subnet) lungo tutta la lista, in proporzione
    alla sua taglia: un cluster di 90 siti non occupa tutti i worker uno dopo l'altro. Stabile: dentro il gruppo l'ordine resta."""
    groups: dict[str, list[str]] = {}
    for it in items:
        groups.setdefault(key(it), []).append(it)
    ranked = [((i + 0.5) / len(g), n, it) for n, g in enumerate(groups.values()) for i, it in enumerate(g)]
    return [it for _, _, it in sorted(ranked)]
