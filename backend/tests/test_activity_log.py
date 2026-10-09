from datetime import datetime, timedelta, timezone

from app import models as m
from conftest import login


def log(client, ids, **params):
    return client.get(f"/v1/app/patients/{ids['patient']}/activity", params=params)


def note(client, ids, headers, wording, recipients=()):
    response = client.post(f"/v1/app/patients/{ids['patient']}/proposals", headers=headers,
                           json={"kind": "health_note", "payload": {"wording": wording, "share_with_user_ids": list(recipients)}})
    assert response.status_code == 201, response.text
    proposal = response.json()
    saved = client.post(f"/v1/app/proposals/{proposal['id']}/confirm", headers=headers, json={"confirmed": True})
    assert saved.status_code == 200, saved.text
    return saved.json()["record_id"]


def test_log_uses_confirmed_evidence_filters_and_no_store(env):
    client, app, ids = env
    headers = login(client)
    note(client, ids, headers, "Fictional morning concern")
    response = log(client, ids, category="notes", search="morning")
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "private, no-store"
    rows = response.json()["items"]
    assert len(rows) == 2
    assert rows[0]["event"] == "Care note confirmed"
    assert rows[1]["event"] == "Care note proposed"
    assert rows[0]["status"] == "confirmed"
    assert rows[0]["source"] == "Care dashboard"
    assert log(client, ids, search="%_not_a_wildcard").json()["items"] == []


def test_record_visibility_is_current_and_precedes_pagination(env):
    client, app, ids = env
    headers = login(client)
    shared = note(client, ids, headers, "SHARED_NOTE", [ids["caregiver"]])
    note(client, ids, headers, "PRIVATE_NOTE")
    client.post("/v1/auth/logout", headers=headers)
    caregiver = login(client, "caregiver@example.invalid", "caregiver-password")
    rows = log(client, ids, limit=1).json()
    assert len(rows["items"]) == 1 and "SHARED_NOTE" in str(rows)
    assert "PRIVATE_NOTE" not in str(rows)
    cursor = rows["next_cursor"]
    assert cursor
    client.post("/v1/auth/logout", headers=caregiver)
    owner = login(client)
    client.put(f"/v1/app/notes/{shared}/sharing", headers=owner, json={"user_ids": []})
    client.post("/v1/auth/logout", headers=owner)
    login(client, "caregiver@example.invalid", "caregiver-password")
    assert log(client, ids, cursor=cursor).json()["items"] == []
    assert log(client, ids).json()["items"] == []


def test_deleted_note_text_never_survives_in_log(env):
    client, app, ids = env
    owner = login(client)
    saved = note(client, ids, owner, "DELETED_SECRET")
    assert client.delete(f"/v1/app/notes/{saved}", headers=owner).status_code == 204
    data = log(client, ids).json()
    assert "DELETED_SECRET" not in str(data)
    assert any(row["event"] == "Care note deleted" for row in data["items"])


def test_recordings_are_receipt_metadata_and_owner_scoped(env):
    client, app, ids = env
    db = app.state.db.SessionLocal()
    db.add(m.VoiceTurn(device_id=ids["device"], patient_id=ids["patient"], idempotency_key="log-turn",
                       content_sha256="a" * 64, status="failed", transcript="PRIVATE_TRANSCRIPT",
                       processing_error="PROVIDER_SECRET", result={"token": "SECRET_TOKEN"}, raw_audio=b"PRIVATE_AUDIO"))
    db.add(m.AuditEvent(patient_id=ids["patient"], actor_type="system", action="device.claimed",
                        details={"credential": "AUDIT_SECRET"}))
    db.commit()
    db.close()
    owner = login(client)
    data = log(client, ids).json()
    assert any(row["category"] == "recordings" and row["status"] == "failed" for row in data["items"])
    assert not any(secret in str(data) for secret in ["PRIVATE_TRANSCRIPT", "PROVIDER_SECRET", "SECRET_TOKEN", "PRIVATE_AUDIO", "AUDIT_SECRET"])
    client.post("/v1/auth/logout", headers=owner)
    login(client, "caregiver@example.invalid", "caregiver-password")
    assert log(client, ids).json()["items"] == []


def test_keyset_history_is_stable_beyond_dashboard_cap(env):
    client, app, ids = env
    db = app.state.db.SessionLocal()
    at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    plan = m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone="Asia/Singapore", source="Fictional plan",
                                   checked_by_user_id=ids["owner"], checked_by_name="Owner", medicines=[], schedule=[])
    db.add(plan)
    db.flush()
    for n in range(105):
        dose = m.DoseInstance(id=f"dose_log_{n}", patient_id=ids["patient"], plan_id=plan.id, plan_version=1,
                              medicine_id="med", medicine_name="Fictional med", scheduled_at=at + timedelta(minutes=n))
        db.add(dose)
        db.add(m.ConfirmationProposal(id=f"prop_log_{n:03d}", patient_id=ids["patient"], kind="medication_report",
                                      payload={"report_state": "reported_taken"}, readback="Fictional report",
                                      record_type="dose", record_id=dose.id, status="committed", created_at=at,
                                      confirmed_at=at, expires_at=at + timedelta(days=1)))
    db.commit()
    db.close()
    login(client)
    seen, cursor = [], None
    while True:
        data = log(client, ids, category="medications", limit=17, **({"cursor": cursor} if cursor else {})).json()
        seen.extend(row["id"] for row in data["items"])
        cursor = data["next_cursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) == 211  # 105 proposals + 105 confirmations + plan


def test_local_date_boundary_and_filter_validation(env):
    client, app, ids = env
    db = app.state.db.SessionLocal()
    for key, at in [("previous", "2026-05-01T15:59:59+00:00"), ("start", "2026-05-01T16:00:00+00:00"),
                    ("end", "2026-05-02T15:59:59+00:00"), ("next", "2026-05-02T16:00:00+00:00")]:
        db.add(m.AuditEvent(id=key, patient_id=ids["patient"], actor_type="system", action="device.claimed",
                            created_at=datetime.fromisoformat(at)))
    db.commit()
    db.close()
    login(client)
    rows = log(client, ids, start="2026-05-02", end="2026-05-02").json()["items"]
    assert {row["record_id"] for row in rows} == {"start", "end"}
    for params in [{"start": "2026-05-03", "end": "2026-05-01"}, {"cursor": "bad"},
                   {"category": "unknown"}, {"limit": 101}, {"start": "2026-99-99"},
                   {"start": "0001-01-01"}, {"end": "9999-12-31"}]:
        assert log(client, ids, **params).status_code == 422


def test_old_draft_cannot_bypass_note_deletion_or_unsharing(env):
    client, app, ids = env
    headers = login(client)
    response = client.post(f"/v1/app/patients/{ids['patient']}/proposals", headers=headers,
                           json={"kind": "health_note", "payload": {"wording": "OLD_DRAFT_SECRET",
                                 "share_with_user_ids": [ids["caregiver"]]}})
    revised = client.post(f"/v1/app/proposals/{response.json()['id']}/revise", headers=headers,
                          json={"payload": {"wording": "CURRENT_NOTE_SECRET", "share_with_user_ids": [ids["caregiver"]]}})
    assert revised.status_code == 201, revised.text
    saved = client.post(f"/v1/app/proposals/{revised.json()['id']}/confirm", headers=headers, json={"confirmed": True})
    note_id = saved.json()["record_id"]
    assert client.put(f"/v1/app/notes/{note_id}/sharing", headers=headers, json={"user_ids": []}).status_code == 200
    client.post("/v1/auth/logout", headers=headers)
    caregiver = login(client, "caregiver@example.invalid", "caregiver-password")
    assert log(client, ids, category="notes").json()["items"] == []
    client.post("/v1/auth/logout", headers=caregiver)
    owner = login(client)
    assert client.delete(f"/v1/app/notes/{note_id}", headers=owner).status_code == 204
    data = str(log(client, ids).json())
    assert "OLD_DRAFT_SECRET" not in data and "CURRENT_NOTE_SECRET" not in data


def test_missing_or_revoked_grant_is_denied(env):
    client, app, ids = env
    assert log(client, ids).status_code == 401
    login(client, "outsider@example.invalid", "outsider-password")
    assert log(client, ids).status_code == 403
    client.cookies.clear()
    login(client, "caregiver@example.invalid", "caregiver-password")
    db = app.state.db.SessionLocal()
    grant = db.query(m.AccessGrant).filter_by(user_id=ids["caregiver"], patient_id=ids["patient"]).one()
    grant.revoked_at = datetime.now(timezone.utc)
    db.commit()
    db.close()
    assert log(client, ids).status_code == 403


def test_summary_vocabulary_and_category_grants(env):
    client, app, ids = env
    owner = login(client)
    response = client.post(f"/v1/app/patients/{ids['patient']}/summaries", headers=owner,
                           json={"start_date": "2026-05-01", "end_date": "2026-05-02"})
    assert response.status_code == 201
    vocabulary = client.put(f"/v1/app/patients/{ids['patient']}/vocabulary", headers=owner,
                            json={"expected_version": 0, "terms": [{"canonical": "Fictional name", "aliases": [], "category": "person"}]})
    assert vocabulary.status_code == 200, vocabulary.text
    assert any(row["event"] == "Summary prepared" for row in log(client, ids).json()["items"])
    assert any(row["event"] == "Reviewed care names saved" for row in log(client, ids).json()["items"])
    client.post("/v1/auth/logout", headers=owner)
    db = app.state.db.SessionLocal()
    grant = db.query(m.AccessGrant).filter_by(user_id=ids["caregiver"], patient_id=ids["patient"]).one()
    grant.scopes = ["read:measurements"]
    db.commit()
    db.close()
    login(client, "caregiver@example.invalid", "caregiver-password")
    assert log(client, ids).json()["items"] == []


def test_support_outcomes_keep_history_and_recipient_visibility(env):
    client, app, ids = env
    headers = login(client)
    proposed = client.post(f"/v1/app/patients/{ids['patient']}/proposals", headers=headers,
                           json={"kind": "support_request", "payload": {"request_text": "Fictional ride request",
                                 "recipient_user_id": ids["caregiver_two"], "urgency": "routine"}})
    assert proposed.status_code == 201, proposed.text
    saved = client.post(f"/v1/app/proposals/{proposed.json()['id']}/confirm", headers=headers, json={"confirmed": True})
    support_id = saved.json()["record_id"]
    for outcome in ["First fictional outcome", "Later fictional outcome"]:
        assert client.post(f"/v1/app/support-requests/{support_id}/resolve", headers=headers, json={"outcome": outcome}).status_code == 200
    outcomes = [row for row in log(client, ids, category="support").json()["items"] if row["event"] == "Support outcome recorded"]
    assert [row["summary"] for row in outcomes] == ["Later fictional outcome", "First fictional outcome"]
    client.post("/v1/auth/logout", headers=headers)
    caregiver = login(client, "caregiver@example.invalid", "caregiver-password")
    assert log(client, ids, category="support").json()["items"] == []
    client.post("/v1/auth/logout", headers=caregiver)
    login(client, "caregiver2@example.invalid", "caregiver2-password")
    assert len([row for row in log(client, ids).json()["items"] if row["event"] == "Support outcome recorded"]) == 2
