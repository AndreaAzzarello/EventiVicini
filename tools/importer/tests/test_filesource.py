"""Fonte da file (#54): i dati del Mac sono non fidati; freschezza, host, schema, tetti; nessun effetto sullo stato degli host."""

import copy
import json
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import run  # noqa: E402
import unreachable  # noqa: E402
from adapters import with_file_sources  # noqa: E402
from adapters.filesource import MAX_EVENTS, FileSourceAdapter, clean_event  # noqa: E402
from mapping import event_id  # noqa: E402

FIX = Path(__file__).parent / "fixtures" / "fonti_mac"
DOC = json.loads((FIX / "collegno.json").read_text(encoding="utf-8"))
FETCHED = datetime.fromisoformat(DOC["fetchedAt"])
NOW = FETCHED + timedelta(hours=2)
BASE = "https://www.comune.collegno.to.it"
HOSTS = {"www.comune.collegno.to.it"}


class NoGeocoder:
    deferred: list = []
    requests = 0

    def reverse(self, *a, **k):
        return None

    def lookup(self, *a, **k):
        return None


class CollegnoGeocoder(NoGeocoder):
    """Centro di Collegno per ogni indirizzo: gli eventi del Mac arrivano senza coordinate e le prendono qui."""

    def lookup(self, *a, **k):
        return (45.08, 7.57)


def adapter(tmp_path, doc=None, name="collegno") -> FileSourceAdapter:
    if doc is not None:
        (tmp_path / f"{name}.json").write_text(json.dumps(doc), encoding="utf-8")
    return FileSourceAdapter(name, BASE, "Collegno", "TO", "Piemonte", None, tmp_path)


def ev(i: int = 0) -> dict:
    return copy.deepcopy(DOC["events"][i])


def events(tmp_path, doc=None, now=NOW, horizon=3650):
    return list(adapter(tmp_path, doc).events(None, now, horizon))


def test_dati_veri_del_mac_passano_senza_perdite(tmp_path):
    shutil.copy(FIX / "collegno.json", tmp_path)
    out = events(tmp_path)
    assert len(out) == len(DOC["events"]) == 3
    assert all(e["source"] == "scraper" and e["id"] == event_id(e["sourceUrl"]) for e in out)
    assert [e["startTime"] for e in out] == sorted(e["startTime"] for e in out)


def test_file_assente_scaduto_non_riuscito_o_di_un_altra_fonte_e_errore_della_fonte(tmp_path):
    with pytest.raises(httpx.HTTPError, match="assenti"):
        events(tmp_path)
    with pytest.raises(httpx.HTTPError, match="non freschi"):
        events(tmp_path, DOC, now=FETCHED + timedelta(hours=37))
    assert events(tmp_path, DOC, now=FETCHED + timedelta(hours=35))  # sotto le 36 ore va
    with pytest.raises(httpx.HTTPError, match="non freschi"):
        events(tmp_path, DOC, now=FETCHED - timedelta(hours=1))  # data nel futuro: orologio sbagliato
    with pytest.raises(httpx.HTTPError, match="non ha raggiunto"):
        events(tmp_path, DOC | {"ok": False, "error": "timeout", "events": []})
    with pytest.raises(httpx.HTTPError, match="non validi"):
        events(tmp_path, DOC | {"source": "altra"})
    with pytest.raises(httpx.HTTPError, match="non validi"):
        events(tmp_path, DOC | {"version": 99})
    (tmp_path / "collegno.json").write_text("{non json", encoding="utf-8")
    with pytest.raises(httpx.HTTPError, match="illeggibili"):
        list(adapter(tmp_path).events(None, NOW, 60))


def test_evento_su_host_estraneo_o_con_id_non_coerente_si_scarta(tmp_path):
    estraneo, id_falso, ok = ev(0), ev(1), ev(2)
    estraneo["sourceUrl"] = "https://altro.example/vivere-il-comune/eventi/x"
    estraneo["id"] = event_id(estraneo["sourceUrl"])
    id_falso["id"] = "00000000000000000000"
    out = events(tmp_path, DOC | {"events": [estraneo, id_falso, ok]})
    assert [e["id"] for e in out] == [ok["id"]]


def test_clean_event_ricostruisce_i_soli_campi_attesi_e_controlla_i_valori():
    raw = ev(0) | {"source": "manual", "removedAt": 1, "isAdmin": True, "imageUrl": "http://x.example/a.jpg",
                   "ticketUrl": "javascript:alert(1)", "tags": ["kids", "x"]}
    out = clean_event(raw, HOSTS)
    assert out["source"] == "scraper" and "removedAt" not in out and "isAdmin" not in out
    assert out["imageUrl"] == "" and out["ticketUrl"] == "" and out["tags"] == ["kids"]
    assert clean_event(ev(0) | {"category": "hack"}, HOSTS) is None
    assert clean_event(ev(0) | {"priceType": "gratis"}, HOSTS) is None
    assert clean_event(ev(0) | {"lat": 95.0, "lng": 10.0}, HOSTS) is None
    assert clean_event(ev(0) | {"lat": 45.0, "lng": None}, HOSTS) is None
    assert clean_event(ev(0) | {"lat": True, "lng": True}, HOSTS) is None
    assert clean_event(ev(0) | {"startTime": "domani"}, HOSTS) is None
    assert clean_event(ev(0) | {"endTime": ev(0)["startTime"] - 1}, HOSTS) is None
    assert clean_event(ev(0) | {"title": "   "}, HOSTS) is None
    assert clean_event(ev(0) | {"sourceUrl": "http://www.comune.collegno.to.it/x"}, HOSTS) is None
    assert clean_event("non un dict", HOSTS) is None
    assert len(clean_event(ev(0) | {"title": "x" * 5000}, HOSTS)["title"]) == 300


def test_finestra_e_tetto_per_fonte(tmp_path, monkeypatch):
    base = ev(0)
    many = []
    for i in range(MAX_EVENTS + 20):
        e = copy.deepcopy(base)
        e["sourceUrl"] = f"{BASE}/vivere-il-comune/eventi/e{i}"
        e["id"] = event_id(e["sourceUrl"])
        e["startTime"] = int(NOW.timestamp() * 1000) + (i + 1) * 3_600_000
        e["endTime"] = e["startTime"] + 3_600_000
        many.append(e)
    out = events(tmp_path, DOC | {"events": many}, horizon=3650)
    assert len(out) == MAX_EVENTS and out[0]["sourceUrl"].endswith("/e0")  # i più vicini nel tempo
    passato = copy.deepcopy(many[0]) | {"startTime": 1_700_000_000_000, "endTime": 1_700_003_600_000}
    assert events(tmp_path, DOC | {"events": [passato]}) == []  # finito: fuori finestra, non è un errore
    assert events(tmp_path, DOC | {"events": many[:1]}, horizon=0) == []  # oltre l'orizzonte


def test_with_file_sources_sostituisce_solo_le_fonti_comunali_dell_elenco(tmp_path):
    orig = SimpleNamespace(name="collegno", base=BASE, city="Collegno", province="TO", region="Piemonte", viewbox=None,
                           url_eventi=BASE + "/vivere-il-comune/eventi/")
    reg = SimpleNamespace(name="ert", base="https://x.example", city="X", province="BO", region="Emilia-Romagna", viewbox=None, regional=True)
    out = with_file_sources({"collegno": orig, "ert": reg, "altro": orig}, tmp_path, ["collegno", "ert", "non-attiva"])
    assert isinstance(out["collegno"], FileSourceAdapter) and out["collegno"].url_eventi == orig.url_eventi
    assert out["ert"] is reg and out["altro"] is orig and "non-attiva" not in out


def collect_with(tmp_path, monkeypatch, state):
    src = adapter(tmp_path)
    monkeypatch.setattr(run, "SOURCES", {"collegno": src})
    stats: dict = {}
    out = run.collect(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))), CollegnoGeocoder(), ["collegno"],
                      NOW, 3650, stats, [], None, state)
    return out, stats


def test_collect_dati_assenti_e_errore_della_fonte_e_non_parcheggia_l_host(tmp_path, monkeypatch):
    state: dict = {}
    out, stats = collect_with(tmp_path, monkeypatch, state)
    assert out == [] and "assenti" in stats["collegno"]["error"]
    assert state == {}  # nessun host parcheggiato: la rete non c'entra
    host = "www.comune.collegno.to.it"
    unreachable.fail(state, host, NOW.date(), "vecchio errore")
    state[host]["next"] = (NOW.date() + timedelta(days=5)).isoformat() if "next" in state[host] else None
    shutil.copy(FIX / "collegno.json", tmp_path)
    out, stats = collect_with(tmp_path, monkeypatch, state)  # host parcheggiato dal runner, ma la fonte legge il file
    assert stats["collegno"]["error"] is None and len(out) == 3


def test_collect_non_fa_richieste_di_rete(tmp_path, monkeypatch):
    shutil.copy(FIX / "collegno.json", tmp_path)
    calls = []
    src = adapter(tmp_path)
    monkeypatch.setattr(run, "SOURCES", {"collegno": src})
    client = httpx.Client(transport=httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(500)))
    out = run.collect(client, CollegnoGeocoder(), ["collegno"], NOW, 3650, {}, [], None, {})
    assert len(out) == 3 and calls == []
