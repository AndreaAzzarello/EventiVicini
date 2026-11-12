"""Emilia-Romagna Turismo: formato dell'API, date miste, un evento per comune, niente immagini, deduplica."""

import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import run  # noqa: E402
from adapters import SOURCES  # noqa: E402
from adapters import ert  # noqa: E402
from adapters.ert import API, BASE, ErtAdapter  # noqa: E402

NOW = datetime(2026, 11, 12, 6, 0, tzinfo=timezone.utc)
RAW = json.loads((Path(__file__).parent / "fixtures" / "ert_events.json").read_text(encoding="utf-8"))
ADAPTER = ErtAdapter("ert-emilia-romagna", BASE, "Emilia Romagna Turismo", "BO", "Emilia-Romagna")


def items() -> list[dict]:
    return copy.deepcopy(RAW["data"])


def by_title(start: str) -> dict:
    return next(i for i in items() if i["title"].startswith(start))


def convert(item: dict, horizon: int = 60) -> list[dict]:
    return list(ADAPTER._events(item, NOW, horizon))


def test_record_reali_diventano_eventi_senza_immagini():
    evs = [ev for i in items() for ev in convert(i)]
    assert len(evs) == 8  # Viva Varda, Tartufo, Maratona e «Buon Natale Appennino» in 5 comuni; tre durano oltre un anno, Carnevale è oltre i 60 giorni
    assert {e["imageUrl"] for e in evs} == {""}  # le immagini hanno licenze NC/ND/SA
    maratona = next(e for e in evs if e["title"].startswith("Maratona"))
    assert maratona["sourceUrl"].startswith(BASE + "/") and maratona["source"] == "scraper"
    assert maratona["_place"] == {"city": "Reggio nell'Emilia", "citySlug": "reggio-nell-emilia", "province": "RE",
                                  "region": "Emilia-Romagna", "locality": ""}
    assert maratona["priceType"] == "free" and maratona["ticketUrl"] == "https://www.maratonadireggioemilia.it/"
    assert maratona["lat"] and maratona["lng"] and maratona["endTime"] > maratona["startTime"]
    assert maratona["category"] == "sport"


def test_date_con_barre_e_trattini_tutto_il_giorno_ora_di_roma():
    viva = convert(by_title("Viva Varda"))[0]  # «2026/03/05» → «2027/01/09»
    assert datetime.fromtimestamp(viva["startTime"] / 1000, ert.ROME).isoformat() == "2026-03-05T00:00:00+01:00"
    assert datetime.fromtimestamp(viva["endTime"] / 1000, ert.ROME).isoformat() == "2027-01-09T23:59:00+01:00"
    assert datetime.fromtimestamp(convert(by_title("Maratona"))[0]["endTime"] / 1000, ert.ROME).hour == 23


def test_un_evento_per_comune_con_id_stabili_e_distinti():
    evs = convert(by_title("Buon Natale Appennino"))
    assert [e["_place"]["city"] for e in evs] == ["Castelnovo ne' Monti", "Canossa", "Baiso", "Villa Minozzo", "Vetto"]
    assert len({e["id"] for e in evs}) == 5 and len({e["sourceUrl"] for e in evs}) == 1
    assert evs[0]["id"] == ert.event_id(evs[0]["sourceUrl"])  # il primo comune tiene l'id del permalink
    assert [e["id"] for e in convert(by_title("Buon Natale Appennino"))] == [e["id"] for e in evs]  # stabili tra due giri


def test_tipo_di_ingresso_numero_o_testo():
    nums = by_title("Sagra del Tartufo")
    assert nums["ticketing"]["type"] == 1 and convert(nums)[0]["priceType"] != "free"
    free = by_title("Maratona")
    assert free["ticketing"]["type"] == "2" and convert(free)[0]["priceType"] == "free"
    free["ticketing"]["type"] = 2
    assert convert(free)[0]["priceType"] == "free"


def test_senza_coordinate_va_al_geocoding():
    tartufo = convert(by_title("Sagra del Tartufo"))[0]  # lat/lng a 0 nel record
    assert tartufo["lat"] is None and tartufo["lng"] is None
    assert tartufo["_geocode"] and all("Cento" in q for q in tartufo["_geocode"])


def test_scartati_scaduti_annullati_fuori_finestra_troppo_lunghi_fuori_regione():
    gatteo = by_title("Maratona")  # 13/12/2026, in finestra
    assert convert(gatteo)
    assert convert({**gatteo, "scaduto": 1}) == [] and convert({**gatteo, "status": 0}) == []
    assert convert(by_title("Carnevale")) == [] and convert(by_title("Carnevale"), horizon=120)  # inizia il 31/1/2027
    assert convert(by_title("Sulla via")) == []  # 389 giorni: oltre il tetto di durata
    lungo = next(i for i in items() if i["dates"]["to"].startswith("2050"))
    assert convert(lungo) == []  # trent'anni: oltre il tetto di durata
    fuori = copy.deepcopy(gatteo)
    fuori["locations"][0]["province"] = "Milano"
    assert convert(fuori) == []
    no_url = {**gatteo, "permalink": "https://altro.example/evento"}
    assert convert(no_url) == []  # solo URL del portale: è l'attribuzione richiesta


def test_per_famiglie_e_bambini():
    carnevale = convert(by_title("Carnevale"), horizon=120)[0]  # «Per famiglie»
    assert "kids" in carnevale["tags"]


def mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_una_sola_richiesta_e_si_ferma_all_ultima_pagina(monkeypatch):
    monkeypatch.setattr(ert.time, "sleep", lambda s: None)
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url)
        return httpx.Response(200, json=RAW)

    evs = list(ADAPTER.events(mock_client(handler), NOW, 60))
    assert len(calls) == 1 and str(calls[0]).startswith(API) and calls[0].params["limit"] == "500" and len(evs) == 8


def test_paginazione_segue_last_page(monkeypatch):
    monkeypatch.setattr(ert.time, "sleep", lambda s: None)
    pages = []

    def handler(req: httpx.Request) -> httpx.Response:
        page = int(req.url.params["page"])
        pages.append(page)
        return httpx.Response(200, json={"data": [], "meta": {"last_page": 3}})

    assert list(ADAPTER.events(mock_client(handler), NOW, 60)) == [] and pages == [1, 2, 3]


@pytest.mark.parametrize("status", [429, 503])
def test_limite_o_errore_del_server_e_errore_della_fonte(status):
    with pytest.raises(httpx.HTTPStatusError):
        list(ADAPTER.events(mock_client(lambda req: httpx.Response(status)), NOW, 60))


def test_registrata_come_fonte_regionale():
    assert "ert-emilia-romagna" in SOURCES and SOURCES["ert-emilia-romagna"].regional is True


def fake_source(name: str, evs: list[dict], regional: bool):
    return SimpleNamespace(name=name, base=f"https://{name}.example", city="Reggio nell'Emilia", province="RE",
                           region="Emilia-Romagna", viewbox=None, regional=regional,
                           events=lambda client, now, horizon: iter(evs))


class NoGeocoder:
    deferred: list = []
    requests = 0

    def reverse(self, *a, **k):
        return None

    def lookup(self, *a, **k):
        return None


def test_deduplica_vince_la_fonte_comunale_su_titolo_giorno_e_comune(monkeypatch):
    regionale = convert(by_title("Maratona"))[0]
    comunale = dict(regionale) | {"id": "comune1", "title": "Maratona di Reggio Emilia!", "sourceUrl": "https://comune.example/e/1",
                                  "shortDescription": "più ricco", "imageUrl": "https://comune.example/img.jpg"}
    comunale.pop("_place")
    srcs = {"ert": fake_source("ert", [regionale], True), "comune": fake_source("comune", [comunale], False)}
    monkeypatch.setattr(run, "SOURCES", srcs)
    stats: dict = {}
    out = run.collect(None, NoGeocoder(), ["ert", "comune"], NOW, 60, stats)
    assert [e["id"] for e in out] == ["comune1"] and (stats["ert"]["events"], stats["comune"]["events"]) == (0, 1)
    assert stats["ert"]["duplicates"] == 1
    # senza il doppione l'evento regionale entra, con comune e provincia giusti e senza immagine
    monkeypatch.setattr(run, "SOURCES", {"ert": fake_source("ert", [convert(by_title("Maratona"))[0]], True)})
    out = run.collect(None, NoGeocoder(), ["ert"], NOW, 60, {})
    assert len(out) == 1 and out[0]["city"] == "Reggio nell'Emilia" and out[0]["imageUrl"] == "" and "_place" not in out[0]


def test_with_code_sources_aggiunge_ert_solo_con_fonti_emilia_romagna():
    from adapters import with_code_sources
    fonte = lambda region: SimpleNamespace(region=region)  # noqa: E731
    assert "ert-emilia-romagna" in with_code_sources({"modena": fonte("Emilia-Romagna")})
    assert "ert-emilia-romagna" not in with_code_sources({"lana": fonte("Trentino-Alto Adige")})
