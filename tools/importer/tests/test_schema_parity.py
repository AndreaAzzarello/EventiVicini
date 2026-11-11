"""Parità dello schema evento con web/src/lib/event.ts e firebase/firestore.rules (#18).

Il file condiviso docs/schema/parity.json è letto da tre test: questo, web/src/lib/schema-parity.test.ts e
firebase/test/parity.test.js. Se aggiungi o togli una categoria, un tipo di prezzo o un campo in un solo posto,
almeno uno dei tre diventa rosso. Come aggiornare il file: docs/importer.md, sezione «Schema evento».
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from adapters import ticketmaster  # noqa: E402
from geo import enrich, slugify  # noqa: E402
from mapping import CATEGORY_BY_TYPE, CULTURE_TYPES, HASH_SKIP, KEYWORDS, ROME, map_price, to_event  # noqa: E402

PARITY = json.loads((Path(__file__).parents[3] / "docs" / "schema" / "parity.json").read_text(encoding="utf-8"))
FIXTURE = Path(__file__).parent / "fixtures" / "plone_events.json"
NOW = datetime(2026, 10, 26, 12, 0, tzinfo=ROME)
FALLBACK = {"city": "Modena", "province": "MO", "region": "Emilia-Romagna"}


def test_categorie_dell_importer_coincidono_con_il_file_condiviso():
    # tutte le uscite possibili di map_category / category_from_title / Ticketmaster, più i valori di ripiego
    found = set(CATEGORY_BY_TYPE.values()) | {cat for cat, _ in KEYWORDS} | set(ticketmaster.SEGMENTS.values())
    if CULTURE_TYPES:
        found.add("culture")  # map_category: i tipi in CULTURE_TYPES danno "culture"
    found.add("other")  # ripiego di map_category e degli adapter
    assert found == set(PARITY["categories"])


@pytest.mark.parametrize("text", ["", "Ingresso libero", "Gratuito", "Biglietti: 10€", "5 euro", "30 €", "€ 25", "a pagamento"])
def test_tipi_di_prezzo_di_map_price_sono_ammessi(text):
    assert map_price(text) in PARITY["priceTypes"]


def test_unknown_di_ticketmaster_e_nel_file_condiviso():
    assert "unknown" in PARITY["priceTypes"]
    assert {"free", "low", "premium"} <= set(PARITY["priceTypes"])


def test_chiavi_dell_evento_prodotto_dall_importer():
    items = json.loads(FIXTURE.read_text(encoding="utf-8"))["items"]
    events = [e for e in (to_event(i, {"city": "Modena"}, NOW) for i in items) if e and e["lat"] is not None]
    assert events, "la fixture non produce eventi con coordinate"
    required = set(PARITY["eventKeys"])
    allowed = required | set(PARITY["eventOptionalKeys"]) | set(PARITY["importerOnlyKeys"])
    for ev in events:
        ev = {k: v for k, v in ev.items() if not k.startswith("_") and k != "id"}
        enrich(ev, None, FALLBACK)  # geohash, city, citySlug, province, region
        keys = set(ev)
        assert required <= keys, f"campi obbligatori mancanti: {sorted(required - keys)}"
        assert not keys - allowed, f"campi non dichiarati in parity.json: {sorted(keys - allowed)}"
        assert ev["category"] in PARITY["categories"]
        assert ev["priceType"] in PARITY["priceTypes"]
        assert ev["source"] in PARITY["sources"]


def test_campi_esclusi_dall_hash():
    assert HASH_SKIP == set(PARITY["hashSkip"])


def test_tag_bambini_dell_importer_sono_riconosciuti_dal_web():
    from mapping import KIDS_RE

    assert KIDS_RE.search("laboratorio per bambini")
    items = json.loads(FIXTURE.read_text(encoding="utf-8"))["items"]
    tags = {t for i in items if (e := to_event(i, {"city": "Modena"}, NOW)) for t in e["tags"]}
    assert tags <= set(PARITY["kidsTags"]), tags


@pytest.mark.parametrize("case", PARITY["slugify"], ids=lambda c: repr(c["in"][:20]))
def test_slugify_coincide_con_il_file_condiviso(case):
    assert slugify(case["in"]) == case["out"]


def test_slugify_ha_almeno_venti_casi():
    assert len(PARITY["slugify"]) >= 20
