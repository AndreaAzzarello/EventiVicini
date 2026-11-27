"""Eventi a Firenze (dataset aperto del Comune, CC BY 4.0): GeoJSON reale ridotto a 10 record (27/11/2026)."""

import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from adapters import SOURCES, with_code_sources  # noqa: E402
from adapters.firenze import API, BASE, FIRENZE_VIEWBOX, FirenzeAdapter  # noqa: E402
from mapping import ROME, event_id  # noqa: E402

NOW = datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc)
RAW = json.loads((Path(__file__).parent / "fixtures" / "firenze_eventi.geojson").read_text(encoding="utf-8"))
ADAPTER = FirenzeAdapter("comune-firenze-opendata", BASE, "Firenze", "FI", "Toscana", FIRENZE_VIEWBOX, api=API)


def feature(fid: int) -> dict:
    return copy.deepcopy(next(f for f in RAW["features"] if f["properties"]["id"] == fid))


def convert(f: dict, horizon: int = 60) -> list[dict]:
    return list(ADAPTER._events(f, NOW, horizon))


def local(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, ROME).isoformat()


def test_record_reali_diventano_eventi_senza_immagini_con_luogo_di_firenze():
    evs = [e for f in RAW["features"] for e in convert(f)]
    assert len(evs) == 9  # il cinema aperto fino al 2038 (4240 giorni) è scartato
    assert {e["imageUrl"] for e in evs} == {""} and {e["source"] for e in evs} == {"scraper"}
    assert all(e["sourceUrl"].startswith(BASE + "/it/eventi/") and e["id"] == event_id(e["sourceUrl"]) for e in evs)
    assert {e["_place"]["city"] for e in evs} == {"Firenze"} and {e["_place"]["province"] for e in evs} == {"FI"}
    assert {e["_place"]["region"] for e in evs} == {"Toscana"} and all(e["lat"] and e["lng"] for e in evs)


def test_una_data_con_orario_vale_quel_giorno_e_quell_ora_di_roma():
    madame = convert(feature(90))[0]  # 30/11/2026 dalle 20:45, nessuna fine
    assert (local(madame["startTime"]), local(madame["endTime"])) == ("2026-11-30T20:45:00+01:00", "2026-11-30T23:59:00+01:00")
    calici = convert(feature(71))[0]  # 05/12/2026 dalle 10:30 alle 19:30
    assert (local(calici["startTime"]), local(calici["endTime"])) == ("2026-12-05T10:30:00+01:00", "2026-12-05T19:30:00+01:00")


def test_intervalli_e_date_multiple_vanno_da_data_inizio_a_data_fine():
    opera = convert(feature(1))[0]  # «Da 01/01/2026 a 30/12/2026» con giorni della settimana
    assert (local(opera["startTime"]), local(opera["endTime"])) == ("2026-01-01T00:00:00+01:00", "2026-12-30T23:59:00+01:00")
    fierucola = convert(feature(10))[0]  # molte date: l'ora legale cambia fra inizio e fine
    assert (local(fierucola["startTime"]), local(fierucola["endTime"])) == ("2026-04-12T00:00:00+02:00", "2026-12-20T23:59:00+01:00")
    assert convert(feature(7))[0]["venueName"] == "Teatro del Maggio Musicale Fiorentino"  # più sedi: la prima


def test_id_stabile_e_distinto_per_scheda():
    assert [e["id"] for e in convert(feature(90))] == [e["id"] for e in convert(feature(90))]
    assert convert(feature(90))[0]["id"] != convert(feature(74))[0]["id"]


def test_comune_vuoto_o_con_elenco():
    assert convert(feature(74))[0]["_place"]["city"] == "Firenze"  # comuni null
    elenco = feature(7)
    elenco["properties"]["comuni"] = "Fiesole\nSesto Fiorentino\nFirenze"
    assert convert(elenco)[0]["_place"]["city"] == "Firenze"
    senza = feature(7)
    senza["properties"]["comuni"] = "Fiesole\nSesto Fiorentino"
    ev = convert(senza)[0]
    assert ev["_place"]["city"] == "Fiesole" and ev["_place"]["citySlug"] == "fiesole" and ev["_place"]["province"] == "FI"


def test_biglietti_solo_https_e_tag_bambini():
    assert convert(feature(10))[0]["ticketUrl"] == ""  # il sito dell'organizzatore è http
    assert convert(feature(1))[0]["ticketUrl"].startswith("https://")
    assert convert(feature(7))[0]["tags"] == ["kids"] and convert(feature(90))[0]["tags"] == []


def test_senza_coordinate_o_fuori_provincia_va_al_geocoding():
    senza = feature(90)
    senza["geometry"] = None
    ev = convert(senza)[0]
    assert ev["lat"] is None and ev["lng"] is None and ev["approxLocation"] is False
    assert ev["_geocode"] and all("Firenze" in q for q in ev["_geocode"])
    fuori = feature(90)
    fuori["geometry"]["coordinates"] = [[2.35, 48.85]]  # Parigi
    assert convert(fuori)[0]["lat"] is None
    vuoto = feature(90)
    vuoto["geometry"]["coordinates"] = []
    assert convert(vuoto)[0]["lat"] is None


def test_scartati_passati_fuori_finestra_e_host_diverso():
    passato = feature(90)
    passato["properties"].update(data_inizio="2026-11-01", data_fine="2026-11-02", appuntamenti="x\nQuando:\n01/11/2026 dalle 20:00")
    assert convert(passato) == []
    assert convert(feature(45)) and convert(feature(45), horizon=10) == []  # 16/12: oltre 10 giorni
    altro = feature(90)
    altro["properties"]["feelflorence_link"] = "https://destinationflorence.com.evil.example/it/eventi/x"
    assert convert(altro) == []  # solo le schede del portale: è l'attribuzione richiesta (CC BY 4.0)
    senza_titolo = feature(90)
    senza_titolo["properties"]["titolo"] = " "
    assert convert(senza_titolo) == []
    date_rotte = feature(90)
    date_rotte["properties"]["data_inizio"] = "boh"
    assert convert(date_rotte) == []


def mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_una_sola_richiesta_al_file_geojson():
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return httpx.Response(200, json=RAW)

    evs = list(ADAPTER.events(mock_client(handler), NOW, 60))
    assert len(calls) == 1 and str(calls[0].url) == API and len(evs) == 9
    assert API.startswith("https://datigis.comune.fi.it/")  # data.comune.fi.it ha robots Disallow: /


@pytest.mark.parametrize("status", [404, 429, 503])
def test_errore_del_server_e_errore_della_fonte(status):
    with pytest.raises(httpx.HTTPStatusError):
        list(ADAPTER.events(mock_client(lambda req: httpx.Response(status)), NOW, 60))


def test_troppe_feature_fermano_la_fonte():
    enorme = {"type": "FeatureCollection", "features": [RAW["features"][0]] * 2001}
    with pytest.raises(httpx.HTTPError):
        list(ADAPTER.events(mock_client(lambda req: httpx.Response(200, json=enorme)), NOW, 60))


def test_registrata_come_fonte_regionale_solo_con_fonti_toscane():
    fonte = lambda region: SimpleNamespace(region=region)  # noqa: E731
    con = with_code_sources({"prato": fonte("Toscana")})
    assert "comune-firenze-opendata" in con and con["comune-firenze-opendata"].regional is True
    assert con["comune-firenze-opendata"].base == BASE and con["comune-firenze-opendata"].region == "Toscana"
    assert "comune-firenze-opendata" not in with_code_sources({"lana": fonte("Trentino-Alto Adige")})
    assert "comune-firenze-opendata" in SOURCES  # il registro ha comuni toscani attivi
