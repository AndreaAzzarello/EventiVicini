"""Sitemap dall'importer (#20, #51): pagine XML, paginazione, scritture solo se cambia l'hash, parità degli slug con la webapp."""

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import sitemap  # noqa: E402
from geo import slugify  # noqa: E402

NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
SLUGS = json.loads((Path(__file__).parents[3] / "docs" / "schema" / "sitemap-slugs.json").read_text(encoding="utf-8"))
NOW = 1_800_000_000_000
H = 3_600_000


def ev(i, title="Concerto", city="modena", end=NOW + H):
    return {"id": f"e{i:05d}", "title": title, "citySlug": city, "endTime": end}


def locs(xml):
    return [e.text for e in ET.fromstring(xml).findall(".//s:loc", NS)]


def test_slug_dei_titoli_come_la_webapp():
    # stesso file letto da web/src/lib/sitemap-slugs.test.ts: l'URL dell'evento deve essere quello che la webapp considera canonico
    for case in SLUGS:
        assert (slugify(case["title"]) or "evento") == (case["slug"] or "evento")


def test_part_rows_toglie_finiti_e_doppioni_e_ordina_per_id():
    rows = sitemap.part_rows([ev(2), ev(1), ev(2), ev(3, end=NOW - 1), {"title": "senza id"}], NOW)
    assert [r[0] for r in rows] == ["e00001", "e00002"]
    assert rows[0] == ["e00001", "concerto", "modena", NOW + H]
    assert sitemap.part_rows([ev(1, title="???")], NOW)[0][1] == "evento"


def test_build_indice_luoghi_e_pagine_eventi():
    parts = {"emilia-romagna": sitemap.part_rows([ev(i) for i in range(1, 2502)], NOW)}
    cov = [{"slug": "emilia-romagna", "name": "Emilia-Romagna", "comuni": [{"slug": "modena", "events": 3}, {"slug": "forli", "events": 0}]},
           {"slug": "vuota", "name": "Vuota", "comuni": []}]
    docs = sitemap.build(parts, cov, NOW)
    assert sorted(docs) == ["sm_eventi_1", "sm_eventi_2", "sm_eventi_3", "sm_index", "sm_luoghi"]
    assert locs(docs["sm_index"]) == ["{{BASE}}/sitemap-luoghi.xml", "{{BASE}}/sitemap-eventi-1.xml", "{{BASE}}/sitemap-eventi-2.xml", "{{BASE}}/sitemap-eventi-3.xml"]
    assert [len(locs(docs[f"sm_eventi_{n}"])) for n in (1, 2, 3)] == [1000, 1000, 501]
    assert locs(docs["sm_eventi_1"])[0] == "{{BASE}}/eventi/concerto-e00001"
    luoghi = locs(docs["sm_luoghi"])
    assert "{{BASE}}/" in luoghi and "{{BASE}}/regione/emilia-romagna" in luoghi and "{{BASE}}/regione/vuota" not in luoghi
    assert "{{BASE}}/citta/modena" in luoghi and "{{BASE}}/citta/forli" not in luoghi  # forli: nessun evento
    assert {"{{BASE}}/privacy", "{{BASE}}/cookie", "{{BASE}}/termini"} <= set(luoghi)
    assert all(len(locs(d)) <= 50_000 for d in docs.values())


def test_build_unisce_regioni_senza_doppioni_e_scarta_i_finiti():
    parts = {"a": sitemap.part_rows([ev(1), ev(2)], NOW), "b": [["e00002", "altro", "x", NOW + H], ["e00009", "vecchio", "x", NOW - H]]}
    docs = sitemap.build(parts, [], NOW)
    assert locs(docs["sm_eventi_1"]) == ["{{BASE}}/eventi/concerto-e00001", "{{BASE}}/eventi/concerto-e00002"]


def test_xml_valido_con_caratteri_speciali_nella_citta():
    docs = sitemap.build({"a": [["e1", "a-b", "cit&ta<x>", NOW + H]]}, [], NOW)
    ET.fromstring(docs["sm_luoghi"])  # non solleva
    assert "cit&amp;ta&lt;x&gt;" in docs["sm_luoghi"]


def test_build_e_deterministica_e_non_dipende_dall_ordine_delle_regioni():
    a = sitemap.build({"a": sitemap.part_rows([ev(1)], NOW), "b": sitemap.part_rows([ev(2, city="bologna")], NOW)}, [], NOW)
    b = sitemap.build({"b": sitemap.part_rows([ev(2, city="bologna")], NOW), "a": sitemap.part_rows([ev(1)], NOW)}, [], NOW)
    assert a == b


def test_parti_su_file_e_file_illeggibili(tmp_path):
    sitemap.write_part(tmp_path / "sitemap-lazio.json", "lazio", [["e1", "x", "roma", NOW + H]], NOW)
    (tmp_path / "sitemap-rotto.json").write_text("{non json", encoding="utf-8")
    assert sitemap.load_parts(tmp_path) == {"lazio": [["e1", "x", "roma", NOW + H]]}


class FakeDb:
    """Firestore finto minimo: bundles/<nome> con get_all, set, delete e batch."""

    def __init__(self, docs=None):
        self.docs = dict(docs or {})
        self.writes = []

    def collection(self, name):
        return self

    def document(self, n):
        return ("ref", n)

    def get_all(self, refs):
        for _, n in refs:
            d = self.docs.get(n)
            yield type("D", (), {"id": n, "exists": d is not None, "to_dict": lambda self, d=d: d})()

    def batch(self):
        db = self

        class B:
            def set(self, ref, data):
                db.writes.append(("set", ref[1]))
                db.docs[ref[1]] = data

            def delete(self, ref):
                db.writes.append(("delete", ref[1]))
                db.docs.pop(ref[1], None)

            def commit(self):
                pass

        return B()


def test_write_solo_i_documenti_cambiati_e_pulizia_delle_pagine_in_piu():
    db = FakeDb()
    docs = sitemap.build({"a": sitemap.part_rows([ev(i) for i in range(1, 2002)], NOW)}, [], NOW)
    out = sitemap.write(db, docs, NOW)
    assert out["writes"] == 5 and {w[1] for w in db.writes} == set(docs)
    db.writes.clear()
    assert sitemap.write(db, docs, NOW)["writes"] == 0 and db.writes == []  # identico: nessuna scrittura
    # un solo evento in meno alla fine: cambia solo l'ultima pagina
    docs2 = sitemap.build({"a": sitemap.part_rows([ev(i) for i in range(1, 2001)], NOW)}, [], NOW)
    out2 = sitemap.write(db, docs2, NOW)
    assert {w[1] for w in db.writes if w[0] == "set"} == {"sm_index"}  # le pagine 1 e 2 non cambiano
    assert ("delete", "sm_eventi_3") in db.writes and out2["writes"] == 2
    assert "sm_eventi_3" not in db.docs
