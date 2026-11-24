"""Filtro anti-avvisi: esclude sedute, avvisi, riepiloghi e titoli generici; non tocca gli eventi veri."""

import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))
from adapters.design_comuni_html import DesignComuniHtmlAdapter  # noqa: E402
from fake_firestore import FakeFirestore  # noqa: E402
from mapping import ROME, content_hash  # noqa: E402
from relevance import exclusion_reason  # noqa: E402
from run import excluded_report, plan_writes  # noqa: E402

ESCLUSI = [
    ("Seduta del Consiglio comunale del 12 novembre", "seduta di consiglio/giunta"),
    ("Convocazione Giunta comunale", "seduta di consiglio/giunta"),
    ("Consiglio comunale", "seduta di consiglio/giunta"),
    ("Commissione consiliare cultura", "seduta di consiglio/giunta"),
    ("Calendario raccolta rifiuti 2026", "avviso"),
    ("Attenzione alle truffe agli anziani", "avviso"),
    ("Allerta meteo rossa", "avviso"),
    ("Peste suina africana: misure in vigore", "avviso"),
    ("Bando per i contributi alle associazioni", "avviso"),
    ("Sicurezza stradale: nuove limitazioni", "avviso"),
    ("Video: messaggio del sindaco", "video"),
    ("Tutti gli eventi", "pagina riassuntiva"),
    ("Eventi 2026", "pagina riassuntiva"),
    ("Programma eventi estate", "pagina riassuntiva"),
    ("Calendario eventi di novembre", "pagina riassuntiva"),
    ("Evento culturale", "titolo generico"),
    ("Mostra", "titolo generico"),
    ("  Evento  ", "titolo generico"),
    ("Archivio eventi", "pagina riassuntiva"),
]

TENUTI = [
    "Concerto per il 4 novembre",
    "Cerimonia del 4 novembre",
    "Mostra fotografica sul Novecento",
    "Evento culturale in biblioteca: Leggere ad alta voce",
    "Incontro contro le truffe agli anziani",
    "Truffe sbuffi baruffe",
    "Come prevenire e difendersi dalle Truffe!",
    "Come difendersi dalle truffe agli anziani",
    "Stagione teatrale 2026/2027",
    "Teatro Michelangelo: stagione",
    "Stagione concertistica 2026-2027",
    "Stagione cinematografica d'autunno",
    "Laboratorio di riciclo dei rifiuti per bambini",
    "Presentazione del bando per il servizio civile",
    "Band emergenti in piazza",
    "Consigli di lettura per l'autunno",
    "Eventi di Natale in centro",
    "Estate in musica al parco",
    "Sagra della castagna",
    "Esercitazione di protezione civile aperta al pubblico",
    "Spettacolo di burattini",
    "Mostra del libro",
]


@pytest.mark.parametrize("title,reason", ESCLUSI)
def test_esclusi(title, reason):
    assert exclusion_reason(title) == reason


@pytest.mark.parametrize("title", TENUTI)
def test_eventi_veri_restano(title):
    assert exclusion_reason(title) is None


def pagina(links: int, data: str) -> str:
    cards = "".join(f'<a href="/eventi/altro-{i}">Evento {i}</a>' for i in range(links))
    return f"<html><body><main><h1>Eventi autunno</h1><p>{data}</p>{cards}</main></body></html>"


def test_pagina_riassuntiva_molti_link_e_data_dal_testo():
    a = DesignComuniHtmlAdapter("x", "https://x.it", "X", "BO", "Emilia-Romagna")
    now = datetime(2026, 11, 1, tzinfo=ROME)
    url = "https://x.it/eventi/programma-autunno"
    riepilogo = a.event_from_page(pagina(8, "Dal 5 novembre al 20 dicembre 2026"), url, now, 90)
    assert riepilogo["_excluded"] == "pagina riassuntiva"
    # stessi link ma pochi: un evento con "leggi anche" resta
    assert "_excluded" not in a.event_from_page(pagina(2, "Dal 5 novembre al 20 dicembre 2026"), url, now, 90)


def test_stagione_teatrale_con_molti_link_resta_longrunning():
    a = DesignComuniHtmlAdapter("x", "https://x.it", "X", "FI", "Toscana")
    now = datetime(2026, 11, 1, tzinfo=ROME)
    page = pagina(9, "Dal 5 novembre al 20 dicembre 2026").replace("Eventi autunno", "Stagione teatrale 2026/2027")
    ev = a.event_from_page(page, "https://x.it/eventi/stagione", now, 90)
    assert ev and "_excluded" not in ev and exclusion_reason(ev["title"]) is None


def test_widget_feedback_non_e_il_titolo():
    a = DesignComuniHtmlAdapter("x", "https://x.it", "X", "BG", "Lombardia")
    now = datetime(2026, 11, 1, tzinfo=ROME)
    widget = ('<div class="cmp-rating"><div data-element="feedback"><h1 data-element="feedback-title">'
              "Quanto sono chiare le informazioni su questa pagina?</h1></div></div>")
    # come sui siti reali: l'h1 della pagina sta fuori da <main>, quello del widget dentro
    page = (f"<html><body><h1>Archivio eventi</h1><main>{widget}<p>Dal 5 novembre al 20 dicembre 2026</p></main>"
            "</body></html>")
    ev = a.event_from_page(page, "https://x.it/eventi/archivio-eventi/", now, 90)
    assert ev["title"] == "Archivio eventi" and exclusion_reason(ev["title"]) == "pagina riassuntiva"


def test_esclusi_gia_importati_diventano_removed_subito():
    now_ms = 1_000_000_000_000
    ok = {"www.comune.test.it"}
    doc = lambda i, **k: {"source": "scraper", "sourceUrl": f"https://www.comune.test.it/e/{i}",  # noqa: E731
                          "startTime": now_ms + 1000, "endTime": now_ms + 2000} | k
    existing = {"a": doc("a"), "b": doc("b", removedAt=5), "c": doc("c", source="manual")}
    plan = plan_writes([], existing, ok, now_ms, 86_400_000, excluded={"a", "b", "c", "nuovo"})
    assert plan["stale"] == {"a": {"removedAt": now_ms}}  # b già nascosto, c manuale, "nuovo" non esiste


def test_report_per_regione():
    ex = [{"id": str(i), "title": f"Seduta {i}", "reason": "seduta di consiglio/giunta", "source": "x",
           "region": "veneto" if i % 2 else "toscana"} for i in range(30)]
    text = excluded_report(ex)
    assert "veneto: 15" in text and "toscana: 15" in text and text.count("\n  - ") == 20


def test_errore_imprevisto_in_una_fonte_non_ferma_le_altre(monkeypatch, tmp_path):
    import httpx
    import run
    from types import SimpleNamespace

    class Rotta:
        def events(self, *a):
            raise ValueError("pagina anomala")

    class Vuota:
        def events(self, *a):
            return []

    monkeypatch.setattr(run, "SOURCES", {"rotta": Rotta(), "vuota": Vuota()})
    stats: dict = {}
    run.collect(httpx.Client(), SimpleNamespace(), ["rotta", "vuota"], datetime(2026, 11, 1, tzinfo=ROME), 60, stats)
    assert stats["rotta"]["error"] == "ValueError: pagina anomala" and stats["vuota"]["error"] is None


def test_pagine_archivio_saltate():
    from adapters.design_comuni_html import ARCHIVE_RE
    assert ARCHIVE_RE.search("/vivere-il-comune/eventi/archivio-eventi/")
    assert not ARCHIVE_RE.search("/vivere-il-comune/eventi/archivio-fotografico-in-mostra")


ESCLUSI_DE_FR = [
    ("Gemeinderatssitzung vom 12. November", "seduta di consiglio/giunta"),
    ("Sitzung des Gemeindeausschusses", "seduta di consiglio/giunta"),
    ("Kundmachung: Müllabfuhr an Allerheiligen", "avviso"),
    ("Straßensperre Pustertaler Straße", "avviso"),
    ("Veranstaltungen", "titolo generico"),
    ("Alle Veranstaltungen 2026", "pagina riassuntiva"),
    ("Séance du conseil municipal du 12 novembre", "seduta di consiglio/giunta"),
    ("Avis de coupure d'eau", "avviso"),
    ("Collecte des déchets: calendrier", "avviso"),
    ("Événements", "titolo generico"),
]
TENUTI_DE_FR = [
    "Konzert der Musikkapelle", "Vortrag: Geschichte des Dorfes", "Ausstellung im Rathaus",
    "Informationsveranstaltung zur Müllentsorgung", "Weinfest am Dorfplatz", "Führung durch die Altstadt",
    "Concert de la fanfare municipale", "Exposition de peinture", "Conférence sur l'histoire de la vallée",
    "Marché de Noël", "Soirée jeux pour les enfants",
]


@pytest.mark.parametrize("title,reason", ESCLUSI_DE_FR)
def test_esclusi_tedesco_francese(title, reason):
    assert exclusion_reason(title) == reason


@pytest.mark.parametrize("title", TENUTI_DE_FR)
def test_eventi_veri_tedesco_francese_restano(title):
    assert exclusion_reason(title) is None


@pytest.mark.parametrize("title,reason", [
    ("Sciopero generale del 14 novembre", "avviso"),
    ("Sciopero del personale della scuola", "avviso"),
    ("Proclamazione sciopero trasporti", "avviso"),
    ("Avviso: sciopero dei mezzi pubblici", "avviso"),
])
def test_scioperi_veri_restano_avvisi(title, reason):
    assert exclusion_reason(title) == reason


@pytest.mark.parametrize("title", [
    "Lo sciopero delle bambine",  # spettacolo teatrale (San Giorgio Canavese)
    "Spettacolo: Lo sciopero delle bambine",
    "Letture animate: Lo sciopero degli animali",
])
def test_sciopero_nel_titolo_di_uno_spettacolo_non_e_un_avviso(title):
    assert exclusion_reason(title) is None


def test_edizione_passata_dall_anno_nel_titolo():
    assert exclusion_reason("Natale 2023", 2026) == "edizione passata"
    assert exclusion_reason("Sagra 2024-2026", 2026) is None and exclusion_reason("Natale 2026", 2026) is None
    assert exclusion_reason("Natale 2023") is None  # senza anno di inizio non si decide


# #88: un anno nel titolo fa scartare l'evento solo se è un'edizione passata davvero
@pytest.mark.parametrize("title,start", [
    ("Ski Kids Merano 2000", 2026),  # Merano 2000 è il comprensorio
    ("Camminate invernali guidate a Merano 2000", 2026),
    ("Skishow della Scuola Sci & Snowboard 2000", 2026),
    ("Avvento in Musica 2026/27 - BeBo", 2027),  # stagione: vale l'anno più alto
    ("Il matrimonio perfetto | Stagione Teatrale 2026/27", 2027),
    ("Avvento in Musica 2026-27", 2027),
    ("Rassegna 2026/2027", 2027),
    ("Omaggio a Piergiorgio Rebesco (1936-2020)", 2026),  # anni di vita, non un'edizione
    ("Natale 2027", 2026),  # anno futuro
])
def test_anno_nel_titolo_non_scarta_eventi_veri(title, start):
    assert exclusion_reason(title, start) is None


@pytest.mark.parametrize("title,start", [
    ("San Nicolò e i Krampus 2025", 2026),
    ("Natale 2023", 2026),
    ("Presepi Frazzanò 2024", 2026),
    ("Epifania 2024", 2026),
    ("Natale a Catania 2025", 2026),
    ("Avvento in Musica 2025/26", 2027),  # stagione conclusa
    ("Festa Nuovi Nati 2025 in Biblioteca", 2026),
    ("Rassegna 2016", 2026),  # entro la finestra di 10 anni: passata
])
def test_anno_passato_nel_titolo_resta_escluso(title, start):
    assert exclusion_reason(title, start) == "edizione passata"
