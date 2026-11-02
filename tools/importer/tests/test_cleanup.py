"""Pulizia: una regola per test, più il tetto di cancellazioni."""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))
from cleanup import DAY, expired_events, expired_reports, expired_submissions, run  # noqa: E402
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
