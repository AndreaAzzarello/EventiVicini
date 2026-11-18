"""#81: l'adapter salta i dettagli di eventi finiti, ruota il 5%, riusa gli slot liberati, esplora la coda della sitemap
e non perde eventi futuri. Sito finto su httpx.MockTransport: nessuna rete."""

import logging
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import detailmemo  # noqa: E402
import run  # noqa: E402
from adapters.design_comuni_html import MAX_DETAILS, TAIL_PER_DAY, DesignComuniHtmlAdapter  # noqa: E402
from detailmemo import DetailMemo  # noqa: E402
from fetch import Fetcher  # noqa: E402
from mapping import ROME  # noqa: E402

DAY0 = date(2026, 11, 18)


def at(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, 10, tzinfo=ROME)


def page(start: date, end: date | None = None) -> str:
    end = end or start
    return ('<html><head><script type="application/ld+json">{"@type":"Event","name":"Evento","startDate":"%sT20:00:00+01:00",'
            '"endDate":"%sT22:00:00+01:00"}</script></head><body><main><h1>Evento</h1></main></body></html>' % (start, end))


class Site:
    """Comune finto: dettagli /eventi/e<n> con la loro data, lista con alcuni link (opzionalmente datati), sitemap per lastmod decrescente."""

    def __init__(self):
        self.details: dict[str, tuple[date, date]] = {}
        self.listed: dict[str, str] = {}      # path → testo della data nella card ("" = card senza data)
        self.sitemap: list[str] = []          # path in ordine di lastmod decrescente
        self.sitemap_body: str | None = None  # per forzare un sitemapindex
        self.hits: Counter = Counter()

    def add(self, n: int, start: date, end: date | None = None, *, listed: str | None = None, sitemap: bool = True) -> str:
        path = f"/eventi/e{n}"
        self.details[path] = (start, end or start)
        if listed is not None:
            self.listed[path] = listed
        if sitemap:
            self.sitemap.append(path)
        return "https://x.it" + path

    def handler(self, req: httpx.Request) -> httpx.Response:
        p = req.url.path
        self.hits[p] += 1
        if p == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nAllow: /\nSitemap: https://x.it/sitemap.xml")
        if p == "/sitemap.xml":
            body = self.sitemap_body or "<urlset>" + "".join(
                f"<url><loc>https://x.it{u}</loc><lastmod>{10000 - i:05d}</lastmod></url>" for i, u in enumerate(self.sitemap)) + "</urlset>"
            return httpx.Response(200, text=body)
        if p == "/eventi/":
            cards = "".join(f'<article><a href="https://x.it{u}">x</a>' + (f'<span class="data_num">{d}</span>' if d else "") + "</article>"
                            for u, d in self.listed.items())
            return httpx.Response(200, text=f"<html><body>{cards}</body></html>")
        if p in self.details:
            return httpx.Response(200, text=page(*self.details[p]))
        return httpx.Response(404, text="")

    def adapter(self, memo, **kw) -> DesignComuniHtmlAdapter:
        f = Fetcher(httpx.Client(transport=httpx.MockTransport(self.handler)), min_interval=0, backoff=0)
        return DesignComuniHtmlAdapter("x", "https://x.it", "X", "BO", "Emilia-Romagna", None, "https://x.it/eventi/",
                                       fetcher=f, memo=memo, **kw)

    def run_day(self, memo, day: date, **kw) -> tuple[list[dict], Counter]:
        before = Counter(self.hits)
        evs = list(self.adapter(memo, **kw).events(None, at(day), 60))
        return evs, Counter({k: v - before[k] for k, v in self.hits.items() if v - before[k]})


def detail_gets(delta: Counter) -> int:
    return sum(v for k, v in delta.items() if k.startswith("/eventi/e"))


def finished_site(n_finished: int, n_future: int = 0, future_at: int | None = None) -> Site:
    """n_finished passati in cima alla sitemap; i futuri in coda (da future_at) o subito dopo i passati."""
    s = Site()
    for i in range(n_finished):
        s.add(i, date(2026, 10, 1) + timedelta(days=i % 20))
    for j in range(n_future):
        s.add(1000 + j, DAY0 + timedelta(days=5 + j))
    if future_at is not None:  # sposta i futuri alla posizione indicata
        fut = [u for u in s.sitemap if int(u.rsplit("e", 1)[1]) >= 1000]
        rest = [u for u in s.sitemap if int(u.rsplit("e", 1)[1]) < 1000]
        s.sitemap = rest[:future_at] + fut + rest[future_at:]
    return s


def test_primo_giro_senza_memoria_legge_come_prima_il_tetto_resta_40(tmp_path):
    s = finished_site(60)
    memo = DetailMemo(tmp_path / "m.json")
    evs, d = s.run_day(memo, DAY0)
    assert evs == [] and detail_gets(d) == MAX_DETAILS  # la finestra riempie il tetto: la coda aspetta i posti liberati
    assert memo.counters["x"]["tail_left"] == 20
    _, d2 = s.run_day(memo, DAY0 + timedelta(days=1))   # il giorno dopo la finestra è quasi tutta saltata: i posti vanno alla coda
    assert TAIL_PER_DAY <= detail_gets(d2) <= TAIL_PER_DAY + 4 and memo.counters["x"]["tail_left"] == 20 - TAIL_PER_DAY


def test_dettagli_finiti_saltati_e_slot_liberati_ai_futuri_della_coda(tmp_path):
    s = finished_site(60, n_future=5, future_at=50)  # 5 futuri in sitemap, oltre la finestra e oltre i primi 5 della coda
    memo = DetailMemo(tmp_path / "m.json")
    seen_future: set[str] = set()
    for n in range(4):
        memo.save(DAY0 + timedelta(days=n))
        memo = DetailMemo(tmp_path / "m.json")  # la memoria passa da un giro all'altro solo da disco
        evs, d = s.run_day(memo, DAY0 + timedelta(days=n))
        assert detail_gets(d) <= MAX_DETAILS
        if n >= 1:
            assert detail_gets(d) <= TAIL_PER_DAY + 4   # finestra quasi tutta saltata: restano coda e rotazione (5% di 40 ≈ 2)
        seen_future |= {e["sourceUrl"] for e in evs}
    assert seen_future == {f"https://x.it/eventi/e{1000 + j}" for j in range(5)}  # i futuri in coda vengono trovati


def test_rotazione_ogni_finito_della_finestra_riletto_una_volta_ogni_20_giorni(tmp_path):
    s = finished_site(MAX_DETAILS)
    memo = DetailMemo(tmp_path / "m.json")
    s.run_day(memo, DAY0)  # giro di riempimento: tutti sconosciuti, tutti letti
    per_url: Counter = Counter()
    for n in range(1, 21):  # 20 giorni consecutivi
        before = Counter(s.hits)
        s.run_day(memo, DAY0 + timedelta(days=n))
        per_url.update({u: s.hits[u] - before[u] for u in s.details if s.hits[u] - before[u]})
    assert set(per_url) == set(s.details) and set(per_url.values()) == {1}


def test_stesso_giorno_stesso_insieme(tmp_path):
    s = finished_site(MAX_DETAILS)
    memo = DetailMemo(tmp_path / "m.json")
    s.run_day(memo, DAY0)
    day = DAY0 + timedelta(days=3)
    _, a = s.run_day(memo, day)
    _, b = s.run_day(memo, day)
    assert {k for k in a if k.startswith("/eventi/e")} == {k for k in b if k.startswith("/eventi/e")}


def test_soglia_due_giorni_nel_giro_completo(tmp_path):
    """Finito da 3 giorni: saltato. Finito ieri: riletto (margine di 2 giorni). Scelti due URL fuori dalla rotazione di oggi."""
    free = [n for n in range(200) if not detailmemo.in_rotation(f"https://x.it/eventi/e{n}", DAY0)]
    old, recent = free[0], free[1]
    s = Site()
    s.add(old, DAY0 - timedelta(days=3))
    s.add(recent, DAY0 - timedelta(days=1))
    memo = DetailMemo(tmp_path / "m.json")
    memo.record(f"https://x.it/eventi/e{old}", int(datetime(2026, 11, 15, 22, tzinfo=ROME).timestamp() * 1000), DAY0)
    memo.record(f"https://x.it/eventi/e{recent}", int(datetime(2026, 11, 17, 22, tzinfo=ROME).timestamp() * 1000), DAY0)
    _, d = s.run_day(memo, DAY0)
    assert d.get(f"/eventi/e{old}", 0) == 0 and d.get(f"/eventi/e{recent}", 0) == 1


def test_nessun_futuro_perso_rispetto_al_giro_completo(tmp_path):
    """Stessi input, giro senza memoria (come prima) e giro con la memoria del giorno prima: i futuri del primo sono tutti nel secondo."""
    s = Site()
    for i in range(70):  # passati e futuri mescolati, anche oltre la finestra
        s.add(i, (DAY0 + timedelta(days=4 + i)) if i % 7 == 0 else date(2026, 9, 1) + timedelta(days=i % 30))
    reference, _ = s.run_day(None, DAY0 + timedelta(days=1))  # senza memoria: i primi MAX_DETAILS, come prima della modifica
    memo = DetailMemo(tmp_path / "m.json")
    s.run_day(memo, DAY0)
    memo.save(DAY0)
    memo = DetailMemo(tmp_path / "m.json")
    with_memo, d = s.run_day(memo, DAY0 + timedelta(days=1))
    assert {e["sourceUrl"] for e in reference} <= {e["sourceUrl"] for e in with_memo}
    assert detail_gets(d) < MAX_DETAILS


def test_stesso_url_con_date_aggiornate_ripreso_dalla_rotazione(tmp_path):
    s = Site()
    url = s.add(1, date(2026, 10, 1))  # all'inizio una pagina passata
    memo = DetailMemo(tmp_path / "m.json")
    assert s.run_day(memo, DAY0)[0] == []
    s.details["/eventi/e1"] = (DAY0 + timedelta(days=10), DAY0 + timedelta(days=10))  # il Comune riusa l'URL con date nuove
    rot_day = next(DAY0 + timedelta(days=n) for n in range(1, 21) if detailmemo.in_rotation(url, DAY0 + timedelta(days=n)))
    for n in range(1, (rot_day - DAY0).days):
        assert s.run_day(memo, DAY0 + timedelta(days=n))[0] == []  # prima del suo giorno la memoria lo dà per finito
    evs, _ = s.run_day(memo, rot_day)
    assert [e["sourceUrl"] for e in evs] == [url]


def test_stesso_url_con_date_aggiornate_ripreso_subito_se_la_lista_lo_mostra_con_data(tmp_path):
    s = Site()
    url = s.add(1, date(2026, 10, 1))
    memo = DetailMemo(tmp_path / "m.json")
    s.run_day(memo, DAY0)
    s.details["/eventi/e1"] = (DAY0 + timedelta(days=10), DAY0 + timedelta(days=10))
    s.listed["/eventi/e1"] = "28 novembre 2026"  # la card della lista porta la data nuova
    day = next(DAY0 + timedelta(days=n) for n in range(1, 21) if not detailmemo.in_rotation(url, DAY0 + timedelta(days=n)))
    evs, _ = s.run_day(memo, day)
    assert [e["sourceUrl"] for e in evs] == [url]


def test_card_senza_data_non_e_un_link_datato(tmp_path):
    s = Site()
    url = s.add(1, date(2026, 10, 1), listed="")
    memo = DetailMemo(tmp_path / "m.json")
    s.run_day(memo, DAY0)
    day = next(DAY0 + timedelta(days=n) for n in range(1, 21) if not detailmemo.in_rotation(url, DAY0 + timedelta(days=n)))
    _, d = s.run_day(memo, day)
    assert d.get("/eventi/e1", 0) == 0


def test_saltato_perche_finito_non_conta_come_sparito():
    """missingRuns: un evento finito (non letto oggi) non è «sparito dalla fonte»; uno ancora futuro e non visto sì."""
    now_ms = int(at(DAY0).timestamp() * 1000)
    host = "https://x.it"
    docs = {
        "finito": {"source": "scraper", "sourceUrl": f"{host}/eventi/e1", "startTime": now_ms - 9 * 86_400_000,
                   "endTime": now_ms - 8 * 86_400_000, "missingRuns": 0},
        "futuro": {"source": "scraper", "sourceUrl": f"{host}/eventi/e2", "startTime": now_ms + 86_400_000,
                   "endTime": now_ms + 2 * 86_400_000, "missingRuns": 0},
    }
    stale = run.stale_updates(docs, set(), {"x.it"}, now_ms, 60 * 86_400_000)
    assert "finito" not in stale and stale["futuro"] == {"missingRuns": 1}
    plan = run.plan_writes([], docs, {"x.it"}, now_ms, 60 * 86_400_000)
    assert "finito" not in plan["stale"]
    assert docs["finito"]["missingRuns"] == 0


def test_log_per_fonte_e_per_regione(tmp_path, caplog):
    s = finished_site(60)
    memo = DetailMemo(tmp_path / "m.json")
    s.run_day(memo, DAY0)
    with caplog.at_level(logging.INFO, logger="importer"):
        s.run_day(memo, DAY0 + timedelta(days=1))
    m = [r.getMessage() for r in caplog.records if "dettagli saltati (finiti)" in r.getMessage()]
    assert len(m) == 1 and m[0].startswith("x: dettagli saltati (finiti): ") and "riletti a rotazione: " in m[0] and "coda da esplorare: " in m[0]
    c = memo.counters["x"]
    assert f"saltati (finiti): {c['skipped']}, riletti a rotazione: {c['rotated']}, coda da esplorare: {c['tail_left']}" in m[0]
    assert memo.summary({"x": "Emilia-Romagna"})["Emilia-Romagna"]["skipped"] == c["skipped"]


def test_seme_dalla_cache_http_senza_rete(tmp_path):
    """Siti con ETag: il corpo già in .httpcache riempie la memoria senza richieste, e un finito non si rilegge."""
    s = Site()
    url = s.add(1, date(2026, 10, 1))
    f = Fetcher(httpx.Client(transport=httpx.MockTransport(s.handler)), min_interval=0, backoff=0, cache_dir=tmp_path / "cache")
    f._store(url, httpx.Response(200, text=page(date(2026, 10, 1)), headers={"etag": "abc"}))
    memo = DetailMemo(tmp_path / "m.json")
    day = next(DAY0 + timedelta(days=n) for n in range(0, 20) if not detailmemo.in_rotation(url, DAY0 + timedelta(days=n)))
    a = DesignComuniHtmlAdapter("x", "https://x.it", "X", "BO", "Emilia-Romagna", None, "https://x.it/eventi/", fetcher=f, memo=memo)
    assert list(a.events(None, at(day), 60)) == []
    assert memo.known(url) and s.hits["/eventi/e1"] == 0


def test_errore_temporaneo_non_marca_la_pagina_come_senza_data(tmp_path):
    s = Site()
    s.add(1, DAY0 + timedelta(days=3))
    ok = s.handler

    def flaky(req):
        return httpx.Response(503, text="") if req.url.path == "/eventi/e1" else ok(req)
    f = Fetcher(httpx.Client(transport=httpx.MockTransport(flaky)), min_interval=0, backoff=0, retries=0)
    memo = DetailMemo(tmp_path / "m.json")
    a = DesignComuniHtmlAdapter("x", "https://x.it", "X", "BO", "Emilia-Romagna", None, "https://x.it/eventi/", fetcher=f, memo=memo)
    assert list(a.events(None, at(DAY0), 60)) == [] and not memo.known("https://x.it/eventi/e1")  # riprova domani
    assert s.run_day(memo, DAY0 + timedelta(days=1))[0][0]["sourceUrl"] == "https://x.it/eventi/e1"


def test_pagina_404_ricordata_e_in_coda_non_si_riprova(tmp_path):
    s = Site()
    for i in range(MAX_DETAILS):
        s.add(i, date(2026, 10, 1))
    s.sitemap.append("/eventi/tolta")  # in sitemap ma 404, oltre la finestra
    memo = DetailMemo(tmp_path / "m.json")
    s.run_day(memo, DAY0)
    s.run_day(memo, DAY0 + timedelta(days=1))  # il giorno dopo i posti liberati arrivano alla coda
    assert memo.known("https://x.it/eventi/tolta") and memo.ended_ms("https://x.it/eventi/tolta") is None
    day = next(DAY0 + timedelta(days=n) for n in range(1, 21) if not detailmemo.in_rotation("https://x.it/eventi/tolta", DAY0 + timedelta(days=n)))
    before = s.hits["/eventi/tolta"]
    s.run_day(memo, day if day > DAY0 + timedelta(days=1) else DAY0 + timedelta(days=2))
    assert s.hits["/eventi/tolta"] == before


def test_sitemap_senza_url_utili_saltata_per_7_giorni_se_la_lista_ha_link(tmp_path):
    s = Site()
    s.add(1, DAY0 + timedelta(days=45), listed="", sitemap=False)  # un link in lista (futuro per tutto il test)
    s.sitemap_body = "<sitemapindex><sitemap><loc>https://x.it/sitemap_3.xml</loc></sitemap></sitemapindex>"
    memo = DetailMemo(tmp_path / "m.json")
    fetched = [s.run_day(memo, DAY0 + timedelta(days=n))[1].get("/sitemap.xml", 0) for n in range(10)]
    assert fetched == [1, 0, 0, 0, 0, 0, 0, 0, 1, 0]  # letta il giorno 0, saltata 7 giorni, riletta all'8°
    assert memo.counters["x"]["gets"] == 1


def test_sitemap_con_lista_vuota_si_legge_sempre(tmp_path):
    s = Site()
    s.sitemap_body = "<sitemapindex></sitemapindex>"
    memo = DetailMemo(tmp_path / "m.json")
    assert [s.run_day(memo, DAY0 + timedelta(days=n))[1].get("/sitemap.xml", 0) for n in range(3)] == [1, 1, 1]


def test_senza_memoria_comportamento_di_prima(tmp_path):
    """memo=None e nessuna cache su disco: si leggono i primi MAX_DETAILS, niente coda."""
    s = finished_site(60)
    evs, d = s.run_day(None, DAY0)
    assert detail_gets(d) == MAX_DETAILS and evs == []


def test_tetto_richieste_mai_superato(tmp_path):
    s = finished_site(10, n_future=100)  # molti futuri: i GET restano ≤ MAX_DETAILS
    memo = DetailMemo(tmp_path / "m.json")
    for n in range(6):
        _, d = s.run_day(memo, DAY0 + timedelta(days=n))
        assert detail_gets(d) <= MAX_DETAILS
