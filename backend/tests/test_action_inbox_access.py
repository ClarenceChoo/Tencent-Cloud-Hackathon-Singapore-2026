"""The caregiver inbox derives its rows solely from the authorized dashboard."""
from datetime import timedelta

from app import models as m
from app.security import utcnow
from conftest import ORIGIN, login


def propose_and_confirm(client, patient_id, headers, kind, payload):
    proposed = client.post(
        f"/v1/app/patients/{patient_id}/proposals",
        json={"kind": kind, "payload": payload}, headers=headers,
    )
    assert proposed.status_code == 201, proposed.text
    committed = client.post(
        f"/v1/app/proposals/{proposed.json()['id']}/confirm",
        json={"confirmed": True}, headers=headers,
    )
    assert committed.status_code == 200, committed.text
    return committed.json()["record_id"]


def test_dashboard_inbox_sources_and_counts_follow_record_visibility(env):
    client, _, ids = env
    owner = login(client)
    private = client.post(
        f"/v1/app/patients/{ids['patient']}/proposals",
        json={"kind": "health_note", "payload": {"wording": "Private fictional note"}}, headers=owner,
    )
    assert private.status_code == 201
    first = propose_and_confirm(client, ids["patient"], owner, "support_request", {
        "request_text": "Fictional ride for first caregiver", "recipient_user_id": ids["caregiver"],
    })
    second = propose_and_confirm(client, ids["patient"], owner, "support_request", {
        "request_text": "Fictional ride for second caregiver", "recipient_user_id": ids["caregiver_two"],
    })
    owner_data = client.get(f"/v1/app/patients/{ids['patient']}/dashboard").json()
    assert {row["id"] for row in owner_data["support_requests"]} == {first, second}
    assert private.json()["id"] in {row["id"] for row in owner_data["proposals"]}
    client.post("/v1/auth/logout", headers=owner)

    for email, password, visible, hidden in [
        ("caregiver@example.invalid", "caregiver-password", first, second),
        ("caregiver2@example.invalid", "caregiver2-password", second, first),
    ]:
        headers = login(client, email, password)
        data = client.get(f"/v1/app/patients/{ids['patient']}/dashboard").json()
        assert [row["id"] for row in data["support_requests"]] == [visible]
        assert data["proposals"] == []
        assert data["notes"] == []
        assert data["summaries"] == []
        assert hidden not in str(data)
        assert private.json()["id"] not in str(data)
        assert client.post(f"/v1/app/support-requests/{hidden}/acknowledge", headers=headers).status_code == 403
        assert client.post(f"/v1/app/proposals/{private.json()['id']}/confirm", json={"confirmed": True}, headers=headers).status_code == 403
        client.post("/v1/auth/logout", headers=headers)


def test_expired_grant_cannot_feed_any_inbox_rows(env):
    client, app, ids = env
    owner = login(client)
    request_id = propose_and_confirm(client, ids["patient"], owner, "support_request", {
        "request_text": "Fictional visit", "recipient_user_id": ids["caregiver"],
    })
    client.post("/v1/auth/logout", headers=owner)
    caregiver = login(client, "caregiver@example.invalid", "caregiver-password")
    assert request_id in str(client.get(f"/v1/app/patients/{ids['patient']}/dashboard").json())
    db = app.state.db.SessionLocal()
    grant = db.query(m.AccessGrant).filter_by(user_id=ids["caregiver"], patient_id=ids["patient"]).one()
    grant.expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    db.close()
    assert client.get(f"/v1/app/patients/{ids['patient']}/dashboard").status_code == 403
    assert client.post(f"/v1/app/support-requests/{request_id}/acknowledge", headers=caregiver).status_code == 403
    assert ids["patient"] not in {row["id"] for row in client.get("/v1/auth/session").json()["patients"]}
