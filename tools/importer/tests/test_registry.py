import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from adapters import load_sources  # noqa: E402
from build_registry import merge, parse_ipa, parse_istat  # noqa: E402
from detect_cms import Blocked, Fetcher, apply, cms_of, detect, find_link, is_open, license_of, vendor_of  # noqa: E402
from registry import COLUMNS, base_url, read_rows, write_rows  # noqa: E402


def row(**kw):
    return {c: "" for c in COLUMNS} | kw


# --- registry ---

def test_round_trip_bom_e_separatore(tmp_path):
    p = tmp_path / "sub" / "c.csv"
    rows = [row(regione="Emilia-Romagna", provincia="MO", comune="Modena", note="a;b è"),
            row(regione="Emilia-Romagna", provincia="BO", comune="Bologna")]
    write_rows(rows, p)
    raw = p.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    assert raw.decode("utf-8-sig").splitlines()[0] == ";".join(COLUMNS)
    back = read_rows(p)
    assert [r["comune"] for r in back] == ["Bologna", "Modena"]  # ordinato
    assert back[1]["note"] == "a;b è"


def test_un_file_per_regione(tmp_path):
    rows = [row(regione="Emilia-Romagna", provincia="MO", comune="Modena"),
            row(regione="Friuli-Venezia Giulia", provincia="TS", comune="Trieste"),
            row(regione="Emilia-Romagna", provincia="BO", comune="Bologna")]
    write_rows(rows, tmp_path)
    assert sorted(f.name for f in tmp_path.iterdir()) == ["emilia-romagna.csv", "friuli-venezia-giulia.csv"]
    assert [r["comune"] for r in read_rows(tmp_path / "emilia-romagna.csv")] == ["Bologna", "Modena"]
    assert {r["comune"] for r in read_rows(tmp_path)} == {"Modena", "Bologna", "Trieste"}


def test_registro_reale_un_file_per_regione():
    from registry import SOURCES_DIR

    assert not (SOURCES_DIR / "comuni.csv").exists()
    for f in SOURCES_DIR.glob("*.csv"):
        assert {slug for slug in (__import__("geo").slugify(r["regione"]) for r in read_rows(f))} == {f.stem}


def test_read_rows_file_assente(tmp_path):
    assert read_rows(tmp_path / "no.csv") == []


@pytest.mark.parametrize("sito, out", [
    ("www.comune.x.it/it", "https://www.comune.x.it"),
    ("  http://WWW.Comune.X.it/a/b?q=1 ", "http://www.comune.x.it"),
    ("", ""),
])
def test_base_url(sito, out):
    assert base_url(sito) == out


# --- build_registry ---

ISTAT = (
    "Codice Regione;Codice Comune formato alfanumerico;Denominazione in italiano;Denominazione Regione;"
    "Sigla automobilistica\n"
    "08;036023;Modena;Emilia-Romagna;MO\n"
    "03;015146;Milano;Lombardia;MI\n"
    "08;037006;Bologna;Emilia-Romagna;BO\n"
)


def test_parse_istat_filtra_regione():
    out = parse_istat(ISTAT, {"emilia-romagna"})
    assert out == [
        {"regione": "Emilia-Romagna", "provincia": "MO", "comune": "Modena", "codice_istat": "036023", "comune_alt": ""},
        {"regione": "Emilia-Romagna", "provincia": "BO", "comune": "Bologna", "codice_istat": "037006", "comune_alt": ""},
    ]


def test_parse_istat_tutte_le_regioni():
    assert len(parse_istat(ISTAT, None)) == 3


def test_parse_istat_intestazioni_spostate():
    text = ("Sigla automobilistica;Denominazione Regione;Denominazione in italiano;"
            "Codice Comune formato alfanumerico\nMO;Emilia-Romagna;Modena;036023\n")
    assert parse_istat(text, {"Emilia-Romagna"})[0]["codice_istat"] == "036023"


ISTAT_BILINGUE = (
    "Codice Regione;Codice Comune formato alfanumerico;Denominazione (italiano e straniera);Denominazione in italiano;"
    "Denominazione altra lingua;Denominazione Regione;Sigla automobilistica\n"
    "04;021008;Bolzano/Bozen;Bolzano;Bozen;Trentino-Alto Adige/Südtirol;BZ\n"
    "02;007003;Aosta/Aoste;Aosta;Aoste;Valle d'Aosta/Vallée d'Aoste;AO\n"
    "04;022205;Trento;Trento;;Trentino-Alto Adige/Südtirol;TN\n"
)


def test_parse_istat_regioni_bilingui():
    out = parse_istat(ISTAT_BILINGUE, {"Trentino-Alto Adige", "Valle d'Aosta"})
    assert [(r["regione"], r["comune"], r["comune_alt"]) for r in out] == [
        ("Trentino-Alto Adige", "Bolzano", "Bozen"), ("Valle d'Aosta", "Aosta", "Aoste"), ("Trentino-Alto Adige", "Trento", "")]
    assert [r["comune"] for r in parse_istat(ISTAT_BILINGUE, {"valle-d-aosta"})] == ["Aosta"]


def test_ipa_trova_il_sito_anche_con_il_nome_bilingue():
    t = "Comuni e loro Consorzi e Associazioni"
    sites = parse_ipa(ipa((t, "Comune di Bolzano", "Bolzano - Bozen", "BZ", "www.comune.bolzano.it"),
                          (t, "Comune di Aosta", "Aoste", "AO", "www.comune.aosta.it")))
    rows = merge([], parse_istat(ISTAT_BILINGUE, None), sites)
    assert {r["comune"]: r["sito"] for r in rows} == {
        "Bolzano": "https://www.comune.bolzano.it", "Aosta": "https://www.comune.aosta.it", "Trento": ""}


IPA_HEAD = "tipologia_istat\tdes_amm\tComune\tProvincia\tsito_istituzionale\n"


def ipa(*lines):
    return "﻿" + IPA_HEAD + "\n".join("\t".join(x) for x in lines) + "\n"


def test_parse_ipa():
    t = "Comuni e loro Consorzi e Associazioni"
    text = ipa(
        (t, "Comune di Modena", "Modena", "MO", "www.comune.modena.it"),
        (t, "Unione Terre di Castelli", "Vignola", "MO", "www.unione.it"),  # non "Comune "
        (t, "Comune di Null", "Null", "MO", "null"),
        (t, "Comune di Vuoto", "Vuoto", "MO", ""),
        ("Altro", "Comune di Altro", "Altro", "MO", "www.altro.it"),
    )
    sites = parse_ipa(text)
    assert sites == {("modena", "MO"): "https://www.comune.modena.it"}


def test_parse_ipa_nome_ente_con_articolo():
    t = "Comuni e loro Consorzi e Associazioni"
    sites = parse_ipa(ipa((t, "Comune dell'Aquila", "L Aquila", "mo", "aquila.it")))
    assert sites[("aquila", "MO")] == "https://aquila.it"


COMUNI = [{"regione": "Emilia-Romagna", "provincia": "MO", "comune": "Modena", "codice_istat": "036023", "comune_alt": ""}]


def test_merge_nuova_riga():
    out = merge([], COMUNI, {("modena", "MO"): "https://m.it"})
    assert len(out) == 1 and out[0]["stato"] == "da_verificare" and out[0]["sito"] == "https://m.it"
    out = merge([], COMUNI, {})
    assert out[0]["note"] == "auto: sito non in IndicePA" and out[0]["sito"] == ""


@pytest.mark.parametrize("stato", ["attivo", "manuale"])
def test_merge_protette_non_toccate(stato):
    r = row(codice_istat="036023", comune="Vecchio", sito="https://old.it", cms="plone", stato=stato)
    before = dict(r)
    out = merge([r], COMUNI, {("modena", "MO"): "https://new.it"})
    assert out == [before]


def test_merge_cambio_sito_azzera_rilevati():
    r = row(codice_istat="036023", comune="Modena", sito="https://old.it", cms="plone", url_eventi="u",
            licenza="CC-BY-4.0", robots_ok="si", stato="candidato", note="x")
    out = merge([r], COMUNI, {("modena", "MO"): "https://new.it"})[0]
    assert out["sito"] == "https://new.it"
    assert (out["cms"], out["url_eventi"], out["licenza"], out["robots_ok"]) == ("", "", "", "")
    assert out["regione"] == "Emilia-Romagna"


def test_merge_stesso_sito_conserva_rilevati():
    r = row(codice_istat="036023", comune="Modena", sito="https://s.it", cms="plone", stato="candidato")
    out = merge([r], COMUNI, {("modena", "MO"): "https://s.it"})[0]
    assert out["cms"] == "plone"


# --- detect_cms ---

def test_cms_of():
    assert cms_of('<script src="/++plone++x/a.js">') == "plone"
    assert cms_of("<link href='design-comuni-plone-theme.css'>") == "plone"
    assert cms_of("<link href='/design-comuni-italia/x.css'>") == "wordpress-dci"
    assert cms_of("<html>boh</html>") == "altro"


@pytest.mark.parametrize("text, lic", [
    ("Licenza https://creativecommons.org/licenses/by/4.0/deed.it", "CC-BY-4.0"),
    ("I contenuti sono rilasciati con licenza CC BY 4.0.", "CC-BY-4.0"),
    ("Licenza CC-BY-SA 3.0", "CC-BY-SA-3.0"),
    ("CC0 dominio pubblico", "CC0"),
    ("Italian Open Data License", "IODL"),
    ("licenza IODL 2.0", "IODL"),
    ("https://creativecommons.org/licenses/by-nc/4.0/", "CC-BY-NC-4.0"),
    ("Licenza CC BY-NC-ND", "CC-BY-NC"),
    ("Tutti i diritti riservati", "riservata"),
    ("niente di niente", "non trovata"),
])
def test_license_of(text, lic):
    assert license_of(text) == lic


@pytest.mark.parametrize("lic, ok", [
    ("CC-BY-4.0", True), ("CC0", True), ("IODL", True), ("CC-BY-SA-3.0", True),
    ("CC-BY-NC-4.0", False), ("riservata", False), ("non trovata", False), ("", False),
])
def test_is_open(lic, ok):
    assert is_open(lic) is ok


HOME = """<html><head><link href="/++plone++design-comuni-plone-theme/x.css"></head><body>
<a href="/it/eventi">Eventi</a><a href="https://altro.it/eventi">Eventi</a>
<a href="/it/note-legali">Note legali</a></body></html>"""


def test_find_link_stesso_host():
    base = "https://www.c.it"
    assert find_link(HOME, base, "eventi") == "https://www.c.it/it/eventi"
    assert find_link(HOME, base, "legali") == "https://www.c.it/it/note-legali"
    assert find_link('<a href="https://altro.it/eventi">Eventi</a>', base, "eventi") == ""
    assert find_link('<a href="/x/agenda/">Cosa fare</a>', base, "eventi") == "https://www.c.it/x/agenda/"
    assert find_link("<p>niente</p>", base, "legali") == ""


def make_fetcher(routes, calls=None):
    def handler(req: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(req.url.path)
        r = routes.get(req.url.path)
        if r is None:
            return httpx.Response(404)
        return r if isinstance(r, httpx.Response) else httpx.Response(200, text=r)
    return Fetcher(httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True), min_interval=0, backoff=0)


def plone_routes(legal="Contenuti con licenza CC BY 4.0", api=None, robots=None):
    return {
        "/robots.txt": robots if robots is not None else httpx.Response(404),
        "/": HOME,
        "/++api++/@search": api if api is not None else httpx.Response(200, json={"items_total": 42}),
        "/it/eventi": "<html>eventi</html>",
        "/it/note-legali": f"<html><body><p>{legal}</p></body></html>",
    }


def test_detect_plone_candidato():
    out = detect(make_fetcher(plone_routes()), "www.c.it")
    assert out["cms"] == "plone" and out["stato"] == "candidato"
    assert out["robots_ok"] == "si" and out["licenza"] == "CC-BY-4.0"
    assert out["url_eventi"] == "https://www.c.it/it/eventi"
    assert "42 eventi" in out["note"]


def test_detect_robots_vieta_home_e_non_richiede():
    calls = []
    routes = plone_routes(robots="User-agent: *\nDisallow: /\n")
    out = detect(make_fetcher(routes, calls), "www.c.it")
    assert out["stato"] == "escluso" and out["robots_ok"] == "no"
    assert calls == ["/robots.txt"]  # la home non è mai stata richiesta


def test_detect_robots_vieta_solo_api_non_la_chiama():
    calls = []
    routes = plone_routes(robots="User-agent: *\nDisallow: /++api++\n")
    out = detect(make_fetcher(routes, calls), "www.c.it")
    assert "/++api++/@search" not in calls
    assert out["robots_ok"] == "no" and out["stato"] == "escluso"


def test_robots_wildcard_protego():
    f = make_fetcher({"/robots.txt": "User-agent: *\nDisallow: /*/eventi/*\nDisallow: /*.pdf$\n", "/it/info": "ok"})
    assert f.get("https://www.c.it/it/info").status_code == 200
    for bad in ("https://www.c.it/it/eventi/x", "https://www.c.it/a/b.pdf"):
        with pytest.raises(Blocked):
            f.get(bad)


def test_detect_robots_500_irraggiungibile():
    calls = []
    out = detect(make_fetcher(plone_routes(robots=httpx.Response(500)), calls), "www.c.it")
    assert out["cms"] == "irraggiungibile" and out["stato"] == "da_verificare"
    assert calls == ["/robots.txt"] * 4  # 1 tentativo + 3 retry: un errore momentaneo non basta a spegnere la fonte


def test_detect_home_404():
    routes = plone_routes()
    routes["/"] = httpx.Response(404)
    out = detect(make_fetcher(routes), "www.c.it")
    assert out["cms"] == "irraggiungibile" and "404" in out["note"]


def test_detect_licenza_non_trovata_da_verificare():
    out = detect(make_fetcher(plone_routes(legal="Nulla di utile")), "www.c.it")
    assert out["licenza"] == "non trovata" and out["stato"] == "da_verificare"


def test_detect_licenza_riservata_escluso():
    out = detect(make_fetcher(plone_routes(legal="Tutti i diritti riservati")), "www.c.it")
    assert out["stato"] == "escluso"


def test_detect_plone_senza_api_non_candidato():
    out = detect(make_fetcher(plone_routes(api=httpx.Response(404))), "www.c.it")
    assert out["stato"] == "da_verificare" and "API Plone non disponibile" in out["note"]


def test_apply_non_sovrascrive_note_a_mano():
    r = row(note="controllato a mano")
    apply(r, {"cms": "plone", "note": "auto: x"})
    assert r["note"] == "controllato a mano" and r["cms"] == "plone"
    r = row(note="auto: vecchia")
    apply(r, {"note": "auto: nuova"})
    assert r["note"] == "auto: nuova"


# --- adapters.load_sources ---

def test_load_sources():
    rows = [
        row(comune="Modena", provincia="MO", regione="Emilia-Romagna", sito="www.comune.modena.it",
            cms="plone", stato="attivo"),
        row(comune="Bologna", sito="bo.it", cms="drupal", stato="attivo"),  # niente adapter
        row(comune="Parma", sito="pr.it", cms="plone", stato="candidato"),  # non attivo
        row(comune="Reggio nell'Emilia", sito="re.it", cms="plone", stato="manuale"),
    ]
    out = load_sources(rows)
    assert list(out) == ["modena"]
    assert out["modena"].name == "modena"


def test_cms_of_modello_design_comuni_e_fornitore():
    page = '<script src="https://x.epublic.it/a.js"></script><div class="cmp-hero it-header-slim-wrapper">'
    assert cms_of(page) == "design_comuni_html" and vendor_of(page) == "ComWeb"
    assert vendor_of('<meta name="generator" content="Joomla! - Open Source">') == "Joomla"
    assert vendor_of("<p>niente</p>") == "" and cms_of("<p>niente</p>") == "altro"


def test_robots_errore_momentaneo_poi_ok():
    seq = iter([httpx.Response(503), httpx.Response(200, text="User-agent: *\nAllow: /")])
    f = make_fetcher({"/robots.txt": None, "/x": "ok"})
    f.client = httpx.Client(transport=httpx.MockTransport(
        lambda req: next(seq) if req.url.path == "/robots.txt" else httpx.Response(200, text="ok")))
    assert f.get("https://www.c.it/x").status_code == 200


FRASI_DE = [
    ("Alle Inhalte dieser Website stehen unter der Lizenz Creative Commons Namensnennung 4.0 International.", "CC-BY-4.0"),
    ("Die Texte und Bilder dürfen unter Angabe der Quelle gemäß CC BY 4.0 weiterverwendet werden.", "CC-BY-4.0"),
    ("Inhalte: Creative Commons Namensnennung - Nicht kommerziell 4.0", "CC-BY-NC-4.0"),
    ("Alle Rechte vorbehalten. Die Vervielfältigung der Inhalte ist untersagt.", "riservata"),
    ("Offene Daten der Gemeinde: Lizenz CC0 (Public Domain).", "CC0"),
]
FRASI_FR = [
    ("Les contenus de ce site sont publiés sous licence Creative Commons Attribution 4.0 International.", "CC-BY-4.0"),
    ("Réutilisation des données autorisée selon la licence CC BY 4.0.", "CC-BY-4.0"),
    ("Creative Commons Attribution - Pas d'utilisation commerciale 4.0", "CC-BY-NC-4.0"),
    ("Tous droits réservés. Toute reproduction des contenus est interdite.", "riservata"),
    ("Données ouvertes de la commune : licence CC0.", "CC0"),
]


@pytest.mark.parametrize("frase,atteso", FRASI_DE + FRASI_FR)
def test_license_of_tedesco_francese(frase, atteso):
    assert license_of(frase) == atteso


def test_licenze_tedesco_pagina_impressum():
    from licenses import best_sentence, classify

    html = ("<footer><p>Impressum</p><p>Alle Inhalte dieser Website stehen unter der Lizenz Creative Commons "
            "Namensnennung 4.0 International.</p><p>Die Software ist Open Source.</p></footer>")
    frase = best_sentence(html)
    assert license_of(frase) == "CC-BY-4.0" and classify(frase) == "contenuti"


def test_find_link_pagina_eventi_in_tedesco_e_francese():
    from detect_cms import find_link

    de = '<a href="/de/Verwaltung/Termine">Termine</a><a href="/de/Dorfleben/Veranstaltungen">Dorfleben</a>'
    assert find_link(de, "https://www.comune.aldino.bz.it", "eventi").endswith("/de/Dorfleben/Veranstaltungen")
    fr = '<a href="/fr/agenda-des-manifestations">Événements</a>'
    assert find_link(fr, "https://www.comune.aosta.it", "eventi").endswith("/fr/agenda-des-manifestations")
    assert find_link('<a href="/de/Verwaltung/Termine">Termine</a>', "https://x.bz.it", "eventi") == ""


def test_merge_non_perde_l_alias_inserito_a_mano():
    existing = [row(regione="Sardegna", provincia="SS", comune="Alghero", codice_istat="090003", stato="da_verificare",
                    comune_alt="L'Alguer")]
    out = merge(existing, [{"regione": "Sardegna", "provincia": "SS", "comune": "Alghero", "codice_istat": "090003",
                            "comune_alt": ""}], {})
    assert out[0]["comune_alt"] == "L'Alguer"


def test_sardegna_sigle_provincia_diverse_tra_istat_e_indicepa():
    from build_registry import _key

    assert _key("Lanusei", "SU") == _key("Lanusei", "OG") and _key("Lanusei", "SU") != _key("Lanusei", "BO")


def test_sitemap_relativa_nel_robots_si_risolve_sull_host():
    def handler(req):
        return httpx.Response(200, text="User-agent: *\nAllow: /\nSitemap: /SiteMap.aspx\nSitemap: https://x.it/a.xml")

    f = Fetcher(httpx.Client(transport=httpx.MockTransport(handler)), min_interval=0)
    assert f.sitemaps("https://x.it") == ["https://x.it/SiteMap.aspx", "https://x.it/a.xml"]


def test_nessuna_fonte_api_attiva_ha_il_sito_in_http():
    # Trecenta e Borgo a Mozzano (25/11/2026): con http:// il WAF risponde 400 «request method denied» all'endpoint REST, con https:// 200.
    # Vale per gli adapter che interrogano un'API sul sito (wordpress-dci, plone); le pagine HTML hanno url_eventi proprio.
    http = [f"{r['regione']}/{r['comune']}" for r in read_rows() if r["stato"] == "attivo" and r["cms"] in ("wordpress-dci", "plone")
            and r["sito"].startswith("http://")]
    assert http == []
