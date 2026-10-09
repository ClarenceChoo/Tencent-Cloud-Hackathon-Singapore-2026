"""Reviewed purpose summaries keep the existing access and invalidation gates."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from sqlalchemy import select

from app import models as m
from conftest import login


def _create_summary(client, patient_id, headers, **extra):
    today = datetime.now(ZoneInfo("Asia/Singapore")).date()
    response = client.post(
        f"/v1/app/patients/{patient_id}/summaries",
        json={"start_date": str(today - timedelta(days=1)), "end_date": str(today + timedelta(days=1)), **extra},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _review(client, summary, headers, questions=None):
    response = client.put(
        f"/v1/app/summaries/{summary['id']}",
        json={"sections": summary["sections"], "omitted_source_ids": [], "reviewed": True,
              **({"questions": questions} if questions is not None else {})},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_print_requires_fresh_reviewed_authorized_summary(env):
    client, _app, ids = env
    headers = login(client)
    summary = _create_summary(client, ids["patient"], headers, purpose="weekly_review")
    path = f"/v1/app/summaries/{summary['id']}/print"
    unreviewed = client.get(path)
    assert unreviewed.status_code == 409
    assert unreviewed.headers["Cache-Control"] == "no-store"
    reviewed = _review(client, summary, headers)
    response = client.get(path)
    assert response.status_code == 200, response.text
    assert response.json()["id"] == reviewed["id"]
    assert response.json()["purpose"] == "weekly_review"
    assert response.headers["Cache-Control"] == "no-store"
    client.post("/v1/auth/logout", headers=headers)
    denied = client.get(path)
    assert denied.status_code in (401, 403)
    assert denied.headers["Cache-Control"] == "no-store"


def test_client_cannot_forge_question_author_or_source(env):
    client, _app, ids = env
    headers = login(client)
    summary = _create_summary(client, ids["patient"], headers, questions=["What should we ask?"])
    forged = [section for section in summary["sections"] if section.get("kind") != "authored_questions"]
    forged.append({
        "kind": "authored_questions", "title": "Questions written by a caregiver",
        "items": [{"text": "A question is a confirmed event", "source_id": "invented_source",
                   "author_display_name": "Another person", "author_id": ids["caregiver"],
                   "authored_at": "2020-01-01T00:00:00Z"}],
    })
    response = client.put(
        f"/v1/app/summaries/{summary['id']}",
        json={"sections": forged, "questions": ["What should we ask?"],
              "omitted_source_ids": [], "reviewed": True}, headers=headers,
    )
    assert response.status_code == 422, response.text
    unsourced = client.put(
        f"/v1/app/summaries/{summary['id']}",
        json={"sections": [{"title": "Reported care", "items": [{"text": "An unrecorded event happened"}]}],
              "questions": [], "omitted_source_ids": [], "reviewed": True}, headers=headers,
    )
    assert unsourced.status_code == 422, unsourced.text


def test_question_change_revokes_existing_link_and_public_output_hides_actor_identifiers(env):
    client, _app, ids = env
    headers = login(client)
    summary = _create_summary(client, ids["patient"], headers, questions=["Should we discuss an unrecorded fall?"])
    reviewed = _review(client, summary, headers, questions=["Should we discuss an unrecorded fall?"])
    unchanged = _review(client, reviewed, headers, questions=["Should we discuss an unrecorded fall?"])
    assert unchanged["questions"][0]["authored_at"] == reviewed["questions"][0]["authored_at"]
    share = client.post(f"/v1/app/summaries/{summary['id']}/share",
                        json={"expires_in_seconds": 3600}, headers=headers)
    assert share.status_code == 201, share.text
    public = client.get(share.json()["url"])
    assert public.status_code == 200, public.text
    payload = public.json()["summary"]
    question_section = next(section for section in payload["sections"] if section.get("kind") == "authored_questions")
    assert question_section["items"][0]["text"] == "Should we discuss an unrecorded fall?"
    assert "source_id" not in question_section["items"][0]
    assert ids["owner"] not in public.text
    assert "owner@example.invalid" not in public.text
    assert payload["questions"][0]["author_display_name"] == "Owner"
    assert "author_id" not in public.text

    changed = _review(client, unchanged, headers, questions=["What should we ask at the visit?"])
    assert changed["questions"][0]["text"] == "What should we ask at the visit?"
    assert changed["questions"][0]["authored_at"] != unchanged["questions"][0]["authored_at"]
    assert client.get(share.json()["url"]).status_code == 410


def test_public_question_attribution_never_falls_back_to_an_email(env):
    client, app, ids = env
    with app.state.db.SessionLocal() as db:
        owner = db.get(m.User, ids["owner"])
        owner.name = "private@example.invalid"
        db.commit()
    headers = login(client)
    summary = _review(client, _create_summary(client, ids["patient"], headers,
                                              questions=["Fictional question?"]), headers)
    shared = client.post(f"/v1/app/summaries/{summary['id']}/share",
                         json={"expires_in_seconds": 3600}, headers=headers).json()
    public = client.get(shared["url"])
    assert public.status_code == 200, public.text
    assert "private@example.invalid" not in public.text
    authored = next(section for section in public.json()["summary"]["sections"] if section.get("kind") == "authored_questions")
    assert authored["items"][0]["author_display_name"] == "Author"


def test_source_correction_invalidates_print_preparation_and_share(env):
    client, _app, ids = env
    headers = login(client)
    proposed = client.post(
        f"/v1/app/patients/{ids['patient']}/proposals",
        json={"kind": "health_note", "payload": {"wording": "Fictional original report"}}, headers=headers,
    )
    assert proposed.status_code == 201, proposed.text
    note = client.post(f"/v1/app/proposals/{proposed.json()['id']}/confirm",
                       json={"confirmed": True}, headers=headers).json()["record_id"]
    summary = _review(client, _create_summary(client, ids["patient"], headers), headers)
    share = client.post(f"/v1/app/summaries/{summary['id']}/share",
                        json={"expires_in_seconds": 3600}, headers=headers).json()
    assert client.get(f"/v1/app/summaries/{summary['id']}/print").status_code == 200
    deleted = client.delete(f"/v1/app/notes/{note}", headers=headers)
    assert deleted.status_code in (200, 204), deleted.text
    assert client.get(f"/v1/app/summaries/{summary['id']}/print").status_code in (409, 410)
    assert client.get(share["url"]).status_code == 410


def test_summary_manager_does_not_aggregate_an_unshared_note(env):
    client, app, ids = env
    headers = login(client)
    proposed = client.post(
        f"/v1/app/patients/{ids['patient']}/proposals",
        json={"kind": "health_note", "payload": {"wording": "Fictional private report"}}, headers=headers,
    )
    note_id = client.post(f"/v1/app/proposals/{proposed.json()['id']}/confirm",
                          json={"confirmed": True}, headers=headers).json()["record_id"]
    owner_summary = _create_summary(client, ids["patient"], headers)
    with app.state.db.SessionLocal() as db:
        grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == ids["patient"],
                                                       m.AccessGrant.user_id == ids["caregiver"]))
        grant.scopes = ["manage:sharing", "read:dashboard"]
        db.commit()
    caregiver_headers = login(client, email="caregiver@example.invalid", password="caregiver-password")
    listed = client.get(f"/v1/app/patients/{ids['patient']}/dashboard").json()["summaries"]
    assert owner_summary["id"] not in {row["id"] for row in listed}
    denied = client.get(f"/v1/app/summaries/{owner_summary['id']}/print")
    assert denied.status_code == 403
    assert denied.headers["Cache-Control"] == "no-store"
    summary = _create_summary(client, ids["patient"], caregiver_headers)
    assert note_id not in {ref["id"] for ref in summary["sources"]}
    assert "Fictional private report" not in str(summary["sections"])

    owner_headers = login(client)
    allowed = client.put(f"/v1/app/notes/{note_id}/sharing", json={"user_ids": [ids["caregiver"]]}, headers=owner_headers)
    assert allowed.status_code == 200, allowed.text
    caregiver_headers = login(client, email="caregiver@example.invalid", password="caregiver-password")
    permitted = _review(client, _create_summary(client, ids["patient"], caregiver_headers), caregiver_headers)
    assert note_id in {ref["id"] for ref in permitted["sources"]}
    share = client.post(f"/v1/app/summaries/{permitted['id']}/share",
                        json={"expires_in_seconds": 3600}, headers=caregiver_headers).json()

    with app.state.db.SessionLocal() as db:
        grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == ids["patient"],
                                                       m.AccessGrant.user_id == ids["caregiver"]))
        grant.scopes = ["manage:sharing"]
        db.commit()
    narrowed = client.get(f"/v1/app/patients/{ids['patient']}/dashboard").json()["summaries"]
    redacted_on_scope_change = next(row for row in narrowed if row["id"] == permitted["id"])
    assert redacted_on_scope_change["source_access_current"] is False
    assert redacted_on_scope_change["sections"] == redacted_on_scope_change["sources"] == []
    with app.state.db.SessionLocal() as db:
        persisted = db.get(m.VisitSummary, permitted["id"])
        assert persisted.status == "reviewed" and persisted.invalidated_at is None

    owner_headers = login(client)
    revoked = client.put(f"/v1/app/notes/{note_id}/sharing", json={"user_ids": []}, headers=owner_headers)
    assert revoked.status_code == 200, revoked.text
    caregiver_headers = login(client, email="caregiver@example.invalid", password="caregiver-password")
    rows = client.get(f"/v1/app/patients/{ids['patient']}/dashboard").json()["summaries"]
    redacted = next(row for row in rows if row["id"] == permitted["id"])
    assert redacted["source_access_current"] is False
    assert redacted["sections"] == redacted["sources"] == redacted["questions"] == []
    assert client.get(f"/v1/app/summaries/{permitted['id']}/print").status_code == 409
    assert client.get(share["url"]).status_code == 410
