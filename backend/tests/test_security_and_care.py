from datetime import timedelta

from sqlalchemy import select

from app import models as m
from app.security import utcnow
from conftest import ORIGIN, login


def create_plan(client, patient_id, headers):
    response = client.post(
        "/v1/app/patients/%s/medication-plans" % patient_id,
        json={
            "timezone": "Asia/Singapore",
            "source": "Fictional reviewed label",
            "checked": True,
            "medicines": [{"id": "med_one", "name": "DemoMed", "instructions": "One fictional tablet", "reviewed_reference": "Reviewed fictional reference", "reference_source": "Demo label v1"}],
            "schedule": [{"medicine_id": "med_one", "local_time": "23:59"}],
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_origin_csrf_and_cross_account_fail_closed(env):
    client, app, ids = env
    assert client.post("/v1/auth/login", json={"email": "owner@example.invalid", "password": "owner-password"}).status_code == 403
    headers = login(client)
    response = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "health_note", "payload": {"wording": "Reported sore knee"}}, headers={"Origin": ORIGIN})
    assert response.status_code == 403
    assert client.get("/v1/app/patients/%s/dashboard" % ids["other_patient"]).status_code == 403


def test_owner_updates_chosen_name_language_timezone_check_in_and_calling_route(env):
    client, app, ids = env
    headers = login(client)
    response = client.put("/v1/app/patients/%s/profile" % ids["patient"], json={"preferred_name": "Auntie Mei", "language": "en-SG", "timezone": "Asia/Singapore", "daily_check_in_enabled": True, "daily_check_in_local_time": "09:05", "calling_route": "Call the configured family number"}, headers=headers)
    assert response.status_code == 200, response.text
    patient = client.get("/v1/app/patients/%s/dashboard" % ids["patient"]).json()["patient"]
    assert (patient["preferred_name"], patient["language"], patient["daily_check_in_local_time"]) == ("Auntie Mei", "en-SG", "09:05")
    assert patient["calling_route"] == "Call the configured family number"

    urgent = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "support_request", "payload": {"request_text": "Please call me", "recipient_user_id": ids["caregiver"], "urgency": "urgent"}}, headers=headers)
    assert urgent.status_code == 201
    assert "Call the configured family number" in urgent.json()["readback"]
    assert "does not dispatch help" in urgent.json()["readback"]


def test_revise_invalidates_old_and_confirmation_is_idempotent(env):
    client, app, ids = env
    headers = login(client)
    created = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "health_note", "payload": {"wording": "Pain in right knee", "occurrence_text": "after lunch"}}, headers=headers)
    assert created.status_code == 201
    old = created.json()
    revised = client.post("/v1/app/proposals/%s/revise" % old["id"], json={"payload": {"wording": "Pain in left knee", "occurrence_text": "after lunch"}}, headers=headers)
    assert revised.status_code == 201
    assert client.post("/v1/app/proposals/%s/confirm" % old["id"], json={"confirmed": True}, headers=headers).status_code == 409
    new_id = revised.json()["id"]
    first = client.post("/v1/app/proposals/%s/confirm" % new_id, json={"confirmed": True}, headers=headers)
    second = client.post("/v1/app/proposals/%s/confirm" % new_id, json={"confirmed": True}, headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    dashboard = client.get("/v1/app/patients/%s/dashboard" % ids["patient"]).json()
    assert [note["wording"] for note in dashboard["notes"]] == ["Pain in left knee"]


def test_expired_proposal_cannot_create_a_record(env):
    client, app, ids = env
    headers = login(client)
    proposed = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "health_note", "payload": {"wording": "Temporary draft"}}, headers=headers).json()
    db = app.state.db.SessionLocal()
    row = db.get(m.ConfirmationProposal, proposed["id"])
    row.expires_at = utcnow() - timedelta(seconds=1)
    db.commit(); db.close()
    response = client.post("/v1/app/proposals/%s/confirm" % proposed["id"], json={"confirmed": True}, headers=headers)
    assert response.status_code == 409
    db = app.state.db.SessionLocal()
    assert db.scalar(select(m.HealthNote).where(m.HealthNote.proposal_id == proposed["id"])) is None
    db.close()


def test_checked_plan_versions_and_stale_dose_proposal_cannot_commit(env):
    client, app, ids = env
    headers = login(client)
    first_plan = create_plan(client, ids["patient"], headers)
    db = app.state.db.SessionLocal()
    dose = db.scalar(select(m.DoseInstance).where(m.DoseInstance.plan_id == first_plan["id"]))
    dose_id = dose.id
    db.close()
    proposal = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "medication_report", "payload": {"dose_instance_id": dose_id, "report_state": "reported_taken", "taken_time_text": "around breakfast"}}, headers=headers)
    assert proposal.status_code == 201
    second_plan = create_plan(client, ids["patient"], headers)
    assert second_plan["version"] == first_plan["version"] + 1
    stale = client.post("/v1/app/proposals/%s/confirm" % proposal.json()["id"], json={"confirmed": True}, headers=headers)
    assert stale.status_code == 409
    db = app.state.db.SessionLocal()
    assert db.get(m.DoseInstance, dose_id).report_state == "unconfirmed"
    db.close()


def test_confirmed_dose_report_invalidates_existing_summary(env):
    client, app, ids = env
    headers = login(client)
    plan = create_plan(client, ids["patient"], headers)
    db = app.state.db.SessionLocal()
    dose = db.scalar(select(m.DoseInstance).where(m.DoseInstance.plan_id == plan["id"]))
    dose_id = dose.id; db.close()
    summary = client.post("/v1/app/patients/%s/summaries" % ids["patient"], json={"start_date": "2020-01-01", "end_date": "2030-01-01"}, headers=headers).json()
    report = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "medication_report", "payload": {"dose_instance_id": dose_id, "report_state": "reported_not_yet"}}, headers=headers).json()
    client.post("/v1/app/proposals/%s/confirm" % report["id"], json={"confirmed": True}, headers=headers)
    db = app.state.db.SessionLocal()
    assert db.get(m.VisitSummary, summary["id"]).invalidated_at is not None
    db.close()


def test_measurement_correction_invalidates_shared_summary(env):
    client, app, ids = env
    headers = login(client)
    base_payload = {"measurement_type": "blood_pressure", "systolic": 128, "diastolic": 76, "unit": "mmHg", "occurrence_text": "this morning", "timezone": "Asia/Singapore", "source_description": "existing home cuff", "reporting_actor": "patient"}
    proposed = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "measurement", "payload": base_payload}, headers=headers).json()
    committed = client.post("/v1/app/proposals/%s/confirm" % proposed["id"], json={"confirmed": True}, headers=headers).json()
    measurement_id = committed["record_id"]
    summary = client.post("/v1/app/patients/%s/summaries" % ids["patient"], json={"start_date": "2020-01-01", "end_date": "2030-01-01"}, headers=headers).json()
    reviewed = client.put("/v1/app/summaries/%s" % summary["id"], json={"sections": summary["sections"], "omitted_source_ids": [], "reviewed": True}, headers=headers)
    assert reviewed.status_code == 200
    share = client.post("/v1/app/summaries/%s/share" % summary["id"], json={"expires_in_seconds": 3600}, headers=headers).json()
    assert client.get(share["url"]).status_code == 200
    correction = dict(base_payload, systolic=118, supersedes_id=measurement_id)
    corrected_prop = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "measurement", "payload": correction}, headers=headers).json()
    assert client.post("/v1/app/proposals/%s/confirm" % corrected_prop["id"], json={"confirmed": True}, headers=headers).status_code == 200
    assert client.get(share["url"]).status_code == 410
    dashboard = client.get("/v1/app/patients/%s/dashboard" % ids["patient"]).json()
    assert [(item["systolic"], item["diastolic"]) for item in dashboard["measurements"]] == [(118, 76)]


def test_summary_schema_source_omission_and_patient_timezone_boundary(env):
    client, app, ids = env
    headers = login(client)
    proposed = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "health_note", "payload": {"wording": "Just after local midnight", "occurred_at": "2026-09-21T16:30:00Z", "timezone": "Asia/Singapore"}}, headers=headers).json()
    note_id = client.post("/v1/app/proposals/%s/confirm" % proposed["id"], json={"confirmed": True}, headers=headers).json()["record_id"]
    summary = client.post("/v1/app/patients/%s/summaries" % ids["patient"], json={"start_date": "2026-09-22", "end_date": "2026-09-22"}, headers=headers).json()
    assert any(ref["id"] == note_id for ref in summary["sources"])
    forged = [{"title": "Bad", "items": [], "sources": [{"id": "forged"}]}]
    assert client.put("/v1/app/summaries/%s" % summary["id"], json={"sections": forged, "omitted_source_ids": [], "reviewed": True}, headers=headers).status_code == 422
    reviewed = client.put("/v1/app/summaries/%s" % summary["id"], json={"sections": summary["sections"], "omitted_source_ids": [note_id], "reviewed": True}, headers=headers)
    assert reviewed.status_code == 200
    assert reviewed.json()["sources"] == []
    share = client.post("/v1/app/summaries/%s/share" % summary["id"], json={"expires_in_seconds": 3600}, headers=headers).json()
    public = client.get(share["url"]).json()["summary"]
    assert public["sources"] == []
    assert "omitted_source_ids" not in public and "patient_id" not in public
    assert all(item.get("source_id") != note_id for section in public["sections"] for item in section["items"])


def test_preventive_progress_requires_two_confirmed_transitions(env):
    client, app, ids = env
    headers = login(client)
    created = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "preventive_task", "payload": {"task_type": "screening", "description": "Fictional screening from care plan", "source": "Fictional care plan", "due_date": "2026-09-22", "timezone": "Asia/Singapore", "state": "due"}}, headers=headers).json()
    task_id = client.post("/v1/app/proposals/%s/confirm" % created["id"], json={"confirmed": True}, headers=headers).json()["record_id"]
    arranged = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "preventive_task", "payload": {"task_id": task_id, "state": "arranged", "appointment_date": "2026-10-01"}}, headers=headers).json()
    client.post("/v1/app/proposals/%s/confirm" % arranged["id"], json={"confirmed": True}, headers=headers)
    completed = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "preventive_task", "payload": {"task_id": task_id, "state": "completed", "completion_date": "2026-10-01"}}, headers=headers).json()
    client.post("/v1/app/proposals/%s/confirm" % completed["id"], json={"confirmed": True}, headers=headers)
    db = app.state.db.SessionLocal()
    task = db.get(m.PreventiveTask, task_id)
    transitions = db.scalars(select(m.PreventiveTransition).where(m.PreventiveTransition.task_id == task_id)).all()
    assert task.state == "completed"
    assert [row.to_state for row in transitions] == ["due", "arranged", "completed"]
    db.close()


def test_preventive_transition_preserves_unknown_dates(env):
    client, app, ids = env
    headers = login(client)
    created = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "preventive_task", "payload": {"task_type": "follow-up", "description": "Fictional follow-up", "source": "Fictional care plan", "due_date": "2026-09-22", "timezone": "Asia/Singapore", "state": "due"}}, headers=headers).json()
    task_id = client.post("/v1/app/proposals/%s/confirm" % created["id"], json={"confirmed": True}, headers=headers).json()["record_id"]
    arranged = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "preventive_task", "payload": {"task_id": task_id, "state": "arranged"}}, headers=headers)
    assert arranged.status_code == 201
    assert "appointment date unknown" in arranged.json()["readback"]
    client.post("/v1/app/proposals/%s/confirm" % arranged.json()["id"], json={"confirmed": True}, headers=headers)
    completed = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "preventive_task", "payload": {"task_id": task_id, "state": "completed"}}, headers=headers)
    assert completed.status_code == 201
    assert "completion date unknown" in completed.json()["readback"]


def test_barrier_followup_stays_open_until_human_outcome_and_recipient_acknowledges(env):
    client, app, ids = env
    headers = login(client)
    proposed = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "support_request", "payload": {"request_text": "Please help collect a fictional refill", "recipient_user_id": ids["caregiver"], "urgency": "routine", "barrier_text": "Reported difficulty opening the container"}}, headers=headers).json()
    support_id = client.post("/v1/app/proposals/%s/confirm" % proposed["id"], json={"confirmed": True}, headers=headers).json()["record_id"]
    assert client.post("/v1/app/support-requests/%s/acknowledge" % support_id, headers=headers).status_code == 403
    followup = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "followup", "payload": {"related_type": "support_request", "related_id": support_id, "check_at": "2026-09-23T09:00:00+08:00", "permission_scope": "related_recipients", "resolution_state": "open"}}, headers=headers).json()
    followup_id = client.post("/v1/app/proposals/%s/confirm" % followup["id"], json={"confirmed": True}, headers=headers).json()["record_id"]
    before_ack = client.post("/v1/app/patients/%s/summaries" % ids["patient"], json={"start_date": "2020-01-01", "end_date": "2030-01-01"}, headers=headers).json()
    client.post("/v1/auth/logout", headers=headers)
    second_headers = login(client, "caregiver2@example.invalid", "caregiver2-password")
    second_dashboard = client.get("/v1/app/patients/%s/dashboard" % ids["patient"]).json()
    assert second_dashboard["support_requests"] == []
    assert second_dashboard["followups"] == []
    assert ids["caregiver"] in {item["id"] for item in second_dashboard["allowed_recipients"]}
    assert client.post("/v1/app/support-requests/%s/acknowledge" % support_id, headers=second_headers).status_code == 403
    assert client.post("/v1/app/support-requests/%s/resolve" % support_id, json={"outcome": "should not work"}, headers=second_headers).status_code == 403
    client.post("/v1/auth/logout", headers=second_headers)
    caregiver_headers = login(client, "caregiver@example.invalid", "caregiver-password")
    assigned_dashboard = client.get("/v1/app/patients/%s/dashboard" % ids["patient"]).json()
    assert [item["id"] for item in assigned_dashboard["support_requests"]] == [support_id]
    assert [item["id"] for item in assigned_dashboard["followups"]] == [followup_id]
    acknowledged = client.post("/v1/app/support-requests/%s/acknowledge" % support_id, headers=caregiver_headers)
    assert acknowledged.status_code == 200
    db = app.state.db.SessionLocal()
    assert db.get(m.FollowUp, followup_id).resolution_state == "open"
    assert db.get(m.SupportRequest, support_id).status == "acknowledged"
    assert db.get(m.VisitSummary, before_ack["id"]).invalidated_at is not None
    db.close()
    client.post("/v1/auth/logout", headers=caregiver_headers)
    headers = login(client)
    before_support_resolution = client.post("/v1/app/patients/%s/summaries" % ids["patient"], json={"start_date": "2020-01-01", "end_date": "2030-01-01"}, headers=headers).json()
    resolved_support = client.post("/v1/app/support-requests/%s/resolve" % support_id, json={"outcome": "A human reported that the refill was collected"}, headers=headers)
    assert resolved_support.status_code == 200
    db = app.state.db.SessionLocal()
    assert db.get(m.VisitSummary, before_support_resolution["id"]).invalidated_at is not None
    db.close()
    before_outcome = client.post("/v1/app/patients/%s/summaries" % ids["patient"], json={"start_date": "2020-01-01", "end_date": "2030-01-01"}, headers=headers).json()
    outcome = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "followup", "payload": {"followup_id": followup_id, "reported_outcome": "A human reported that the container was replaced", "resolution_state": "resolved"}}, headers=headers)
    assert outcome.status_code == 201, outcome.text
    assert client.post("/v1/app/proposals/%s/confirm" % outcome.json()["id"], json={"confirmed": True}, headers=headers).status_code == 200
    db = app.state.db.SessionLocal()
    rows = db.scalars(select(m.FollowUp).where(m.FollowUp.patient_id == ids["patient"])).all()
    assert len(rows) == 1 and rows[0].resolution_state == "resolved"
    assert db.scalar(select(m.FollowUpResolution).where(m.FollowUpResolution.followup_id == followup_id)).reported_outcome.startswith("A human reported")
    assert db.get(m.VisitSummary, before_outcome["id"]).invalidated_at is not None
    db.close()


def test_scoped_caregiver_sees_only_permitted_collections(env):
    client, app, ids = env
    owner_headers = login(client)
    note = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "health_note", "payload": {"wording": "Private symptom"}}, headers=owner_headers).json()
    client.post("/v1/app/proposals/%s/confirm" % note["id"], json={"confirmed": True}, headers=owner_headers)
    client.post("/v1/auth/logout", headers=owner_headers)
    caregiver_headers = login(client, "caregiver@example.invalid", "caregiver-password")
    dashboard = client.get("/v1/app/patients/%s/dashboard" % ids["patient"]).json()
    assert dashboard["notes"] == []
    assert dashboard["access_grants"] == []
    assert dashboard["measurements"] == []


def test_private_note_requires_explicit_share_and_revoke_invalidates_summary_link(env):
    client, app, ids = env
    owner_headers = login(client)
    proposed = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "health_note", "payload": {"wording": "Private note"}}, headers=owner_headers).json()
    note_id = client.post("/v1/app/proposals/%s/confirm" % proposed["id"], json={"confirmed": True}, headers=owner_headers).json()["record_id"]
    summary = client.post("/v1/app/patients/%s/summaries" % ids["patient"], json={"start_date": "2020-01-01", "end_date": "2030-01-01"}, headers=owner_headers).json()
    client.put("/v1/app/summaries/%s" % summary["id"], json={"sections": summary["sections"], "omitted_source_ids": [], "reviewed": True}, headers=owner_headers)
    share_url = client.post("/v1/app/summaries/%s/share" % summary["id"], json={"expires_in_seconds": 3600}, headers=owner_headers).json()["url"]
    client.post("/v1/auth/logout", headers=owner_headers)
    caregiver_headers = login(client, "caregiver@example.invalid", "caregiver-password")
    assert client.get("/v1/app/patients/%s/dashboard" % ids["patient"]).json()["notes"] == []
    client.post("/v1/auth/logout", headers=caregiver_headers)
    owner_headers = login(client)
    shared = client.put("/v1/app/notes/%s/sharing" % note_id, json={"user_ids": [ids["caregiver"]]}, headers=owner_headers)
    assert shared.status_code == 200
    assert client.get(share_url).status_code == 410
    client.post("/v1/auth/logout", headers=owner_headers)
    caregiver_headers = login(client, "caregiver@example.invalid", "caregiver-password")
    notes = client.get("/v1/app/patients/%s/dashboard" % ids["patient"]).json()["notes"]
    assert [item["id"] for item in notes] == [note_id]
    client.post("/v1/auth/logout", headers=caregiver_headers)
    owner_headers = login(client)
    assert client.put("/v1/app/notes/%s/sharing" % note_id, json={"user_ids": []}, headers=owner_headers).status_code == 200
    client.post("/v1/auth/logout", headers=owner_headers)
    login(client, "caregiver@example.invalid", "caregiver-password")
    assert client.get("/v1/app/patients/%s/dashboard" % ids["patient"]).json()["notes"] == []


def test_expired_recipient_grant_blocks_support_commit(env):
    client, app, ids = env
    headers = login(client)
    proposed = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "support_request", "payload": {"request_text": "Please help", "recipient_user_id": ids["caregiver"]}}, headers=headers)
    assert proposed.status_code == 201
    db = app.state.db.SessionLocal()
    grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.user_id == ids["caregiver"], m.AccessGrant.patient_id == ids["patient"]))
    grant.expires_at = utcnow() - timedelta(seconds=1)
    db.commit(); db.close()
    committed = client.post("/v1/app/proposals/%s/confirm" % proposed.json()["id"], json={"confirmed": True}, headers=headers)
    assert committed.status_code == 409


def test_second_caregiver_cannot_reference_or_resolve_private_followup(env):
    client, app, ids = env
    owner_headers = login(client)
    note = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "health_note", "payload": {"wording": "Owner private note"}}, headers=owner_headers).json()
    note_id = client.post("/v1/app/proposals/%s/confirm" % note["id"], json={"confirmed": True}, headers=owner_headers).json()["record_id"]
    followup = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "followup", "payload": {"related_type": "health_note", "related_id": note_id, "check_at": "2026-09-23T09:00:00+08:00", "permission_scope": "private", "resolution_state": "open"}}, headers=owner_headers).json()
    followup_id = client.post("/v1/app/proposals/%s/confirm" % followup["id"], json={"confirmed": True}, headers=owner_headers).json()["record_id"]
    private_resolution = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "followup", "payload": {"followup_id": followup_id, "reported_outcome": "Owner-only draft", "resolution_state": "resolved"}}, headers=owner_headers).json()
    client.post("/v1/auth/logout", headers=owner_headers)
    other_headers = login(client, "caregiver2@example.invalid", "caregiver2-password")
    guessed_note = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "followup", "payload": {"related_type": "health_note", "related_id": note_id, "check_at": "2026-09-24T09:00:00+08:00", "permission_scope": "private", "resolution_state": "open"}}, headers=other_headers)
    guessed_followup = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "followup", "payload": {"followup_id": followup_id, "reported_outcome": "Guessed", "resolution_state": "resolved"}}, headers=other_headers)
    guessed_readback = client.post("/v1/app/proposals/%s/revise" % private_resolution["id"], json={"payload": {"followup_id": followup_id, "reported_outcome": "Guessed", "resolution_state": "resolved"}}, headers=other_headers)
    guessed_confirm = client.post("/v1/app/proposals/%s/confirm" % private_resolution["id"], json={"confirmed": True}, headers=other_headers)
    assert [guessed_note.status_code, guessed_followup.status_code, guessed_readback.status_code, guessed_confirm.status_code] == [403, 403, 403, 403]
