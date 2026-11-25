"""Calabria Straordinaria: stessa classe di ERT, configurata per il portale calabrese (record reali ridotti, 25/11/2026)."""

import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from adapters import SOURCES, ert, with_code_sources  # noqa: E402
from adapters.ert import (CALABRIA_API, CALABRIA_BASE, CATEGORY_CALABRIA, PROVINCE_CODE_CALABRIA,  # noqa: E402
                          ErtAdapter)

NOW = datetime(2026, 11, 25, 6, 0, tzinfo=timezone.utc)
RAW = json.loads((Path(__file__).parent / "fixtures" / "calabria_events.json").read_text(encoding="utf-8"))
ADAPTER = ErtAdapter("calabria-straordinaria", CALABRIA_BASE, "Calabria Straordinaria", "CZ", "Calabria", api=CALABRIA_API,
                     page_size=1000, max_pages=2, status_required=False, provinces=PROVINCE_CODE_CALABRIA,
                     categories=CATEGORY_CALABRIA)


def items() -> list[dict]:
    return copy.deepcopy(RAW["data"])


def item(event_id: int) -> dict:
    return next(i for i in items() if i["id"] == event_id)


def convert(raw: dict, horizon: int = 60) -> list[dict]:
    return list(ADAPTER._events(raw, NOW, horizon))


def test_record_reali_senza_status_ne_ticketing_diventano_eventi_senza_immagini():
    evs = [ev for i in items() for ev in convert(i)]
    # Palmi 1, Vibo ×2, Schiaccianoci in 2 comuni, Biennale in 3, Assaporagionando, Crotone ×2, la mostra di 365 giorni;
    # passato (8201) e 2027 oltre i 60 giorni (5788) scartati
    assert len(evs) == 12
    assert {e["imageUrl"] for e in evs} == {""}  # le immagini sono http e senza licenza nel record
    assert {e["source"] for e in evs} == {"scraper"} and {e["ticketUrl"] for e in evs} == {""}
    assert all(e["sourceUrl"].startswith(CALABRIA_BASE + "/") for e in evs)
    assert {e["_place"]["region"] for e in evs} == {"Calabria"}


def test_provincia_nome_esteso_e_reggio_di_calabria():
    palmi = convert(item(16587))[0]
    assert palmi["_place"] == {"city": "Palmi", "citySlug": "palmi", "province": "RC", "region": "Calabria", "locality": ""}
    assert palmi["category"] == "food" and palmi["lat"] and palmi["lng"]
    assert convert(item(29919))[0]["_place"]["province"] == "VV"
    assert convert(item(20329))[0]["_place"]["province"] == "KR"


def test_date_tutto_il_giorno_ora_di_roma_e_stesso_giorno():
    palmi = convert(item(16587))[0]  # 5 → 8 dicembre
    assert datetime.fromtimestamp(palmi["startTime"] / 1000, ert.ROME).isoformat() == "2026-12-05T00:00:00+01:00"
    assert datetime.fromtimestamp(palmi["endTime"] / 1000, ert.ROME).isoformat() == "2026-12-08T23:59:00+01:00"
    oggi = convert(item(42325))  # comincia e finisce il 25/11: in corso, non scartato
    assert len(oggi) == 1 and oggi[0]["endTime"] > oggi[0]["startTime"]


def test_piu_sedi_un_evento_per_comune_id_stabili_e_distinti():
    evs = convert(item(6770))
    assert [e["_place"]["city"] for e in evs] == ["Catanzaro", "Lamezia Terme"]
    assert len({e["id"] for e in evs}) == 2 and len({e["sourceUrl"] for e in evs}) == 1
    assert evs[0]["id"] == ert.event_id(evs[0]["sourceUrl"])
    assert [e["id"] for e in convert(item(6770))] == [e["id"] for e in evs]


def test_categorie_del_portale_e_eventi_multipli_decide_il_titolo():
    assert convert(item(29919))[0]["category"] == "culture"  # Teatro
    assert convert(item(20329))[0]["category"] == "music"
    assert convert(item(44591))[0]["category"] == "other"  # Fiere ed Esposizioni
    multipli = convert(item(6647))[0]  # «Eventi multipli»: nessuna categoria utile, ripiega sul titolo
    assert multipli["category"] == ert.category_from_title(multipli["title"]) or multipli["category"] == "other"
    assert "eventi multipli" not in CATEGORY_CALABRIA


def test_senza_coordinate_va_al_geocoding():
    biennale = convert(item(15889))
    reggio = next(e for e in biennale if e["_place"]["city"] == "Reggio di Calabria")  # lat/lng a 0, né via né luogo
    assert reggio["lat"] is None and reggio["lng"] is None
    assert reggio["_geocode"] == []  # nessun indirizzo da cercare: run.collect ripiega sul centro del comune
    assert next(e for e in biennale if e["_place"]["city"] == "Badolato")["lat"]
    raw = item(15889)
    sede = next(p for p in raw["locations"] if p["city"] == "Reggio di Calabria")
    sede["address"], sede["number"] = "Corso Garibaldi", "1"
    con_via = next(e for e in convert(raw) if e["_place"]["city"] == "Reggio di Calabria")
    assert con_via["lat"] is None and con_via["_geocode"] and all("Reggio di Calabria" in q for q in con_via["_geocode"])


def test_scartati_passati_fuori_finestra_e_fuori_regione():
    assert convert(item(8201)) == []  # 19/11/2026, già finito
    assert convert(item(5788)) == [] and convert(item(5788), horizon=300)  # agosto 2027
    assert len(convert(item(36877))) == 1  # mostra di 365 giorni in corso: dentro il tetto di durata
    fuori = item(29919)
    fuori["locations"][0]["province"] = "Messina"
    assert convert(fuori) == []
    altro = {**item(29919), "permalink": "https://altro.example/evento"}
    assert convert(altro) == []  # solo URL del portale: è l'attribuzione richiesta (CC BY 4.0)
    senza_titolo = {**item(29919), "title": " "}
    assert convert(senza_titolo) == []


def test_scaduto_vale_anche_senza_status():
    assert convert({**item(29919), "scaduto": 1}) == []


def test_ert_continua_a_richiedere_status():
    ert_adapter = ErtAdapter("ert", ert.BASE, "ERT", "BO", "Emilia-Romagna")
    assert ert_adapter.status_required is True and ert_adapter.api == ert.API and ert_adapter.page_size == 500


def mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_una_sola_richiesta_con_limit_1000_e_user_agent_del_client(monkeypatch):
    monkeypatch.setattr(ert.time, "sleep", lambda s: None)
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return httpx.Response(200, json=RAW)

    evs = list(ADAPTER.events(mock_client(handler), NOW, 60))
    assert len(calls) == 1 and str(calls[0].url).startswith(CALABRIA_API)
    assert calls[0].url.params["limit"] == "1000" and calls[0].url.params["lang"] == "it" and len(evs) == 12


def test_si_ferma_a_due_pagine_anche_se_il_portale_ne_annuncia_di_piu(monkeypatch):
    monkeypatch.setattr(ert.time, "sleep", lambda s: None)
    pages = []

    def handler(req: httpx.Request) -> httpx.Response:
        pages.append(int(req.url.params["page"]))
        return httpx.Response(200, json={"data": [], "meta": {"last_page": 9}})

    assert list(ADAPTER.events(mock_client(handler), NOW, 60)) == [] and pages == [1, 2]


@pytest.mark.parametrize("status", [429, 503])
def test_limite_o_errore_del_server_e_errore_della_fonte(status):
    with pytest.raises(httpx.HTTPStatusError):
        list(ADAPTER.events(mock_client(lambda req: httpx.Response(status)), NOW, 60))


def test_registrata_come_fonte_regionale_solo_con_fonti_calabresi():
    fonte = lambda region: SimpleNamespace(region=region)  # noqa: E731
    con = with_code_sources({"cosenza": fonte("Calabria")})
    assert "calabria-straordinaria" in con and con["calabria-straordinaria"].regional is True
    assert "ert-emilia-romagna" not in con
    assert "calabria-straordinaria" not in with_code_sources({"lana": fonte("Trentino-Alto Adige")})
    assert "calabria-straordinaria" in SOURCES  # il registro ha comuni calabresi attivi
    assert SOURCES["calabria-straordinaria"].provinces is PROVINCE_CODE_CALABRIA
