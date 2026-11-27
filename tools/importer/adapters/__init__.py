"""Fonti attive, lette da sources/<regione>.csv (righe con stato "attivo"). Vedi README, sezione Importer.

Aggiungere un CMS: una classe con l'interfaccia di adapters/base.py e un ramo in load_sources().
"""

from __future__ import annotations

import logging
import os

from geo import PROVINCES, slugify
from registry import base_url, read_rows

from .base import Adapter, fallback_place
from .design_comuni_html import DesignComuniHtmlAdapter
from .ert import (BASE as ERT_BASE, CALABRIA_API, CALABRIA_BASE, CALABRIA_REGION, CATEGORY_CALABRIA, PROVINCE_CODE_CALABRIA,
                  REGION as ERT_REGION, ErtAdapter)
from .filesource import FileSourceAdapter
from .firenze import API as FIRENZE_API, BASE as FIRENZE_BASE, FIRENZE_VIEWBOX, REGION as FIRENZE_REGION, FirenzeAdapter
from .opendatahub import OpenDataHubAdapter
from .plone import PloneAdapter
from .ticketmaster import BASE as TICKETMASTER_BASE, TicketmasterAdapter
from .wordpress import WordpressAdapter

log = logging.getLogger("importer")


CMS_ADAPTERS = {"plone": PloneAdapter, "wordpress-dci": WordpressAdapter, "design_comuni_html": DesignComuniHtmlAdapter,
                "opendatahub": OpenDataHubAdapter}


def load_sources(rows: list[dict] | None = None) -> dict[str, Adapter]:
    out: dict[str, Adapter] = {}
    for r in read_rows() if rows is None else rows:
        if r["stato"] != "attivo":
            continue
        cls = CMS_ADAPTERS.get(r["cms"])
        if cls is None:
            log.warning("%s: nessun adapter per il CMS %r (supportati: %s), saltato",
                        r["comune"], r["cms"], ", ".join(CMS_ADAPTERS))
            continue
        name = slugify(r["comune"])
        extra = {"url_eventi": r["url_eventi"]} if cls is DesignComuniHtmlAdapter else {}
        out[name] = cls(name, base_url(r["sito"]), r["comune"], r["provincia"], r["regione"],
                        PROVINCES.get(r["provincia"], ("", None))[1], **extra)
    if os.environ.get("TICKETMASTER_API_KEY"):  # senza chiave la fonte non esiste: né CI né test cambiano
        for region in sorted({a.region for a in out.values()}, key=slugify):
            name = f"ticketmaster-{slugify(region)}"
            out[name] = TicketmasterAdapter(name, TICKETMASTER_BASE, "Ticketmaster", "", region)
    return out


def with_code_sources(out: dict[str, Adapter]) -> dict[str, Adapter]:
    """Fonti regionali definite nel codice, non nel registro: le API di Emilia-Romagna Turismo e di Calabria Straordinaria e il dataset
    aperto del Comune di Firenze, se la regione ha fonti attive.
    Fuori da load_sources() perché quella legge solo le righe che le si passano."""
    if any(slugify(a.region) == slugify(ERT_REGION) for a in out.values()):
        # provincia del capoluogo regionale: serve solo come ripiego, ogni evento porta il suo comune e la sua provincia
        out["ert-emilia-romagna"] = ErtAdapter("ert-emilia-romagna", ERT_BASE, "Emilia Romagna Turismo", "BO", ERT_REGION)
    if any(slugify(a.region) == slugify(CALABRIA_REGION) for a in out.values()):
        # stesso schema dell'API ERT: solo una richiesta (limit 1000), niente status, province e categorie del portale
        out["calabria-straordinaria"] = ErtAdapter(
            "calabria-straordinaria", CALABRIA_BASE, "Calabria Straordinaria", "CZ", CALABRIA_REGION, api=CALABRIA_API,
            page_size=1000, max_pages=2, status_required=False, provinces=PROVINCE_CODE_CALABRIA, categories=CATEGORY_CALABRIA)
    if any(slugify(a.region) == slugify(FIRENZE_REGION) for a in out.values()):
        # dataset aperto «Eventi a Firenze» (GeoJSON, CC BY 4.0): una richiesta; `base` è l'host dei link alle schede degli eventi
        out["comune-firenze-opendata"] = FirenzeAdapter(
            "comune-firenze-opendata", FIRENZE_BASE, "Firenze", "FI", FIRENZE_REGION, FIRENZE_VIEWBOX, api=FIRENZE_API)
    return out


def with_file_sources(out: dict[str, Adapter], directory, names: list[str]) -> dict[str, Adapter]:
    """Le fonti dell'elenco del Mac (`names`) leggono i file scaricati dal Mac in `directory` invece della rete (#54).
    Una fonte che non è tra le attive, o è regionale, resta com'è."""
    for n in names:
        a = out.get(n)
        if a is not None and not getattr(a, "regional", False):
            out[n] = FileSourceAdapter(n, a.base, a.city, a.province, a.region, a.viewbox, directory, getattr(a, "url_eventi", ""))
    return out


SOURCES = with_code_sources(load_sources())

__all__ = ["Adapter", "SOURCES", "fallback_place", "load_sources", "with_code_sources"]
