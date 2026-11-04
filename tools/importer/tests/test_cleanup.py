"""Pulizia: una regola per test, più il tetto di cancellazioni."""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))
from cleanup import DAY, expired_events, expired_limits, expired_reports, expired_submissions, run  # noqa: E402
from fake_firestore import FakeFirestore  # noqa: E402

NOW = datetime(2026, 12, 1, 6, 0, tzinfo=timezone.utc)
NOW_MS = int(NOW.timestamp() * 1000)


def ev(source, ended_days_ago, **extra):
    return {"source": source, "endTime": NOW_MS - ended_days_ago * DAY} | extra


def sub(status, reviewed_days_ago):
    return {"status": status, "reviewedAt": NOW - timedelta(days=reviewed_days_ago)}


def test_scraper_finiti_da_piu_di_7_giorni():
    docs = {"vecchio": ev("scraper", 8), "recente": ev("scraper", 6)}
    assert expired_events(docs, NOW_MS) == ["vecchio"]


def test_removed_da_piu_di_30_giorni():
    docs = {"a": ev("scraper", -5, removedAt=NOW_MS - 31 * DAY), "b": ev("scraper", -5, removedAt=NOW_MS - 29 * DAY)}
    assert expired_events(docs, NOW_MS) == ["a"]


def test_manual_e_user_finiti_da_piu_di_30_giorni():
    docs = {"m31": ev("manual", 31), "m10": ev("manual", 10), "u31": ev("user", 31), "u10": ev("user", 10)}
    assert expired_events(docs, NOW_MS) == ["m31", "u31"]


def test_submissions_rifiutate_90_approvate_30():
    docs = {"r91": sub("rejected", 91), "r89": sub("rejected", 89), "a31": sub("approved", 31),
            "a29": sub("approved", 29), "p": sub("pending", 400)}
    assert expired_submissions(docs, NOW_MS) == ["r91", "a31"]


def test_run_elimina_solo_i_candidati_e_dry_run_non_tocca_nulla():
    data = {"events/old": ev("scraper", 9), "events/new": ev("scraper", 1), "events/man": ev("manual", 9),
            "submissions/a": sub("approved", 40), "submissions/p": sub("pending", 40)}
    db = FakeFirestore(data)
    assert run(db, NOW, dry_run=True)["due"] == 2 and db.writes == 0
    stats = run(db, NOW)
    assert stats["deleted"] == 2 and set(db.data) == {"events/new", "events/man", "submissions/p"}


def test_tetto_di_cancellazioni_e_lotti():
    db = FakeFirestore({f"events/e{i}": ev("scraper", 9) for i in range(1000)})
    stats = run(db, NOW, max_deletes=900)
    assert (stats["due"], stats["deleted"], db.writes, db.commits) == (1000, 900, 900, 3)
    assert len(db.data) == 100


def rep(status, decided_days_ago):
    return {"status": status, "decidedAt": NOW - timedelta(days=decided_days_ago)}


def test_segnalazioni_chiuse_da_piu_di_180_giorni_le_aperte_mai():
    docs = {"r181": rep("removed", 181), "d181": rep("dismissed", 181), "r179": rep("removed", 179),
            "aperta": {"status": "open"}}
    assert expired_reports(docs, NOW_MS) == ["r181", "d181"]


def test_run_elimina_le_segnalazioni_vecchie_e_non_le_aperte():
    db = FakeFirestore({"reports/old": rep("dismissed", 200), "reports/new": rep("dismissed", 10),
                        "reports/open": {"status": "open"}})
    assert run(db, NOW)["deleted"] == 1
    assert set(db.data) == {"reports/new", "reports/open"}


def lim(idle_days, favs=0):
    return {"favAt": NOW - timedelta(days=idle_days), "favCount": favs, "favChanges": 3}


def test_contatori_limits_di_account_eliminati_o_fermi_da_30_giorni_senza_preferiti():
    docs = {"gone": lim(1, 5), "idle0": lim(31), "idle_favs": lim(90, 7), "recent": lim(2), "limite": lim(30)}
    assert expired_limits(docs, {"gone"}, NOW_MS) == ["gone", "idle0"]  # con preferiti restano (tetto di 200), a 30 giorni esatti pure


def test_run_elimina_i_contatori_e_il_controllo_account_e_facoltativo():
    data = {"limits/gone": lim(1, 5), "limits/idle0": lim(40), "limits/idle_favs": lim(40, 3), "limits/ok": lim(1)}
    db = FakeFirestore(dict(data))
    assert run(db, NOW, accounts=lambda uids: {"gone"} & set(uids), delete_limits=True)["deleted"] == 2
    assert set(db.data) == {"limits/idle_favs", "limits/ok"}
    db2 = FakeFirestore(dict(data))  # senza controllo account: solo la regola dei 30 giorni
    assert run(db2, NOW, delete_limits=True)["deleted"] == 1 and "limits/gone" in db2.data
    db3 = FakeFirestore(dict(data))  # Authentication non risponde: nessun errore, nessun account considerato eliminato
    def down(_):
        raise RuntimeError("auth giù")
    assert run(db3, NOW, accounts=down, delete_limits=True)["deleted"] == 1 and "limits/gone" in db3.data
    db4 = FakeFirestore(dict(data))
    assert run(db4, NOW, dry_run=True, accounts=lambda u: {"gone"}, delete_limits=True)["due"] == 2 and db4.writes == 0


def test_limits_flag_spento_di_default_conta_e_non_elimina(caplog):
    data = {"limits/gone": lim(1, 5), "limits/idle0": lim(40), "limits/idle_favs": lim(40, 3), "limits/ok": lim(1)}
    db = FakeFirestore(dict(data))
    with caplog.at_level("INFO", logger="importer"):
        stats = run(db, NOW, accounts=lambda uids: {"gone"})
    assert (stats["deleted"], stats["limits_due"], set(db.data)) == (0, 2, set(data))
    assert "NON eliminati" in caplog.text and "gone" not in caplog.text and "idle0" not in caplog.text  # nel log solo numeri
