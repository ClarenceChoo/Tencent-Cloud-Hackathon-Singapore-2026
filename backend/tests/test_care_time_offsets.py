"""Confirmed care timestamps retain their instant after database reload."""
from datetime import timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app import models as m
from app.security import aware, utcnow
from conftest import login


@pytest.mark.parametrize("kind,field,model,collection", [
    ("health_note", "occurred_at", m.HealthNote, "notes"),
    ("measurement", "occurred_at", m.Measurement, "measurements"),
    ("followup", "check_at", m.FollowUp, "followups"),
])
@pytest.mark.parametrize("zone", ["Asia/Singapore", "America/New_York"])
def test_confirmed_local_timestamp_preserves_utc_instant(env, kind, field, model, collection, zone):
    owner, app, ids = env
    headers = login(owner)
    instant = (utcnow() + timedelta(days=1) if kind == "followup" else utcnow() - timedelta(hours=1)).replace(microsecond=0)
    stated = instant.astimezone(ZoneInfo(zone)).isoformat()

    def save(proposal_kind, payload):
        proposal = owner.post(f'/v1/app/patients/{ids["patient"]}/proposals', headers=headers,
                              json={"kind": proposal_kind, "payload": payload})
        assert proposal.status_code == 201, proposal.text
        committed = owner.post('/v1/app/proposals/' + proposal.json()["id"] + '/confirm', headers=headers, json={"confirmed": True})
        assert committed.status_code == 200, committed.text
        return proposal.json(), committed.json()["record_id"]

    if kind == "health_note":
        payload = {"wording": "Fictional note with a stated local time", "occurred_at": stated, "timezone": zone}
    elif kind == "measurement":
        payload = {"measurement_type": "blood_pressure", "systolic": 122, "diastolic": 78, "unit": "mmHg",
                   "occurred_at": stated, "timezone": zone, "source_description": "Fictional cuff", "reporting_actor": "patient"}
    else:
        _, note_id = save("health_note", {"wording": "Fictional follow-up source"})
        payload = {"related_type": "health_note", "related_id": note_id, "check_at": stated, "permission_scope": "private"}
    proposal, record_id = save(kind, payload)
    assert proposal["payload"][field] == stated
    with app.state.db.SessionLocal() as db:
        reloaded = db.get(model, record_id)
        assert aware(getattr(reloaded, field)).astimezone(timezone.utc) == instant
    dashboard = owner.get(f'/v1/app/patients/{ids["patient"]}/dashboard').json()
    record = next(row for row in dashboard[collection] if row["id"] == record_id)
    assert record[field] == instant.isoformat().replace("+00:00", "Z")


@pytest.mark.parametrize("occurrence_text", [None, "this morning"])
def test_health_note_does_not_add_precision_to_an_approximate_or_absent_time(env, occurrence_text):
    owner, app, ids = env
    headers = login(owner)
    payload = {"wording": "Fictional note without an exact occurrence time"}
    if occurrence_text:
        payload["occurrence_text"] = occurrence_text
    proposal = owner.post(f'/v1/app/patients/{ids["patient"]}/proposals', headers=headers,
                          json={"kind": "health_note", "payload": payload})
    assert proposal.status_code == 201, proposal.text
    assert proposal.json()["payload"].get("occurred_at") is None
    assert (occurrence_text or "with no exact time stated") in proposal.json()["readback"]
    saved = owner.post('/v1/app/proposals/' + proposal.json()["id"] + '/confirm', headers=headers,
                       json={"confirmed": True})
    assert saved.status_code == 200, saved.text
    with app.state.db.SessionLocal() as db:
        note = db.get(m.HealthNote, saved.json()["record_id"])
        assert note.occurred_at is None and note.occurrence_text == occurrence_text


def test_health_note_rejects_a_hidden_exact_time_alongside_approximate_wording(env):
    owner, _, ids = env
    headers = login(owner)
    payload = {"wording": "Fictional note", "occurrence_text": "this morning",
               "occurred_at": "2026-10-04T00:00:00+08:00", "timezone": "Asia/Singapore"}
    rejected = owner.post(f'/v1/app/patients/{ids["patient"]}/proposals', headers=headers,
                          json={"kind": "health_note", "payload": payload})
    assert rejected.status_code == 422
    dashboard = owner.get(f'/v1/app/patients/{ids["patient"]}/dashboard').json()
    assert dashboard["notes"] == [] and dashboard["proposals"] == []
