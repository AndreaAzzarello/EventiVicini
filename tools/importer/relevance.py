"""Filtro anti-avvisi: pagine dei siti comunali che non sono eventi pubblici (sedute, avvisi, riepiloghi, titoli generici).

Funzione pura sul titolo; il controllo strutturale (pagina riassuntiva con molti link ad altri eventi e nessuna data
singola) sta in adapters/design_comuni_html.py e segnala con lo stesso formato di motivo.
"""

from __future__ import annotations

import re

from mapping import _norm

#: titoli che da soli non dicono nulla (confronto sul titolo normalizzato, senza accenti né punteggiatura)
GENERIC_TITLES = {
    "veranstaltung", "veranstaltungen", "termin", "termine", "event", "events", "mitteilung",  # tedesco
    "evenement", "evenements", "manifestation", "manifestations", "agenda", "actualite", "actualites",  # francese
    "evento", "eventi", "evento culturale", "evento sportivo", "evento musicale", "evento gastronomico",
    "evento pubblico", "mostra", "spettacolo", "manifestazione", "iniziativa", "iniziative", "appuntamento",
}

#: pagine riassuntive: "Tutti gli eventi", "Eventi 2026", "Programma eventi estate", "Calendario eventi"
SUMMARY_RE = re.compile(
    r"^archivio(?: eventi)?(?: 20\d\d)?$"
    r"|^(?:tutti gli )?eventi(?: (?:in programma|del comune|di (?:\w+ ){0,2}20\d\d))?(?: 20\d\d)?$"
    r"|^(?:programma|calendario|elenco)\b.*\beventi\b"
    r"|^eventi\b.*\b(?:programma|calendario)\b"
    r"|^programma (?:dell |della )?(?:estate|estivo|autunno|inverno|primavera)\b"
    r"|^(?:estate|autunno|inverno|primavera) 20\d\d$"
    r"|^(?:alle |aktuelle )?(?:veranstaltungen|termine)(?: 20\d\d)?$|^veranstaltungs(?:kalender|programm|ubersicht)\b"
    r"|^(?:tous les |calendrier des |programme des )?evenements(?: 20\d\d)?$"
    r"|^(?:programme|calendrier) (?:des )?(?:manifestations|evenements)\b")

#: sedute degli organi comunali
SEDUTA_RE = re.compile(
    r"\b(?:sedut[ae]|convocazion[ei]|riunion[ei])\b.*\b(?:consigli\w*|giunta|commission\w*)\b"
    r"|\b(?:consiglio|giunta)\s+(?:comunale|municipale)\b|\bcommissione\s+consiliare\b"
    r"|gemeinderat|stadtrat|gemeindeausschuss|ratssitzung|ausschusssitzung|\bsitzung\b.*\b(?:gemeinde|ausschuss|rat)"  # DE: composti
    r"|\bconseil\s+(?:municipal|communal)\b|\bseance\b.*\bconseil\b|\bcommission\s+communale\b")

#: avvisi alla cittadinanza; si salvano se il titolo dice che è un incontro pubblico (EVENT_WORD_RE)
NOTICE_RE = re.compile(
    r"\brifiuti\b|\becocentro\b|\braccolta\s+(?:differenziata|porta)|\bingombranti\b"
    r"|\braggir\w*"
    r"|\ballert[ae]\b|\bavviso\b|\bavvisi\b"
    r"|\bpeste\s+suina\b|\binfluenza\s+aviaria\b|\bzanzara\s+tigre\b"
    r"|\bband[oi]\b|\bgraduatoria\b"
    r"|\bsicurezza\s+stradale\b|\bchiusura\s+(?:al\s+traffico|strada|ufficio|uffici)\b|\bviabilit[aà]\b"
    r"|^sciopero\b|\bsciopero\s+(?:generale|nazionale|regionale|del\s+personale|dei\s+(?:mezzi|trasporti|dipendenti)|"
    r"dell[ae]\s+(?:scuola|sanita|raccolta|trasporti)|trasporti|scuola|sanita)\b|\bproclamazione\s+(?:dello\s+)?sciopero\b"
    r"|\binterruzione\s+(?:acqua|energia|servizio)\b"
    r"|kundmachung|bekanntmachung|amtliche\s+mitteilung|\bmull(?:abfuhr|entsorgung|kalender)?\b|muellabfuhr|restmull"  # DE
    r"|abfallentsorgung|recyclinghof|stra(?:ss|ß)ensperre|sperrung|ausschreibung|\bwarnung\b|wasserunterbrechung"
    r"|\bavis\b|\bdechets\b|\bordures\b|\bramassage\b|\balerte\b|\bcoupure\s+(?:d eau|d electricite|de courant)\b"  # FR
    r"|fermeture\s+(?:de la route|du bureau|des bureaux)|appel d offres")
#: truffe: avviso solo se il titolo è un allarme; "Come prevenire e difendersi dalle truffe" è un incontro
TRUFFE_RE = re.compile(r"\b(?:attenzione|allerta|avviso|tentativi?|false?)\b.*\btruff\w*|\btruff\w*\b.*\b(?:in corso|anziani)\b")
TRUFFE_KEEP_RE = re.compile(r"\b(?:come|prevenire|difendersi|difendere|difesa|proteggersi|riconoscere|imparare)\b")
#: stagioni teatrali/concertistiche/cinematografiche: eventi longRunning, non riepiloghi
SEASON_RE = re.compile(r"\bstagione\s+(?:teatral\w*|concertistic\w*|cinematografic\w*|music\w*|lirica|di prosa|sinfonica)\b|^stagione\b")
EVENT_WORD_RE = re.compile(
    r"\b(?:incontro|conferenza|serata|convegno|laboratori\w*|corso|spettacol\w*|concert\w*|mostra|cerimonia|festa|"
    r"presentazione|assemblea|passeggiata|visita|giornata|workshop|evento)\b"
    r"|veranstaltung|konzert|vortrag|ausstellung|lesung|\bfest\b|\bfeier\b|\bmarkt\b|wanderung|\bkurs\b|theater|\bfuhrung\b"  # DE
    r"|\bconcert\b|\bspectacle\b|\bexposition\b|\bconference\b|\bsoiree\b|\bfete\b|\batelier\b|\bvisite\b|\brencontre\b")

#: "Video: ..." come titolo di servizio
VIDEO_RE = re.compile(r"^video\b|\bvideo\s+(?:messaggio|istituzionale|del sindaco|integrale)\b|\bdiretta\s+streaming\b")


def is_season(title: str) -> bool:
    return bool(SEASON_RE.search(_norm(title)))


YEAR_RE = re.compile(r"\b(20\d\d)\b")
#: «2026/27», «2026-27», «2026/2027»: una stagione, vale l'anno più alto
SEASON_YEARS_RE = re.compile(r"\b(20\d\d)\s*[/\-–]\s*(\d{4}|\d{2})\b")
#: «1936-2020»: anni di vita o di attività, non un'edizione
LIFESPAN_RE = re.compile(r"\b1\d\d\d\s*[/\-–]\s*20\d\d\b")
#: un anno più vecchio di tanti anni rispetto all'inizio non è un'edizione scaduta ma un nome («Merano 2000»); vedi docs/importer.md
PAST_EDITION_YEARS = 10


def title_years(title: str) -> list[int]:
    """Anni del titolo che possono dichiarare un'edizione: stagioni «2026/27» valgono per l'anno più alto, gli intervalli
    che partono dal Novecento («1936-2020») non contano."""
    t = LIFESPAN_RE.sub(" ", title)
    years = []
    for m in SEASON_YEARS_RE.finditer(t):
        first, second = int(m[1]), m[2]
        years.append(int(second) if len(second) == 4 else first // 100 * 100 + int(second))
    t = SEASON_YEARS_RE.sub(" ", t)
    return years + [int(y) for y in YEAR_RE.findall(t)]


def exclusion_reason(title: str, start_year: int | None = None) -> str | None:
    """Motivo per cui la pagina non è un evento pubblico, None se va importata.

    start_year: anno di inizio dell'evento; un titolo con un anno precedente ("Natale 2023") è un'edizione vecchia
    la cui data, scritta senza anno, è stata portata al prossimo. Contano solo gli anni entro PAST_EDITION_YEARS
    dall'inizio e, per le stagioni («2026/27»), l'anno più alto."""
    t = _norm(title)
    if not t:
        return None
    if start_year and (years := [y for y in title_years(title) if y >= start_year - PAST_EDITION_YEARS]) and max(years) < start_year:
        return "edizione passata"
    if is_season(title):
        return None
    if t in GENERIC_TITLES:
        return "titolo generico"
    if SUMMARY_RE.search(t):
        return "pagina riassuntiva"
    if SEDUTA_RE.search(t):
        return "seduta di consiglio/giunta"
    if VIDEO_RE.search(t):
        return "video"
    if NOTICE_RE.search(t) and not EVENT_WORD_RE.search(t):
        return "avviso"
    if TRUFFE_RE.search(t) and not (EVENT_WORD_RE.search(t) or TRUFFE_KEEP_RE.search(t)):
        return "avviso"
    return None
