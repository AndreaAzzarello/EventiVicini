import json
import sys
from datetime import datetime, time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from mapping import ROME, category_from_title, dedupe_key, html_to_text, is_long_running, shorten, event_id, map_category, map_price, parse_hours, to_event  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "plone_events.json"
NOW = datetime(2026, 10, 26, 12, 0, tzinfo=ROME)
SOURCE = {"city": "Modena"}


@pytest.fixture(scope="module")
def events():
    items = json.loads(FIXTURE.read_text(encoding="utf-8"))["items"]
    return {i["title"]: to_event(i, SOURCE, NOW) for i in items}


def local(ms):
    return datetime.fromtimestamp(ms / 1000, ROME).replace(tzinfo=None)


def test_evento_normale_con_coordinate_del_luogo(events):
    e = events["Nessun dubbio"]
    assert local(e["startTime"]) == datetime(2026, 10, 30, 21, 0)  # 20:00Z, ora solare
    assert local(e["endTime"]) == datetime(2026, 10, 30, 23, 0)
    assert e["priceType"] == "low"  # "Biglietti: 10€"
    assert e["venueName"] == 'Auditorium "Spira mirabilis"'
    assert (e["lat"], e["lng"]) == pytest.approx((44.5765, 10.8393), abs=1e-3)
    assert e["_geocode"]  # sempre compilato: serve se le coordinate della fonte risultano fuori provincia
    assert e["source"] == "scraper"
    assert e["id"] == event_id(e["sourceUrl"])


def test_bambini_e_gratis(events):
    e = events["Giochetto o scherzetto?"]
    assert e["tags"] == ["kids"]
    assert e["priceType"] == "free"


def test_ricorrente_prossima_occorrenza_con_orario_da_testo(events):
    e = events["Mercato settimanale del lunedì"]
    assert local(e["startTime"]) == datetime(2026, 10, 26, 8, 0)  # "dalle ore 8 alle 14"
    assert local(e["endTime"]) == datetime(2026, 10, 26, 14, 0)
    assert e["category"] == "market"
    assert e["lat"] is None and e["_geocode"][0].endswith("Modena")
    assert e["imageUrl"].startswith("https://www.comune.modena.it/")


def test_ricorrente_rispetta_exdate(events):
    # Sabati con EXDATE fino al 7/11: la prossima data valida è il 14/11.
    e = events["Delfini Book Party"]
    assert local(e["startTime"]) == datetime(2026, 11, 14, 8, 30)
    assert local(e["endTime"]) == datetime(2026, 11, 14, 12, 30)


def test_giornata_intera_in_corso(events):
    e = events["Fiere di Ottobre 2026"]
    assert local(e["startTime"]) == datetime(2026, 10, 1, 0, 0)
    assert local(e["endTime"]) == datetime(2026, 10, 31, 23, 59)
    assert e["_geocode"] == ["Centro storico, Sassuolo"]


def test_scarta_finiti_e_oltre_orizzonte():
    base = {"@id": "https://x/e", "title": "T"}
    assert to_event({**base, "start": "2026-10-01T10:00:00Z", "end": "2026-10-01T12:00:00Z"}, SOURCE, NOW) is None
    assert to_event({**base, "start": "2027-06-01T10:00:00Z", "end": "2027-06-01T12:00:00Z"}, SOURCE, NOW) is None
    assert to_event({**base, "title": "", "start": "2026-11-01T10:00:00Z"}, SOURCE, NOW) is None


@pytest.mark.parametrize("text,expected", [
    ("Ingresso libero", "free"),
    ("Gratuito, su prenotazione", "free"),
    ("Biglietti Ingresso 15€ (riduzioni 10€)", "low"),
    ("Intero 30 euro", "premium"),
    ("a pagamento", "unknown"),
    ("Costo: -", "unknown"),
    ("", "unknown"),
])
def test_prezzo(text, expected):
    assert map_price(text) == expected


@pytest.mark.parametrize("item,expected", [
    ({"tipologia_evento": {"token": "maifestazione_musicale"}, "title": "X"}, "music"),
    ({"tipologia_evento": {"token": "mostra"}, "title": "Pittura"}, "culture"),
    ({"tipologia_evento": {"token": "eventi_sociali"}, "title": "Sagra del tortellino"}, "food"),
    ({"tipologia_evento": None, "title": "Torneo di calcio"}, "sport"),
    ({"title": "Garanzia giovani"}, "other"),  # "gara" solo come parola intera
])
def test_categoria(item, expected):
    assert map_category(item) == expected


def test_orari_dal_testo():
    assert parse_hours("dalle ore 8.30 alle 12.30") == [time(8, 30), time(12, 30)]
    assert parse_hours("il lunedì dalle ore 8 alle 14") == [time(8), time(14)]
    assert parse_hours("vedi il programma") == []


def test_dedupe_key_ignora_maiuscole_e_punteggiatura():
    a = {"title": "Concerto: Jazz!", "citySlug": "modena", "startTime": 1_793_000_000_000}
    b = {"title": "concerto jazz", "citySlug": "modena", "startTime": 1_793_000_000_000 + 3_600_000}
    assert dedupe_key(a) == dedupe_key(b)


@pytest.mark.parametrize("title,expected", [
    ("Sagra della polenta", "food"), ("Concerto di Natale", "music"), ("Torneo di tennis", "sport"),
    ("Mercatino dell'antiquariato", "market"), ("Spettacolo teatrale in piazza", "culture"),
    ("Mostra fotografica", "culture"), ("Burattini per bambini", "kids"), ("Presentazione del libro", "culture"),
    ("Consiglio comunale", None),
])
def test_category_from_title_italian_keywords(title, expected):
    assert category_from_title(title) == expected


def test_durata_tetto_365_giorni_e_long_running(caplog):
    base = {"@id": "https://x/e", "title": "Mostra"}
    mostra = {**base, "start": "2026-10-01T10:00:00Z", "end": "2027-02-01T10:00:00Z"}  # 123 giorni: si importa
    assert to_event(mostra, SOURCE, NOW) is not None
    assurda = {**base, "start": "2026-10-01T10:00:00Z", "end": "2028-01-01T10:00:00Z"}  # oltre 365: scartata e loggata
    with caplog.at_level("WARNING", logger="importer"):
        assert to_event(assurda, SOURCE, NOW) is None
    assert "scartato: https://x/e" in caplog.text


def test_is_long_running_oltre_14_giorni():
    day = 86_400_000
    assert not is_long_running({"startTime": 0, "endTime": 14 * day})
    assert is_long_running({"startTime": 0, "endTime": 14 * day + 1})


def test_html_to_text_minerbio_dolcetto():
    raw = ("<div>Anche quest'anno tornano i festeggiamenti di <b>Halloween</b> a <b>Minerbio!!</b><br><br>"
           "Preparatevi per una serata da brividi!</div><div>L'evento seguirà questi orari:<br><br>"
           "<b> 16:00 - Chiusura</b></div>")
    assert html_to_text(raw) == ("Anche quest'anno tornano i festeggiamenti di Halloween a Minerbio!!\n\n"
                                 "Preparatevi per una serata da brividi!\nL'evento seguirà questi orari:\n\n16:00 - Chiusura")


@pytest.mark.parametrize("raw, expected", [
    ("<ul><li>Uno</li><li>Due &amp; tre</li></ul>", "• Uno\n• Due & tre"),
    ("Caff&egrave; &amp; torta&nbsp;buona", "Caffè & torta buona"),
    ("&lt;b&gt;Ciao&lt;/b&gt;&lt;br&gt;mondo", "Ciao\nmondo"),  # HTML scritto come entità
    ("<p>Uno</p><p>Due</p>", "Uno\nDue"),
    ("a < b e 3 > 2, ti <3", "a < b e 3 > 2, ti <3"),
    ("<script>alert(1)</script>Testo<style>x{}</style>", "Testo"),
    ("  spazi   multipli \n\n\n\n e righe  ", "spazi multipli\n\ne righe"),
    (None, ""),
])
def test_html_to_text(raw, expected):
    assert html_to_text(raw) == expected
    assert html_to_text(expected) == expected  # idempotente


def test_shorten_non_taglia_dentro_un_tag():
    out = shorten(html_to_text("<div><b>" + "parola " * 80 + "</b></div>"))
    assert len(out) <= 300 and out.endswith("…") and "<" not in out


@pytest.mark.parametrize("title,expected", [
    ("Kinderkonzert in der Bibliothek", "kids"), ("Weinverkostung im Keller", "food"), ("Berglauf Seiser Alm", "sport"),
    ("Konzert der Musikkapelle", "music"), ("Bauernmarkt", "market"), ("Lesung mit Autorin", "culture"),
    ("Spectacle pour enfants", "kids"), ("Dégustation de fromages", "food"), ("Concert de la chorale", "music"),
    ("Marché de Noël", "market"), ("Exposition de photographies", "culture"),
])
def test_category_from_title_tedesco_francese(title, expected):
    assert category_from_title(title) == expected


def test_durata_massima_confine():
    """365 giorni e qualche ora non è "oltre 365" (il messaggio stampa i giorni interi): si scarta da 366 in su."""
    from datetime import timedelta

    from mapping import MAX_EVENT_DAYS, too_long

    start = datetime(2026, 11, 1, 9, 0, tzinfo=ROME)
    assert not too_long(start, start + timedelta(days=MAX_EVENT_DAYS), "u")
    assert not too_long(start, start + timedelta(days=MAX_EVENT_DAYS, hours=5), "u")  # il caso di Francavilla Marittima
    assert too_long(start, start + timedelta(days=MAX_EVENT_DAYS + 1), "u")


def _plone_item_with_scales(**scales):
    items = json.loads(FIXTURE.read_text(encoding="utf-8"))["items"]
    item = next(i for i in items if i["title"] == "Delfini Book Party")
    item = json.loads(json.dumps(item))
    item["image"]["scales"].update(scales)
    return item


def test_scale_mini_e_preview_con_hash_sono_salvate_accanto_a_imageurl():
    # #95: le scale senza hash fanno una richiesta condizionale per miniatura a ogni visita, quelle con hash hanno cache di 1 anno
    base = "https://www.comune.modena.it/vivere-modena/eventi/2026/x/@@images/"
    item = _plone_item_with_scales(mini={"download": base + "image-200-aaaa.jpeg"}, preview={"download": base + "image-400-bbbb.jpeg"})
    e = to_event(item, SOURCE, NOW)
    assert e["imageMiniUrl"] == base + "image-200-aaaa.jpeg"
    assert e["imagePreviewUrl"] == base + "image-400-bbbb.jpeg"
    assert "image-800-" in e["imageUrl"]  # la scala grande resta quella di prima


def test_senza_scale_piccole_i_campi_sono_vuoti_e_imageurl_non_cambia(events):
    e = events["Delfini Book Party"]
    assert e["imageMiniUrl"] == "" and e["imagePreviewUrl"] == ""
    assert "image-800-" in e["imageUrl"]
    senza = to_event({**_plone_item_with_scales(), "image": None}, SOURCE, NOW)
    assert senza["imageUrl"] == "" and senza["imageMiniUrl"] == "" and senza["imagePreviewUrl"] == ""


def test_le_scale_nuove_cambiano_il_contenthash_una_volta_poi_restano_stabili():
    from mapping import content_hash

    sample = {"download": "https://x.it/@@images/image-200-aaaa.jpeg"}
    before = content_hash(to_event(_plone_item_with_scales(), SOURCE, NOW))
    after = content_hash(to_event(_plone_item_with_scales(mini=sample), SOURCE, NOW))
    again = content_hash(to_event(_plone_item_with_scales(mini=sample), SOURCE, NOW))
    assert before != after and after == again
