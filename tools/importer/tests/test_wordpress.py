"""Adapter WordPress DCI: fixture reali dei 5 comuni, nessuna rete."""

import dataclasses
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from adapters import load_sources  # noqa: E402
from adapters.wordpress import WordpressAdapter  # noqa: E402
from fetch import Fetcher  # noqa: E402
from geo import PROVINCES  # noqa: E402
from mapping import ROME, event_id  # noqa: E402
from run import locate  # noqa: E402
from test_quality import geocoder  # noqa: E402

FIX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 27, 12, 0, tzinfo=ROME)
SITES = ["copparo", "bondeno", "mesola", "goro", "tresignana"]


def fixture(name):
    return json.loads((FIX / f"wp_{name}.json").read_text(encoding="utf-8"))


def adapter(name="copparo"):
    return WordpressAdapter(name, f"https://www.comune.{name}.fe.it", name.title(), "FE", "Emilia-Romagna",
                            PROVINCES["FE"][1])


def run(name, now=NOW, horizon=60, routes=None):
    """Eventi di un comune con un server finto; routes = risposte per path (default: la fixture)."""
    seen = []

    def handler(req):
        seen.append(req.url.path)
        if req.url.path in (routes or {"/wp-json/wp/v2/eventi": fixture(name)}):
            return httpx.Response(200, json=(routes or {"/wp-json/wp/v2/eventi": fixture(name)})[req.url.path])
        return httpx.Response(404, json={"code": "rest_no_route"})

    a = adapter(name)
    client = httpx.Client(transport=httpx.MockTransport(handler))
    a = dataclasses.replace(a, fetcher=Fetcher(client, min_interval=0, backoff=0))
    return list(a.events(client, now, horizon)), seen


def by_title(evs):
    return {e["title"]: e for e in evs}


@pytest.mark.parametrize("name", SITES)
def test_tutte_le_fixture_si_mappano(name):
    evs, _ = run(name, now=datetime(2020, 1, 1, tzinfo=ROME), horizon=10_000)
    assert evs
    for e in evs:
        assert e["title"] and "&amp;" not in e["title"] and e["approxLocation"] is False
        assert e["startTime"] < e["endTime"] and e["sourceUrl"].startswith(f"https://www.comune.{name}.fe.it/")
        assert e["id"] == event_id(e["sourceUrl"]) and e["priceType"] in ("free", "low", "premium")
        assert "_geocode" in e


def test_copparo_mappatura_completa():
    evs = by_title(run("copparo")[0])
    assert set(evs) == {"Aperi Halloween in via Cavour", 'Stagione teatrale - "Balena?"'}  # finiti/oltre orizzonte scartati
    e = evs["Aperi Halloween in via Cavour"]
    # il testo dice "sabato 31 ottobre dalle 18": ora locale, non UTC+1/+2
    assert datetime.fromtimestamp(e["startTime"] / 1000, ROME).strftime("%Y-%m-%d %H:%M") == "2026-10-31 18:00"
    assert (e["venueName"], e["address"], e["lat"], e["lng"]) == (
        "Centro storico di Copparo", "Copparo, via Roma 28", 44.8950912, 11.8272517)
    assert e["priceType"] == "low"  # costo "-": nessuna informazione
    assert e["imageUrl"].startswith("https://www.comune.copparo.fe.it/wp-content/uploads/")
    assert e["sourceUrl"] == "https://www.comune.copparo.fe.it/vivere-il-comune/eventi/aperi-halloween-in-via-cavour/"
    assert e["category"] == "other" and e["tags"] == []
    assert e["_geocode"][0] == "via Roma 28, Copparo"
    t = evs['Stagione teatrale - "Balena?"']
    assert t["priceType"] == "low" and t["lat"] == 44.8933091 and t["venueName"] == 'Teatro Comunale "De Micheli"'


def test_orario_non_convertito_da_utc():
    evs, _ = run("bondeno", now=datetime(2025, 9, 1, tzinfo=ROME))
    e = by_title(evs)["Scorre - il Festival: lunedì 8 settembre"]
    assert datetime.fromtimestamp(e["startTime"] / 1000, ROME).hour == 21  # "ore 21.00" nel testo
    assert e["priceType"] == "free" and e["lat"] is None and e["address"] == "Bondeno"


def test_titolo_con_entita_html_decodificato():
    evs, _ = run("copparo", now=datetime(2026, 6, 30, tzinfo=ROME), horizon=10)
    assert "Evento Pony & Pilates - I Cavalieri del Naviglio" in by_title(evs)


def test_bambini_dal_pubblico():
    evs, _ = run("goro", now=datetime(2026, 4, 1, tzinfo=ROME))
    assert evs and all(e["tags"] == ["kids"] for e in evs if "spazio" in e["title"].lower())
    assert any(e["tags"] == ["kids"] for e in evs)


def test_eventi_lunghi_importati_fino_al_tetto():
    now = datetime(2024, 11, 1, tzinfo=ROME)
    e = by_title(run("mesola", now=now)[0])["Webinar per genitori"]  # 50 giorni: prima scartato
    assert e["endTime"] - e["startTime"] > 45 * 86_400_000


def test_finiti_scartati():
    assert run("goro", now=datetime(2027, 1, 1, tzinfo=ROME))[0] == []


def test_autodetect_endpoint():
    routes = {"/wp-json/": {"routes": {"/wp/v2/posts": {}, "/wp/v2/events": {}}},
              "/wp-json/wp/v2/events": fixture("copparo")}
    evs, seen = run("copparo", routes=routes)
    assert len(evs) == 2 and seen == ["/robots.txt", "/wp-json/wp/v2/eventi", "/wp-json/", "/wp-json/wp/v2/events"]


def test_senza_endpoint_zero_eventi(caplog):
    caplog.set_level(logging.WARNING, logger="importer")
    evs, _ = run("copparo", routes={"/wp-json/": {"routes": {"/wp/v2/posts": {}}}})
    assert evs == [] and "nessun endpoint eventi REST" in caplog.text
    assert run("copparo", routes={"/x": 0})[0] == []  # nemmeno l'indice


def test_coordinate_fuori_provincia_scartate(tmp_path):
    item = dict(fixture("copparo")[4], luogo={"descrizione": "Piazza", "indirizzo": "via Roma 28",
                                               "gps": {"lat": "42.83", "lng": "12.83"}})
    evs, _ = run("copparo", routes={"/wp-json/wp/v2/eventi": [item]})
    g, seen = geocoder(tmp_path, {"via Roma": (44.8950, 11.8272)})
    locate(evs[0], SimpleNamespace(city="Copparo", province="FE", viewbox=PROVINCES["FE"][1]), g)
    assert evs[0]["lat"] == 44.8950 and seen[0]["q"].startswith("via Roma 28, Copparo")


def test_load_sources_wordpress_dci():
    row = {"comune": "Copparo", "provincia": "FE", "regione": "Emilia-Romagna", "sito": "https://www.comune.copparo.fe.it/",
           "cms": "wordpress-dci", "stato": "attivo"}
    src = load_sources([row, dict(row, comune="Altro", cms="drupal"), dict(row, comune="Off", stato="candidato")])
    assert list(src) == ["copparo"] and isinstance(src["copparo"], WordpressAdapter)
