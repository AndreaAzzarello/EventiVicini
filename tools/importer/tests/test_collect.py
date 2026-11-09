"""collect(): deduplica tra fonti, sessioni, eventi senza coordinate, forma di stats (#26, test di caratterizzazione)."""

import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import httpx

sys.path.insert(0, str(Path(__file__).parents[1]))
from mapping import ROME  # noqa: E402

import run  # noqa: E402

NOW = datetime(2026, 11, 3, tzinfo=ROME)
START = int(datetime(2026, 11, 10, 21, 0, tzinfo=ROME).timestamp() * 1000)
HOUR = 3_600_000
PLACE = {"city": "Modena", "citySlug": "modena", "province": "MO", "region": "Emilia-Romagna"}


def evento(title="Concerto in piazza", start=START, url="https://a.it/e/1", ticket="", lat=44.6471):
    return {"title": title, "shortDescription": "", "category": "music", "priceType": "free", "startTime": start,
            "endTime": start + 2 * HOUR, "venueName": "Piazza Grande", "address": "", "lat": lat, "lng": 10.9252,
            "imageUrl": "", "ticketUrl": ticket, "tags": [], "source": "scraper", "sourceUrl": url,
            "approxLocation": False, "_geocode": [], "_place": dict(PLACE), "id": url[-4:]}


class Fonte:
    """Fonte finta: restituisce una copia degli eventi dati."""
    region, city, province, viewbox = "Emilia-Romagna", "Modena", "MO", None

    def __init__(self, base, eventi, regional=False, sessions=False):
        self.base, self.eventi, self.regional, self.sessions = base, eventi, regional, sessions

    def events(self, client, now, horizon):
        return [dict(e, _place=dict(PLACE), _geocode=[]) for e in self.eventi]


class SenzaLuogo:
    """Geocoder che non trova nulla."""
    def lookup(self, *a, **kw):
        return None


def esegui(monkeypatch, sources, geocoder=None):
    monkeypatch.setattr(run, "SOURCES", sources)
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    stats: dict = {}
    out = run.collect(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200))),
                      geocoder or SimpleNamespace(), list(sources), NOW, 60, stats)
    return out, stats


def test_la_forma_di_stats_per_fonte(monkeypatch):
    out, stats = esegui(monkeypatch, {"modena": Fonte("https://www.comune.modena.it", [evento()])})
    assert len(out) == 1
    assert stats["modena"] == {"events": 1, "skipped": 0, "excluded": 0, "duplicates": 0, "error": None,
                               "seconds": stats["modena"]["seconds"], "requests": 0}


def test_il_comune_batte_la_fonte_regionale_qualunque_sia_l_ordine(monkeypatch):
    for ordine in (("reg", "com"), ("com", "reg")):
        fonti = {"reg": Fonte("https://odh.it", [evento(url="https://odh.it/e/1")], regional=True),
                 "com": Fonte("https://www.comune.modena.it", [evento(url="https://www.comune.modena.it/e/1")])}
        out, stats = esegui(monkeypatch, {k: fonti[k] for k in ordine})
        assert [e["sourceUrl"] for e in out] == ["https://www.comune.modena.it/e/1"]
        assert (stats["com"]["events"], stats["com"]["duplicates"]) == (1, 0)
        assert (stats["reg"]["events"], stats["reg"]["duplicates"]) == (0, 1)


def test_due_fonti_comunali_stesso_evento_resta_la_prima(monkeypatch):
    out, stats = esegui(monkeypatch, {"a": Fonte("https://www.comune.a.it", [evento(url="https://a.it/e/1")]),
                                      "b": Fonte("https://www.comune.b.it", [evento(url="https://b.it/e/1")])})
    assert [e["sourceUrl"] for e in out] == ["https://a.it/e/1"]
    assert stats["a"]["events"] == 1 and stats["b"]["duplicates"] == 1


def test_il_vincitore_senza_biglietti_prende_il_link_dell_altra_fonte(monkeypatch):
    fonti = {"com": Fonte("https://www.comune.modena.it", [evento(url="https://www.comune.modena.it/e/1")]),
             "tm": Fonte("https://app.ticketmaster.com", [evento(url="https://tm.it/e/1", ticket="https://tm.it/buy")], regional=True)}
    out, _ = esegui(monkeypatch, fonti)
    assert out[0]["ticketUrl"] == "https://tm.it/buy"
    senza, _ = esegui(monkeypatch, {"com": fonti["com"]})
    assert senza[0]["contentHash"] != out[0]["contentHash"]  # il link entra nell'hash: il documento si riscrive


def test_sessioni_della_stessa_fonte_non_sono_doppioni(monkeypatch):
    sera = evento(url="https://tm.it/e/1")
    notte = evento(url="https://tm.it/e/2", start=START + HOUR)
    out, stats = esegui(monkeypatch, {"tm": Fonte("https://app.ticketmaster.com", [sera, notte], regional=True, sessions=True)})
    assert len(out) == 2 and stats["tm"]["events"] == 2 and stats["tm"]["duplicates"] == 0


def test_senza_il_flag_sessions_due_orari_dello_stesso_giorno_sono_un_doppione(monkeypatch):
    sera = evento(url="https://x.it/e/1")
    notte = evento(url="https://x.it/e/2", start=START + HOUR)
    out, stats = esegui(monkeypatch, {"x": Fonte("https://www.comune.x.it", [sera, notte])})
    assert len(out) == 1 and stats["x"]["duplicates"] == 1


def test_evento_senza_coordinate_e_senza_luogo_si_scarta(monkeypatch):
    out, stats = esegui(monkeypatch, {"x": Fonte("https://www.comune.x.it", [evento(lat=None)])}, SenzaLuogo())
    assert out == [] and stats["x"]["skipped"] == 1 and stats["x"]["events"] == 0


def test_ogni_evento_tenuto_ha_geohash_hash_e_regione_di_import(monkeypatch):
    out, _ = esegui(monkeypatch, {"x": Fonte("https://www.comune.x.it", [evento()])})
    e = out[0]
    assert len(e["geohash"]) == 10 and len(e["contentHash"]) == 64 and e["importRegion"] == "emilia-romagna"
    assert "_place" not in e and "_geocode" not in e
