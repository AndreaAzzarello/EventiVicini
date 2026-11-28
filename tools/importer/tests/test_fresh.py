"""Rilettura senza cache (regione a zero eventi): niente validatori, Cache-Control: no-cache; il corpo nuovo si salva."""

import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import fetch  # noqa: E402
from fetch import Fetcher  # noqa: E402


def make(tmp_path, seen):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nAllow: /")
        seen.append(dict(req.headers))
        if req.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(200, text="<html>eventi</html>", headers={"etag": '"v1"'})
    return Fetcher(httpx.Client(transport=httpx.MockTransport(handler)), min_interval=0, backoff=0, cache_dir=tmp_path)


@pytest.fixture(autouse=True)
def reset_fresh():
    yield
    fetch.FRESH = False


def test_senza_fresh_il_secondo_get_manda_i_validatori_e_usa_la_cache(tmp_path):
    seen: list[dict] = []
    f = make(tmp_path, seen)
    f.get("https://x.it/eventi/")
    res = f.get("https://x.it/eventi/")
    assert seen[1].get("if-none-match") == '"v1"' and "cache-control" not in seen[1]
    assert res.text == "<html>eventi</html>" and f.hits == 1


def test_con_fresh_niente_validatori_e_no_cache_e_la_risposta_e_nuova(tmp_path):
    seen: list[dict] = []
    f = make(tmp_path, seen)
    f.get("https://x.it/eventi/")
    fetch.FRESH = True
    res = f.get("https://x.it/eventi/")
    assert "if-none-match" not in seen[1] and "if-modified-since" not in seen[1]
    assert seen[1]["cache-control"] == "no-cache"
    assert res.status_code == 200 and f.hits == 0  # nessun 304 dalla cache: pagina riletta dal sito
