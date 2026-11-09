import json
import sys
from datetime import datetime
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from adapters import SOURCES  # noqa: E402
from geo import enrich, geohash, place_from_nominatim, slugify  # noqa: E402
from geocode import Geocoder  # noqa: E402
from mapping import ROME  # noqa: E402
from migrate import plan  # noqa: E402
from run import collect  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "plone_events.json"
NOW = datetime(2026, 10, 26, 12, 0, tzinfo=ROME)
ADDRESS = {"town": "Formigine", "ISO3166-2-lvl6": "IT-MO", "state": "Emilia-Romagna"}


def test_geohash_come_geofire():
    # Stesso vettore di web/src/lib/geo.test.ts: i due lati devono coincidere.
    assert geohash(57.64911, 10.40744) == "u4pruydqqv"
    assert geohash(44.6458, 10.9256) == "spzvbxeb8u"  # Modena, verificato con geofire-common


@pytest.mark.parametrize("text, slug", [
    ("Sagra dell'Uva & Città Più Bella!", "sagra-dell-uva-citta-piu-bella"),
    ("Reggio nell’Emilia", "reggio-nell-emilia"),
    ("  --Modena--  ", "modena"),
])
def test_slugify_come_la_webapp(text, slug):
    assert slugify(text) == slug


def test_localita_da_nominatim():
    assert place_from_nominatim(ADDRESS) == {
        "city": "Formigine", "citySlug": "formigine", "province": "MO", "region": "Emilia-Romagna", "locality": ""}
    assert place_from_nominatim({"state": "Lazio"}) is None
    assert place_from_nominatim(None) is None


REVERSE = json.loads((Path(__file__).parent / "fixtures" / "nominatim_reverse.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("key, source_city, prov, city, locality", [
    # Risposte reali di Nominatim. municipality è un'Unione di comuni: il comune è quello della fonte.
    ("minerbio", "Minerbio", "BO", "Minerbio", "Tintoria"),
    ("terredelreno", "Terre del Reno", "FE", "Terre del Reno", "Sant'Agostino"),
    ("rivadelpo", "Riva del Po", "FE", "Riva del Po", "Cologna"),
    # il comune è "village" e la frazione "town"
    ("rottofreno", "Rottofreno", "PC", "Rottofreno", "San Nicolò a Trebbia"),
])
def test_comune_e_frazione_da_risposte_reali(key, source_city, prov, city, locality):
    place = place_from_nominatim(REVERSE[key]["address"], source_city, prov)
    assert (place["city"], place["locality"], place["province"]) == (city, locality, prov)
    assert place["citySlug"] == slugify(city)


def test_comune_vicino_resta_il_suo():
    # un evento della fonte Modena che cade a Nonantola: city = Nonantola, non Modena
    addr = {"town": "Nonantola", "ISO3166-2-lvl6": "IT-MO", "state": "Emilia-Romagna"}
    assert place_from_nominatim(addr, "Modena", "MO")["city"] == "Nonantola"


def test_altra_provincia_o_indirizzo_senza_comune_usa_la_fonte():
    addr = {"municipality": "Zola Predosa", "ISO3166-2-lvl6": "IT-BO", "state": "Emilia-Romagna"}
    assert place_from_nominatim(addr, "Sassuolo", "MO") is None  # altra provincia
    assert place_from_nominatim({"municipality": "Unione Terre di Pianura", "ISO3166-2-lvl6": "IT-BO"}, "Minerbio", "BO") is None


def test_enrich_scrive_locality_solo_se_c_e():
    base = {"lat": 44.65, "lng": 10.93}
    ev = enrich(dict(base), {"city": "Terre del Reno", "province": "FE", "region": "E-R", "locality": "Sant'Agostino"}, {})
    assert (ev["city"], ev["citySlug"], ev["locality"]) == ("Terre del Reno", "terre-del-reno", "Sant'Agostino")
    assert "locality" not in enrich(dict(base), {"city": "Modena", "province": "MO", "region": "E-R", "locality": ""}, {})


def test_enrich_usa_la_fonte_se_manca_il_reverse():
    ev = enrich({"lat": 44.6458, "lng": 10.9256}, None, {"city": "Modena", "province": "MO", "region": "Emilia-Romagna"})
    assert ev["citySlug"] == "modena" and ev["province"] == "MO" and len(ev["geohash"]) == 10


def fake_client(counter: dict) -> httpx.Client:
    """Plone restituisce la fixture, Nominatim un indirizzo fisso; conta le richieste."""
    items = json.loads(FIXTURE.read_text(encoding="utf-8"))["items"]

    def handler(req: httpx.Request) -> httpx.Response:
        host = req.url.host
        counter[host] = counter.get(host, 0) + 1
        if "nominatim" in host:
            if req.url.path == "/reverse":
                return httpx.Response(200, json={"address": ADDRESS})
            return httpx.Response(200, json=[{"lat": "44.57", "lon": "10.85"}])
        return httpx.Response(200, json={"items": items, "batching": {}})

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_reverse_in_cache(tmp_path):
    counter: dict = {}
    g = Geocoder(fake_client(counter), tmp_path / "c.json")
    assert g.reverse(44.57311, 10.84661)["city"] == "Formigine"
    assert g.reverse(44.57319, 10.84669)["city"] == "Formigine"  # stessa cella da ~100 m
    assert counter["nominatim.openstreetmap.org"] == 1
    g.save()
    assert "rev2:44.573,10.847" in json.loads((tmp_path / "c.json").read_text(encoding="utf-8"))


def test_collect_aggiunge_geohash_e_localita(tmp_path):
    counter: dict = {}
    client = fake_client(counter)
    events = collect(client, Geocoder(client, tmp_path / "c.json"), ["modena"], NOW, 60)
    assert events, "la fixture contiene eventi validi"
    for ev in events:
        assert ev["geohash"] == geohash(ev["lat"], ev["lng"])
        assert (ev["city"], ev["citySlug"], ev["province"], ev["region"]) == (
            "Formigine", "formigine", "MO", "Emilia-Romagna")


def test_adapter_hanno_interfaccia_comune():
    for a in SOURCES.values():
        assert a.name and a.city and a.province and a.region and callable(a.events)


def test_migrazione_solo_eventi_incompleti(tmp_path):
    counter: dict = {}
    g = Geocoder(fake_client(counter), tmp_path / "c.json")
    complete = {"lat": 44.6, "lng": 10.9, "geohash": "srbj", "city": "Modena", "citySlug": "modena",
                "province": "MO", "region": "Emilia-Romagna"}
    docs = [("ok", complete), ("vecchio", {"lat": 44.573, "lng": 10.847}), ("rotto", {"lat": 0, "lng": 0})]
    updates, broken = plan(docs, g)
    assert [u[0] for u in updates] == ["vecchio"]
    assert updates[0][1]["city"] == "Formigine" and updates[0][1]["geohash"] == geohash(44.573, 10.847)
    assert broken == ["rotto"]


def test_geocoder_strict_il_budget_vale_anche_per_le_richieste_essenziali(tmp_path):
    """Dry-run: con budget finito (o 0) nemmeno il centro del comune va a Nominatim."""
    counter: dict = {}
    g = Geocoder(fake_client(counter), tmp_path / "c.json", max_requests=0, strict=True)
    assert g.lookup("Modena, MO", essential=True) is None and counter == {} and g.deferred
    normale = Geocoder(fake_client(counter), tmp_path / "d.json", max_requests=0)
    assert normale.lookup("Modena, MO", essential=True) is not None and sum(counter.values()) == 1  # senza strict l'essenziale passa


def test_run_main_dry_run_crea_il_geocoder_strict(monkeypatch):
    import run
    seen = {}
    real = run.Geocoder

    class Spia(real):
        def __init__(self, *a, **kw):
            seen["strict"] = kw.get("strict")
            super().__init__(*a, **kw)

    monkeypatch.setattr(run, "Geocoder", Spia)
    from types import SimpleNamespace

    fonte = SimpleNamespace(region="Veneto", city="Xyz", province="PD", base="https://x.it", viewbox=None, regional=False)
    monkeypatch.setattr(run, "SOURCES", {"x": fonte})
    monkeypatch.setattr(run, "collect", lambda *a, **k: [])
    run.main(["--dry-run", "--regione", "veneto"])
    assert seen.get("strict") is True
