"""#54, blocco 3: download dei dati del Mac nel job import. Mai un errore dell'import; permessi e segreti nel posto giusto."""

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import ci_report  # noqa: E402

WORKFLOW = Path(__file__).parents[3] / ".github" / "workflows" / "import-events.yml"


class FakeGh:
    def __init__(self, runs=None, fail=None, files=("a.json", "b.json")):
        self.runs, self.fail, self.files, self.calls = runs, fail, files, []

    def __call__(self, cmd, **kw):
        self.calls.append(cmd)
        assert cmd[0] == "gh"
        if self.fail:
            raise subprocess.CalledProcessError(1, cmd)
        if cmd[1] == "api":
            return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps({"workflow_runs": self.runs}), stderr="")
        dest = Path(cmd[cmd.index("-D") + 1])
        dest.mkdir(parents=True, exist_ok=True)
        for f in self.files:
            (dest / f).write_text("{}", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


@pytest.fixture
def out(tmp_path, monkeypatch):
    f = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(f))
    monkeypatch.setenv("GITHUB_REPOSITORY", "AndreaAzzarello/EventiVicini")
    return f


def test_scarica_l_ultimo_run_riuscito_su_main_e_scrive_dir(tmp_path, monkeypatch, out):
    gh = FakeGh(runs=[{"id": 123, "created_at": "2026-11-13T06:45:00Z"}])
    monkeypatch.setattr(ci_report.subprocess, "run", gh)
    dest = tmp_path / "fonti-mac"
    assert ci_report.mac_artifact(dest) is True
    api = gh.calls[0][2]
    assert "workflows/scarica-fonti.yml/runs" in api and "branch=main" in api and "status=success" in api
    assert gh.calls[1][:3] == ["gh", "run", "download"] and "123" in gh.calls[1] and "fonti-mac" in gh.calls[1]
    assert out.read_text(encoding="utf-8") == f"dir={dest}\n"


def test_nessun_run_riuscito_non_e_un_errore_e_non_scrive_dir(tmp_path, monkeypatch, out):
    monkeypatch.setattr(ci_report.subprocess, "run", FakeGh(runs=[]))
    assert ci_report.mac_artifact(tmp_path / "x") is False
    assert not out.exists() or out.read_text(encoding="utf-8") == ""


def test_errore_di_gh_o_risposta_strana_non_ferma_l_import(tmp_path, monkeypatch, out, capsys):
    monkeypatch.setattr(ci_report.subprocess, "run", FakeGh(fail=True))
    assert ci_report.mac_artifact(tmp_path / "x") is False
    assert "::warning::" in capsys.readouterr().out
    monkeypatch.setattr(ci_report.subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout="non json", stderr=""))
    assert ci_report.mac_artifact(tmp_path / "x") is False
    monkeypatch.setattr(ci_report.subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout="[1]", stderr=""))
    assert ci_report.mac_artifact(tmp_path / "x") is False  # lista invece di oggetto


def test_il_comando_esce_sempre_con_0(tmp_path, monkeypatch, out):
    monkeypatch.setattr(ci_report.subprocess, "run", FakeGh(fail=True))
    assert ci_report.main(["mac-artifact", str(tmp_path / "x")]) == 0


def steps(job: str) -> list[str]:
    text = WORKFLOW.read_text(encoding="utf-8").replace("\r\n", "\n")
    body = re.split(rf"(?m)^  {job}:\n", text)[1]
    body = re.split(r"(?m)^  [a-z]+:\n", body)[0]
    return re.split(r"(?m)^      - ", body)


def test_actions_read_solo_nel_job_import_e_senza_segreti_nel_passo_di_download():
    text = WORKFLOW.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert len(re.findall(r"(?m)^\s+actions: read$", text)) == 2  # guard (già c'era) e import
    top = text.split("\njobs:")[0]
    assert "contents: read" in top and "actions: read" not in top
    job_import = re.split(r"(?m)^  import:\n", text)[1].split("\n  cleanup:")[0]
    assert "permissions:\n      contents: read\n      actions: read" in job_import
    mac = next(s for s in steps("import") if "Dati del Mac mini" in s)
    assert "FIREBASE_SERVICE_ACCOUNT" not in mac and "TICKETMASTER" not in mac and "continue-on-error: true" in mac
    assert "python ci_report.py mac-artifact fonti-mac" in mac and "id: mac" in mac
    importer = next(s for s in steps("import") if "name: Importer" in s)
    assert 'MAC_DIR: ${{ steps.mac.outputs.dir }}' in importer and '${MAC_DIR:+--fonti-mac "$MAC_DIR"}' in importer


def test_il_passo_del_mac_viene_prima_dell_importer_e_la_cache_non_cambia():
    names = [re.search(r"name: (.+)", s).group(1) for s in steps("import") if "name:" in s.split("\n")[0] + "\n" + s and re.search(r"name: (.+)", s)]
    assert names.index("Dati del Mac mini") < names.index("Importer")
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "fonti-mac" not in text.split("- name: Dati del Mac mini")[0]  # nessun percorso nuovo nelle cache
