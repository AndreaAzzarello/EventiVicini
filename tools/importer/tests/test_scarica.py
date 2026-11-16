"""scarica.py: un file per fonte con eventi grezzi, errori isolati, elenco del Mac coerente col registro."""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx

sys.path.insert(0, str(Path(__file__).parents[1]))
import run  # noqa: E402
import scarica  # noqa: E402
from adapters import SOURCES  # noqa: E402

NOW = datetime(2026, 11, 12, 5, 0, tzinfo=timezone.utc)


def src(events=None, exc=None, regional=False):
    def gen(client, now, horizon):
        if exc:
            raise exc
        yield from events or []
    return SimpleNamespace(base="https://www.comune.example.it", regional=regional, events=gen)


def client():
    return httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))


def test_elenco_del_mac_ha_solo_fonti_attive_non_regionali_e_senza_doppioni():
    names = scarica.read_list()
    assert names and len(names) == len(set(names))
    assert [n for n in names if n not in SOURCES] == []
    assert [n for n in names if getattr(SOURCES[n], "regional", False)] == []


def test_read_list_ignora_commenti_righe_vuote_e_doppioni(tmp_path):
    f = tmp_path / "l.txt"
    f.write_text("# titolo\n\nfondi  # nota\nrieti\nfondi\n", encoding="utf-8")
    assert scarica.read_list(f) == ["fondi", "rieti"]


def test_un_file_per_fonte_con_eventi_grezzi_e_ora(monkeypatch, tmp_path):
    ev = {"id": "e1", "title": "Sagra", "startTime": 1, "_geocode": ["Via Roma, X"], "_place": {"city": "X"}}
    monkeypatch.setattr(run, "SOURCES", {"x": src([ev])})
    res = scarica.download(["x"], tmp_path, client(), NOW, 60)
    assert res == {"x": {"events": 1, "error": None}}
    doc = json.loads((tmp_path / "x.json").read_text(encoding="utf-8"))
    assert doc["ok"] and doc["events"] == [ev] and doc["fetchedAt"] == NOW.isoformat() and doc["host"] == "www.comune.example.it"
    assert not list(tmp_path.glob("*.tmp"))


def test_errore_di_una_fonte_non_ferma_le_altre_e_non_lascia_eventi(monkeypatch, tmp_path):
    monkeypatch.setattr(run, "SOURCES", {"giu": src(exc=httpx.ConnectTimeout("timeout")), "bug": src(exc=ValueError("pagina strana")),
                                         "ok": src([{"id": "e"}])})
    res = scarica.download(["giu", "bug", "ok"], tmp_path, client(), NOW, 60)
    assert res["giu"]["error"] and res["bug"]["error"] and res["ok"] == {"events": 1, "error": None}
    bad = json.loads((tmp_path / "giu.json").read_text(encoding="utf-8"))
    assert bad["ok"] is False and bad["events"] == []


def test_nome_sconosciuto_o_regionale_non_si_scarica(monkeypatch, tmp_path):
    monkeypatch.setattr(run, "SOURCES", {"reg": src([{"id": "e"}], regional=True)})
    res = scarica.download(["reg", "boh"], tmp_path, client(), NOW, 60)
    assert all(r["error"] for r in res.values()) and not list(tmp_path.glob("*.json"))


def test_main_esce_1_solo_se_nessuna_fonte_riesce(monkeypatch, tmp_path):
    lst = tmp_path / "l.txt"
    lst.write_text("a\nb\n", encoding="utf-8")
    monkeypatch.setattr(run, "SOURCES", {"a": src(exc=httpx.ConnectTimeout("t")), "b": src([{"id": "e"}])})
    assert scarica.main(["--list", str(lst), "--out", str(tmp_path / "o")]) == 0
    monkeypatch.setattr(run, "SOURCES", {"a": src(exc=httpx.ConnectTimeout("t")), "b": src(exc=httpx.ConnectTimeout("t"))})
    assert scarica.main(["--list", str(lst), "--out", str(tmp_path / "o2")]) == 1
    run.httpfetch.DEFAULT_GATE = None


def test_fonte_bloccata_oltre_il_tetto_va_in_errore_e_le_altre_proseguono(monkeypatch, tmp_path):
    import time

    def slow(clt, now, horizon):
        for _ in range(3):
            time.sleep(0.02)
            clt.get("https://www.comune.example.it/")
            yield {"id": "x"}

    monkeypatch.setattr(run, "SOURCES", {"lenta": SimpleNamespace(base="https://www.comune.example.it", regional=False, events=slow),
                                         "ok": src([{"id": "e"}])})
    res = scarica.download(["lenta", "ok"], tmp_path, client(), NOW, 60, budget=0.01)
    assert "saltata" in res["lenta"]["error"] and res["ok"] == {"events": 1, "error": None}
    assert json.loads((tmp_path / "lenta.json").read_text(encoding="utf-8"))["events"] == []


def test_tetto_per_fonte_del_mac_e_di_3_minuti():
    assert scarica.SOURCE_BUDGET == 180


def _doc(urls, ok=True, end=NOW.timestamp() * 1000 + 86_400_000):
    return {"ok": ok, "events": [{"sourceUrl": u, "startTime": end - 3600_000, "endTime": end} for u in urls]}


def _write(d, name, doc):
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.json").write_text(json.dumps(doc), encoding="utf-8")


def test_candidati_solo_eventi_non_finiti_spariti_da_una_fonte_riuscita_oggi_e_ieri(tmp_path):
    out, state = tmp_path / "out", tmp_path / "state"
    now_ms = int(NOW.timestamp() * 1000)
    _write(state, "a", _doc(["https://a/1", "https://a/2"]))
    _write(out, "a", _doc(["https://a/1"]))  # a/2 è sparito
    _write(state, "finito", _doc(["https://f/1"], end=now_ms - 1000))
    _write(out, "finito", _doc([]))  # sparito ma già finito: non serve controllarlo
    _write(state, "ko", _doc(["https://k/1"]))
    _write(out, "ko", _doc([], ok=False))  # fonte fallita oggi: non si sa cosa sia sparito
    _write(out, "nuova", _doc(["https://n/1"]))  # nessun riferimento di ieri
    cands, today = scarica.gone_candidates(state, out, ["a", "finito", "ko", "nuova"], now_ms)
    assert cands == ["https://a/2"] and today == {"https://a/1", "https://n/1"}


def test_esiti_certi_in_liveness_json_e_stato_aggiornato_solo_per_le_fonti_riuscite(tmp_path):
    out, state = tmp_path / "out", tmp_path / "state"
    _write(state, "a", _doc(["https://a.it/vivo", "https://a.it/via", "https://a.it/boh"]))
    _write(out, "a", _doc([]))
    _write(state, "ko", _doc(["https://k/1"]))
    _write(out, "ko", _doc([], ok=False))

    def handler(req):
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        return {"/vivo": httpx.Response(200, text="ok"), "/via": httpx.Response(404)}.get(req.url.path, httpx.Response(403))
    c = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
    res = scarica.check_gone(out, state, ["a", "ko"], c, NOW)
    assert res == {"https://a.it/vivo": "online", "https://a.it/via": "gone"}  # 403 = dubbio: non si scrive
    written = json.loads((out / "_liveness.json").read_text(encoding="utf-8"))
    assert written["results"] == res and written["checkedAt"] == NOW.isoformat()
    scarica.save_state(out, state, ["a", "ko"])
    assert json.loads((state / "a.json").read_text(encoding="utf-8"))["events"] == []
    assert len(json.loads((state / "ko.json").read_text(encoding="utf-8"))["events"]) == 1  # il riferimento di ieri resta
