"""Da host a IP e subnet: i siti dei Comuni stanno spesso su pochi hosting condivisi (il 9/11/2026 119 host su 93.56.55.0/24),
e un fornitore che non risponde al runner lo fa per tutti i suoi siti insieme. I limiti di frequenza e il rilevamento dei
cluster ragionano quindi per IP e per subnet (/24 per IPv4, /48 per IPv6), non solo per host."""

from __future__ import annotations

import ipaddress
import socket
import threading
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor

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
