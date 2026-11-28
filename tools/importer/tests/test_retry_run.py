"""Ritento dell'import nello stesso job (Molise falliva a intermittenza, 27 e 28/11): un solo secondo tentativo, mai su quota."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from ci_report import run_with_retry  # noqa: E402

CMD = ["python", "run.py", "--regione", "molise"]


class Fake:
    def __init__(self, *codes):
        self.codes, self.calls, self.sleeps, self.lines = list(codes), 0, [], []

    def run(self, cmd):
        assert cmd == CMD
        self.calls += 1
        return self.codes.pop(0)

    def go(self, env=None):
        env = {"REGION": "molise", "RETRY_WAIT": "7", **(env or {})}
        return run_with_retry(CMD, env, runner=self.run, sleeper=self.sleeps.append, out=self.lines.append)


def test_riuscito_al_primo_tentativo_non_aspetta_e_non_annota():
    f = Fake(0)
    assert f.go() == 0 and f.calls == 1 and f.sleeps == [] and f.lines == []


def test_nessun_evento_riprova_una_volta_dopo_l_attesa_e_non_avvisa():
    f = Fake(1, 0)
    assert f.go() == 0 and f.calls == 2 and f.sleeps == [7]
    assert not any(l.startswith("::error") for l in f.lines)
    assert any("riuscito al secondo tentativo" in l for l in f.lines)


def test_fallito_anche_al_ritento_un_solo_ritento_e_avviso_nel_formato_di_avviso_calo():
    f = Fake(1, 1, 0)  # il terzo codice non deve mai essere usato
    assert f.go() == 1 and f.calls == 2 and f.sleeps == [7]
    assert f.lines[-1] == "::error title=Import non riuscito::molise: fallito anche al ritento (codice 1)"


def test_quota_superata_non_si_ritenta():
    f = Fake(2)
    assert f.go() == 2 and f.calls == 1 and f.sleeps == []
    assert f.lines[-1].startswith("::error title=Import non riuscito::molise: uscito con 2")


def test_errore_forzato_solo_nel_dry_run_e_solo_per_la_regione_indicata():
    f = Fake(0)  # senza DRY_RUN l'errore forzato è ignorato
    assert f.go({"FORZA_ERRORE": "molise"}) == 0 and f.calls == 1
    f = Fake(0)  # altra regione
    assert f.go({"DRY_RUN": "true", "FORZA_ERRORE": "lazio"}) == 0 and f.calls == 1


def test_errore_forzato_fallisce_il_primo_tentativo_e_il_ritento_passa():
    f = Fake(0)  # l'importer gira solo al secondo tentativo
    assert f.go({"DRY_RUN": "true", "FORZA_ERRORE": "molise"}) == 0 and f.calls == 1 and f.sleeps == [7]
    assert not any(l.startswith("::error") for l in f.lines)


def test_errore_forzato_sempre_fa_scattare_l_avviso_senza_lanciare_l_importer():
    f = Fake()
    assert f.go({"DRY_RUN": "true", "FORZA_ERRORE": "molise", "FORZA_SEMPRE": "true"}) == 1 and f.calls == 0
    assert f.lines[-1].startswith("::error title=Import non riuscito::molise: fallito anche al ritento")


def test_attesa_non_valida_ripiega_sul_valore_predefinito():
    f = Fake(1, 0)
    f.go({"RETRY_WAIT": "boh"})
    assert f.sleeps == [300]
