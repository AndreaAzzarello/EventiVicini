"""Immagini solo https (#sicurezza): http:// e //host diventano https per tutti gli adapter, il resto sparisce; i link restano com'erano."""

import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from mapping import ROME, clean_images, content_hash, https_image, to_event  # noqa: E402

from test_collect import NOW, Fonte, esegui, evento  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "plone_events.json"


@pytest.mark.parametrize(
    "url, atteso",
    [
        ("https://www.comune.x.it/a.jpg", "https://www.comune.x.it/a.jpg"),
        ("http://www.comune.x.it/a.jpg", "https://www.comune.x.it/a.jpg"),
        ("HTTP://www.comune.x.it/a.jpg", "https://www.comune.x.it/a.jpg"),
        ("  http://www.comune.x.it/a.jpg ", "https://www.comune.x.it/a.jpg"),
        ("//cdn.comune.x.it/a.jpg", "https://cdn.comune.x.it/a.jpg"),
        ("javascript:alert(1)", ""),
        ("data:image/png;base64,AAA", ""),
        ("ftp://x.it/a.jpg", ""),
        ("file:///etc/passwd", ""),
        ("/relativo/a.jpg", ""),
        ("", ""),
        (None, ""),
    ],
)
def test_https_image(url, atteso):
    assert https_image(url) == atteso


def test_clean_images_tocca_solo_i_tre_campi_immagine_e_conta_gli_http():
    ev = {"imageUrl": "http://a.it/1.jpg", "imageMiniUrl": "http://a.it/m.jpg", "imagePreviewUrl": "https://a.it/p.jpg",
          "ticketUrl": "http://biglietti.it/x", "sourceUrl": "http://www.comune.x.it/evento"}
    assert clean_images(ev) == 2
    assert ev["imageUrl"] == "https://a.it/1.jpg" and ev["imageMiniUrl"] == "https://a.it/m.jpg"
    assert ev["imagePreviewUrl"] == "https://a.it/p.jpg"
    # i link in uscita non sono sottorisorse (la CSP non li tocca) e sourceUrl è la chiave dell'id: restano come sono
    assert ev["ticketUrl"] == "http://biglietti.it/x" and ev["sourceUrl"] == "http://www.comune.x.it/evento"


def test_clean_images_senza_campi_o_con_schemi_ostili():
    assert clean_images({"title": "x"}) == 0
    ev = {"imageUrl": "javascript:alert(1)", "imageMiniUrl": "", "imagePreviewUrl": "data:text/html,x"}
    assert clean_images(ev) == 0  # non erano http: spariscono ma non contano come «portate a https»
    assert ev == {"imageUrl": "", "imageMiniUrl": "", "imagePreviewUrl": ""}


def _plone_con_immagine_http():
    items = json.loads(FIXTURE.read_text(encoding="utf-8"))["items"]
    item = next(i for i in items if i["title"] == "Delfini Book Party")
    base = item["image"]["download"].rsplit("/", 1)[0]
    item["image"]["scales"] |= {"mini": {"download": f"{base}/image-200-aaaa.jpeg"}, "preview": {"download": f"{base}/image-400-bbbb.jpeg"}}
    return json.loads(json.dumps(item).replace("https://", "http://"))


def test_plone_http_dalla_fonte_diventa_https_nel_dato_finale():
    ev = to_event(_plone_con_immagine_http(), {"city": "Modena"}, NOW)
    assert ev["imageUrl"].startswith("http://")  # l'adapter passa il valore del sito senza filtro
    assert ev["imageMiniUrl"].startswith("http://") and ev["imagePreviewUrl"].startswith("http://")
    before = content_hash(ev)
    assert clean_images(ev) == 3
    assert all(ev[k].startswith("https://") for k in ("imageUrl", "imageMiniUrl", "imagePreviewUrl"))
    assert content_hash(ev) != before  # una tantum: gli eventi già scritti con http si riscrivono con https


def test_pipeline_collect_per_ogni_adapter(monkeypatch, caplog):
    """Tutti gli adapter passano da collect(): WordPress DCI, Plone e HTML scrivono http, qui la fonte finta li simula."""
    http = evento(url="https://a.it/e/0001") | {"imageUrl": "http://www.comune.a.it/.imaging/x.jpg", "ticketUrl": "http://t.it/x"}
    ostile = evento(title="Altro concerto", url="https://b.it/e/0002") | {"imageUrl": "javascript:alert(1)"}
    gia_https = evento(title="Un terzo concerto", url="https://c.it/e/0003") | {"imageUrl": "https://www.comune.c.it/x.jpg"}
    caplog.set_level(logging.INFO)
    out, _ = esegui(monkeypatch, {"a": Fonte("https://a.it", [http]), "b": Fonte("https://b.it", [ostile]), "c": Fonte("https://c.it", [gia_https])})
    by_url = {e["sourceUrl"]: e for e in out}
    assert by_url["https://a.it/e/0001"]["imageUrl"] == "https://www.comune.a.it/.imaging/x.jpg"
    assert by_url["https://a.it/e/0001"]["ticketUrl"] == "http://t.it/x"
    assert by_url["https://b.it/e/0002"]["imageUrl"] == ""
    assert by_url["https://c.it/e/0003"]["imageUrl"] == "https://www.comune.c.it/x.jpg"
    testo = caplog.text
    assert "a: 1 immagini http portate a https" in testo
    assert "b: 1 immagini" not in testo and "c: 1 immagini" not in testo  # niente righe per le fonti senza http
    assert "Immagini http portate a https: 1 in 1 fonti" in testo
    # il contentHash è calcolato sul dato già portato a https
    assert by_url["https://a.it/e/0001"]["contentHash"] == content_hash({k: v for k, v in by_url["https://a.it/e/0001"].items() if k != "contentHash"})
