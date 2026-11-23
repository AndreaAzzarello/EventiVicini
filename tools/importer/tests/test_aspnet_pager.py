"""#85: liste ASP.NET del Trentino-Alto Adige (form `aspnetForm`, pager con POST): seguite fino al tetto di pagine, con stop
anticipato, riletture dei dettagli ogni 3 giorni. Fixture reali anonimizzate in tests/fixtures/html/lana-aspnet/; nessuna rete."""

import re
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parents[1]))
import detailmemo  # noqa: E402
from adapters.design_comuni_html import (DesignComuniHtmlAdapter, _event_href, aspnet_pager, parse_detail,  # noqa: E402
                                         parse_list)
from detailmemo import DetailMemo  # noqa: E402
from fetch import Fetcher  # noqa: E402
from mapping import ROME  # noqa: E402

FIX = Path(__file__).parent / "fixtures" / "html" / "lana-aspnet"
BASE = "https://www.comune.lana.bz.it"
LIST = BASE + "/de/Dorfleben/Veranstaltungen"
DAY0 = date(2026, 11, 23)
LIST1 = (FIX / "lista-1.html").read_text(encoding="utf-8")
LIST2 = (FIX / "lista-2.html").read_text(encoding="utf-8")
DETAIL_ONR = (FIX / "dettaglio-detailonr.html").read_text(encoding="utf-8")


def at(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, 8, tzinfo=ROME)


def synthetic(n: int) -> str:
    """Pagina n+1 della lista: come lista-2 ma con link propri (uno slug per pagina)."""
    return re.sub(r'href="(/de/Dorfleben/Veranstaltungen/)([^"]+)"', lambda m: f'href="{m[1]}p{n}_{m[2]}"', LIST2)


def empty_list() -> str:
    return re.sub(r'<div class="bemVerticalCardContainer.*?(?=<div class="bemContainer bemContainer--pager")', "", LIST2, flags=re.S)


class Site:
    """Lana finta: lista (pager POST, `content_pages` pagine con eventi), dettagli con ETag, robots.txt."""

    def __init__(self, content_pages: int = 10, post_status: int = 200, disallow_post: bool = False, pager: bool = True):
        self.content_pages, self.post_status, self.disallow_post, self.pager = content_pages, post_status, disallow_post, pager
        self.hits: Counter = Counter()
        self.posts: list[dict] = []

    def handler(self, req: httpx.Request) -> httpx.Response:
        p = req.url.path
        self.hits[(req.method, p)] += 1
        if p == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nAllow: /\n" + ("Disallow: /system/web/\n" if self.disallow_post else ""))
        if req.method == "POST":
            if self.post_status != 200:
                return httpx.Response(self.post_status, text="")
            form = dict(httpx.QueryParams(req.content.decode()))
            self.posts.append(form)
            n = int(next(v for k, v in form.items() if k.startswith("pager-")))
            return httpx.Response(200, text=synthetic(n) if n < self.content_pages else empty_list())
        if p == "/de/Dorfleben/Veranstaltungen":
            body = LIST1 if self.pager else re.sub(r"<form.*?</form>", lambda m: re.sub(r'<input id="pager-.*', "", m[0], flags=re.S), LIST1, flags=re.S)
            return httpx.Response(200, text=body)
        if p == "/system/web/veranstaltung.aspx":
            return self.detail(req, DETAIL_ONR)
        if p.startswith("/de/Dorfleben/"):
            title = p.rsplit("/", 1)[-1]
            return self.detail(req, ('<html><head><script type="application/ld+json">{"@type":"Event","name":"%s",'
                                     '"startDate":"%sT20:00:00+01:00","endDate":"%sT22:00:00+01:00"}</script></head>'
                                     '<body><main><h1>%s</h1></main></body></html>') % (title, DAY0 + timedelta(days=10), DAY0 + timedelta(days=10), title))
        return httpx.Response(404, text="")

    @staticmethod
    def detail(req: httpx.Request, body: str) -> httpx.Response:
        etag = '"v1"'
        if req.headers.get("if-none-match") == etag:
            return httpx.Response(304)
        return httpx.Response(200, text=body, headers={"etag": etag})

    def adapter(self, cache_dir: Path | None, memo, **kw) -> DesignComuniHtmlAdapter:
        f = Fetcher(httpx.Client(transport=httpx.MockTransport(self.handler)), min_interval=0, backoff=0, cache_dir=cache_dir)
        return DesignComuniHtmlAdapter("lana", BASE, "Lana", "BZ", "Trentino-Alto Adige", None, LIST, fetcher=f, memo=memo, **kw)

    def detail_gets(self) -> int:
        return sum(v for (m, p), v in self.hits.items() if m == "GET" and p.startswith("/de/Dorfleben/") and p != "/de/Dorfleben/Veranstaltungen")


# --- pager -------------------------------------------------------------------------------------------

def test_aspnet_pager_legge_form_campi_e_numero_di_pagine():
    pg = aspnet_pager(LIST1, LIST)
    assert pg is not None
    assert pg.action == BASE + "/system/web/veranstaltung.aspx?menuonr=225001515&sprache=1"
    assert pg.pages == 10 and pg.pager.startswith("pager-")
    assert pg.fields["__VIEWSTATE"].startswith("FIXTURE-VIEWSTATE") and pg.fields[pg.pager] == "0"
    assert not any(k.startswith("d_category") for k in pg.fields)  # il <select multiple> non si invia


def test_aspnet_pager_none_senza_form_o_senza_pager():
    assert aspnet_pager("<html><body><ul class='pagination'><li><a rel='next' href='?p=2'>2</a></li></ul></body></html>", LIST) is None
    assert aspnet_pager(re.sub(r'<input type="hidden" name="pager.*', "", "<form id='aspnetForm'></form>"), LIST) is None


def test_event_href_accetta_solo_detailonr_come_query():
    host, here = "www.comune.lana.bz.it", "/de/Dorfleben/Veranstaltungen"
    ok = BASE + "/system/web/veranstaltung.aspx?detailonr=225818120&sprache=1&menuonr=225001515"
    assert _event_href(ok, host, here) == ok
    assert _event_href(BASE + "/de/Dorfleben/Veranstaltungen/x?utm=1", host, here) == ""
    assert _event_href(BASE + "/system/web/veranstaltung.aspx?menuonr=225001515&sprache=1", host, here) == ""


def test_lista_2_ha_link_nuovi_rispetto_alla_prima_pagina():
    today = DAY0
    l1, _ = parse_list(LIST1, LIST, today)
    l2, _ = parse_list(LIST2, LIST, today)
    assert l1 and l2 and not set(l1) & set(l2)
    assert any("detailonr" in u for u in l2)  # 2 dei link della pagina 2 hanno la forma veranstaltung.aspx?detailonr=


# --- _list_urls --------------------------------------------------------------------------------------

def list_urls(site: Site, tmp_path, **kw):
    ad = site.adapter(tmp_path, DetailMemo(None), **kw)
    return ad._list_urls(ad.fetcher, at(DAY0), None)


def test_pager_seguito_fino_al_tetto_di_5_pagine_con_4_post(tmp_path):
    s = Site(content_pages=10)
    urls, _, paged = list_urls(s, tmp_path)
    assert paged and len(s.posts) == 4  # pagine 2..5 (il pager ne annuncia 10)
    assert [int(next(v for k, v in f.items() if k.startswith("pager-"))) for f in s.posts] == [1, 2, 3, 4]
    assert all(f["__VIEWSTATE"] for f in s.posts) and all(not any(k.startswith("d_category") for k in f) for f in s.posts)
    first, _ = parse_list(LIST1, LIST, DAY0)
    assert urls[: len(first)] == first  # gli eventi della prima pagina restano gli stessi, nello stesso ordine
    assert len(urls) == len(set(urls)) > len(first) * 4


def test_stop_anticipato_alla_prima_pagina_senza_eventi(tmp_path):
    s = Site(content_pages=3)  # pager=1,2 con eventi; pager=3 vuoto
    urls, _, paged = list_urls(s, tmp_path)
    assert len(s.posts) == 3 and paged  # la terza risposta è vuota: ci si ferma lì, senza chiedere le pagine 5
    assert not any("p3_" in u for u in urls)


def test_errore_http_al_post_conserva_la_prima_pagina(tmp_path):
    s = Site(post_status=403)
    urls, _, _ = list_urls(s, tmp_path)
    assert urls == parse_list(LIST1, LIST, DAY0)[0]
    assert sum(1 for (m, _), v in s.hits.items() if m == "POST") == 1  # un solo tentativo: 403 non si ripete e non si insiste


def test_robots_che_vieta_il_post_non_fa_nessuna_richiesta(tmp_path):
    s = Site(disallow_post=True)
    urls, _, _ = list_urls(s, tmp_path)
    assert urls == parse_list(LIST1, LIST, DAY0)[0]
    assert not any(m == "POST" for (m, _) in s.hits)


def test_senza_pager_nessun_post_e_nessuna_rilettura_diradata(tmp_path):
    s = Site(pager=False)
    urls, _, paged = list_urls(s, tmp_path)
    assert not paged and not s.posts and urls == parse_list(s.handler(httpx.Request("GET", LIST)).text, LIST, DAY0)[0]


# --- sitemapindex (invariato rispetto alla #86) ------------------------------------------------------

def test_sitemapindex_senza_eventi_si_salta_7_giorni_poi_si_ricontrolla():
    idx = (FIX / "sitemapindex.xml").read_text(encoding="utf-8")
    child = (FIX / "sitemap_3.xml").read_text(encoding="utf-8")
    calls: Counter = Counter()

    def handler(req: httpx.Request) -> httpx.Response:
        calls[req.url.path] += 1
        if req.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nAllow: /\nSitemap: " + BASE + "/sitemap.xml")
        return httpx.Response(200, text=idx if req.url.path == "/sitemap.xml" else child)

    f = Fetcher(httpx.Client(transport=httpx.MockTransport(handler)), min_interval=0, backoff=0)
    ad = DesignComuniHtmlAdapter("lana", BASE, "Lana", "BZ", "Trentino-Alto Adige", None, LIST, fetcher=f)
    memo = DetailMemo(None)
    path = "/de/Dorfleben/Veranstaltungen"
    assert ad._sitemap_urls(f, path, memo, DAY0) == []          # le figlie sono solo navigazione: nessun URL evento
    assert calls["/sitemap.xml"] == 1 and memo.sitemap_skipped(BASE + "/sitemap.xml", DAY0 + timedelta(days=1))
    assert ad._sitemap_urls(f, path, memo, DAY0 + timedelta(days=3)) == [] and calls["/sitemap.xml"] == 1  # saltata
    assert ad._sitemap_urls(f, path, memo, DAY0 + timedelta(days=8)) == [] and calls["/sitemap.xml"] == 2  # all'8° giorno si ricontrolla


# --- id dei dettagli raggiunti da detailonr ----------------------------------------------------------

ONR = BASE + "/system/web/veranstaltung.aspx?detailonr=225818120&sprache=1&menuonr=225001515"


def test_detailonr_con_canonical_usa_il_canonical_come_url_e_id():
    d = parse_detail(DETAIL_ONR, ONR, DAY0)
    assert d is not None and d["url"] == BASE + "/de/Dorfleben/Sterntaler_Weihnachtsmarkt_-_Gastronomiestaende"


def test_detailonr_senza_canonical_normalizza_l_url():
    page = re.sub(r'<link rel="canonical"[^>]*>', "", DETAIL_ONR)
    other = BASE + "/system/web/veranstaltung.aspx?menuonr=999&sprache=2&detailonr=225818120"
    a, b = parse_detail(page, ONR, DAY0), parse_detail(page, other, DAY0)
    assert a["url"] == b["url"] == BASE + "/system/web/veranstaltung.aspx?detailonr=225818120"  # stesso evento, stesso id


# --- riletture ogni 3 giorni -------------------------------------------------------------------------

def run_days(s: Site, tmp_path, days: int, **kw):
    memo = DetailMemo(tmp_path / "m.json")
    out, gets = [], []
    for d in range(days):
        before = s.detail_gets()
        out.append(list(s.adapter(tmp_path / "cache", memo, max_details=80, **kw).events(None, at(DAY0 + timedelta(days=d)), 60)))
        gets.append(s.detail_gets() - before)
    return out, gets


def test_in_reread_slot_e_deterministico_e_copre_i_3_giorni():
    url = BASE + "/de/Dorfleben/Veranstaltungen/x"
    slots = [detailmemo.in_reread_slot(url, DAY0 + timedelta(days=i), 3) for i in range(3)]
    assert slots.count(True) == 1 and slots == [detailmemo.in_reread_slot(url, DAY0 + timedelta(days=i), 3) for i in range(3)]


def test_dettagli_futuri_riletti_ogni_3_giorni_con_pager(tmp_path):
    s = Site(content_pages=10)
    out, gets = run_days(s, tmp_path, 4)
    n = len(out[0])
    assert n > 30 and gets[0] >= n  # primo giorno: nessuna cache, si legge tutto
    assert sum(gets[1:4]) == n and max(gets[1:4]) < n  # nei 3 giorni successivi ogni dettaglio è riletto una volta sola
    assert all(len(day) == n for day in out)           # nessun evento perso nei giorni "dalla cache"


def test_senza_pager_i_dettagli_si_rileggono_ogni_giorno(tmp_path):
    s = Site(pager=False)
    out, gets = run_days(s, tmp_path, 3)
    assert gets[1] >= len(out[1]) > 0 and gets[2] >= len(out[2])


def test_evento_dalla_cache_identico_a_quello_letto_dalla_rete(tmp_path):
    s = Site(content_pages=10)
    out, gets = run_days(s, tmp_path, 3)
    assert gets[1] < len(out[0])  # il giorno 1 una parte è ricostruita dal corpo in .httpcache, senza richiesta
    net = {e["id"]: e for e in out[0]}
    for day in out[1:]:
        for e in day:
            assert e == net[e["id"]]  # stessi campi, id compreso


def test_tetto_di_richieste_rispettato(tmp_path):
    s = Site(content_pages=10)
    _, gets = run_days(s, tmp_path, 1)
    assert sum(1 for (m, _) in s.hits.elements() if m == "POST") <= 4 and gets[0] <= 80
    assert Counter(m for (m, _), v in s.hits.items() for _ in range(v))["POST"] == 4
