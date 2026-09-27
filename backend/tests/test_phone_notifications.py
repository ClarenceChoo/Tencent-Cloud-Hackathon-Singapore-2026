import asyncio
import json
from datetime import timedelta
from uuid import uuid4
import httpx
import pytest
from sqlalchemy import func, select
from app import models as m
from app.notification_api import GENERIC_BODY
from app.notifications import collect_hints, push_tick, receipt, send_hint
from app.routing import choose_target
from app.security import aware, sha256, utcnow
from conftest import login


@pytest.fixture
def phone(env):
    client, app, ids = env
    token = uuid4().hex + uuid4().hex
    with app.state.db.SessionLocal() as db:
        device = m.Device(
            device_type="phone",
            platform="ios",
            patient_id=ids["patient"],
            credential_hash=sha256(token),
        )
        db.add(device)
        db.flush()
        choose_target(db, ids["patient"], device.id, 1, True, ids["owner"])
        plan = m.MedicationPlanVersion(
            patient_id=ids["patient"],
            version=1,
            timezone="Asia/Singapore",
            source="Fictional private label",
            checked_by_user_id=ids["owner"],
            checked_by_name="Owner",
            active=True,
            medicines=[],
            schedule=[],
        )
        db.add(plan)
        db.flush()
        for minutes in (2, 12, 1500):
            db.add(
                m.DoseInstance(
                    patient_id=ids["patient"],
                    plan_id=plan.id,
                    plan_version=1,
                    medicine_id=str(minutes),
                    medicine_name="PRIVATE MEDICINE",
                    scheduled_at=utcnow() + timedelta(minutes=minutes),
                )
            )
        db.commit()
        ids = {**ids, "phone": device.id, "plan": plan.id}
    headers = {"Authorization": "Bearer " + token}
    return client, app, ids, headers


def presence(client, headers, permission="granted"):
    return client.put(
        "/v1/phone/presence",
        headers=headers,
        json={
            "lifecycle": "foreground",
            "microphone_permission": "granted",
            "notification_permission": permission,
        },
    )


def register(client, headers, token="ExpoPushToken[fixture_test_token_1234]"):
    assert presence(client, headers).status_code == 200
    result = client.put(
        "/v1/phone/notification-registration", headers=headers, json={"token": token}
    )
    assert result.status_code == 200, result.text
    return result


def change_plan(app, ids):
    with app.state.db.SessionLocal() as db:
        plan = db.get(m.MedicationPlanVersion, ids["plan"])
        plan.version += 1
        db.commit()


def test_bounded_generic_schedule_identity_and_paused_route(phone):
    client, app, ids, headers = phone
    result = client.get("/v1/phone/reminder-schedule", headers=headers)
    assert result.status_code == 200, result.text
    schedule = result.json()
    assert schedule["body"] == GENERIC_BODY and len(schedule["alerts"]) == 2
    assert (
        "PRIVATE MEDICINE" not in result.text
        and "Fictional private label" not in result.text
    )
    assert (
        aware(
            __import__("datetime").datetime.fromisoformat(
                schedule["valid_until"].replace("Z", "+00:00")
            )
        )
        - __import__("datetime").datetime.fromisoformat(
            schedule["server_time"].replace("Z", "+00:00")
        )
    ).total_seconds() == 86400
    again = client.get("/v1/phone/reminder-schedule", headers=headers).json()
    assert (
        again["revision"] == schedule["revision"]
        and again["alerts"] == schedule["alerts"]
    )
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(m.ReminderOccurrence)) == 2
    assert (
        client.post(
            "/v1/phone/quiesce",
            headers=headers,
            json={"playback_stopped": True, "local_alerts_cleared": True},
        ).status_code
        == 200
    )
    assert (
        client.get("/v1/phone/reminder-schedule", headers=headers).json()["alerts"]
        == []
    )


def test_notification_evidence_cannot_confirm_or_ack_playback(phone):
    client, app, ids, headers = phone
    identity = client.get("/v1/phone/reminder-schedule", headers=headers).json()[
        "alerts"
    ][0]["identity"]
    event = {"event_id": str(uuid4()), "identity": identity, "stage": "scheduled"}
    assert (
        client.post(
            "/v1/phone/notification-events", headers=headers, json=event
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/v1/phone/notification-events", headers=headers, json=event
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/v1/phone/notification-events",
            headers=headers,
            json={**event, "stage": "opened"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/v1/phone/notification-events",
            headers=headers,
            json={**event, "stage": "playback_completed"},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/v1/phone/notification-events",
            headers=headers,
            json={**event, "identity": identity.replace(ids["phone"], "other")},
        ).status_code
        == 404
    )
    client.post(
        "/v1/phone/quiesce",
        headers=headers,
        json={"playback_stopped": True, "local_alerts_cleared": True},
    )
    assert (
        client.post(
            "/v1/phone/notification-events",
            headers=headers,
            json={**event, "event_id": str(uuid4())},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/v1/phone/notification-events",
            headers=headers,
            json={**event, "event_id": str(uuid4()), "stage": "opened"},
        ).status_code
        == 200
    )
    with app.state.db.SessionLocal() as db:
        assert set(db.scalars(select(m.DoseInstance.report_state))) == {"unconfirmed"}
        assert db.scalar(select(func.count()).select_from(m.ReminderAck)) == 0


def test_permission_revocation_and_device_revocation_invalidate_push(phone):
    client, app, ids, headers = phone
    register(client, headers)
    assert presence(client, headers, "denied").status_code == 200
    with app.state.db.SessionLocal() as db:
        assert db.get(m.PhoneState, ids["phone"]).push_token is None
    register(client, headers)
    change_plan(app, ids)
    collect_hints(app, utcnow())
    owner = login(client)
    assert (
        client.post(
            "/v1/app/devices/" + ids["phone"] + "/revoke", headers=owner
        ).status_code
        == 200
    )
    assert client.get("/v1/phone/reminder-schedule", headers=headers).status_code == 403
    with app.state.db.SessionLocal() as db:
        assert db.get(m.PhoneState, ids["phone"]).push_token is None
        assert db.scalar(select(m.PushHint.status)) == "cancelled"


def test_push_payload_is_generic_deduplicated_and_receipt_is_not_delivery(phone):
    client, app, ids, headers = phone
    register(client, headers)
    app.state.settings.expo_push_enabled = True
    change_plan(app, ids)
    sent = []

    def provider(request):
        body = json.loads(request.content)
        sent.append(body)
        if request.url.path.endswith("/send"):
            return httpx.Response(
                200, json={"data": {"status": "ok", "id": "ticket-fixture"}}
            )
        return httpx.Response(200, json={"data": {"ticket-fixture": {"status": "ok"}}})

    app.state.push_transport = httpx.MockTransport(provider)
    asyncio.run(push_tick(app))
    asyncio.run(push_tick(app))
    assert len(sent) == 1 and sent[0]["body"] == GENERIC_BODY
    assert set(sent[0]["data"]) == {"parse", "identity"}
    assert "PRIVATE" not in json.dumps(sent) and "Fictional" not in json.dumps(sent)
    with app.state.db.SessionLocal() as db:
        hint = db.scalar(select(m.PushHint))
        assert hint.status == "ticketed"
        identity = hint.id
    asyncio.run(receipt(app, identity, utcnow() + timedelta(minutes=16)))
    with app.state.db.SessionLocal() as db:
        assert db.get(m.PushHint, identity).status == "provider_accepted"
        assert db.scalar(select(func.count()).select_from(m.ReminderAck)) == 0


@pytest.mark.parametrize("phase", ["ticket", "receipt"])
def test_invalid_push_token_is_disabled_from_ticket_or_receipt(phone, phase):
    client, app, ids, headers = phone
    register(client, headers)
    app.state.settings.expo_push_enabled = True
    change_plan(app, ids)

    def provider(request):
        invalid = {"status": "error", "details": {"error": "DeviceNotRegistered"}}
        if request.url.path.endswith("/send"):
            return httpx.Response(
                200,
                json={
                    "data": invalid
                    if phase == "ticket"
                    else {"status": "ok", "id": "t"}
                },
            )
        return httpx.Response(200, json={"data": {"t": invalid}})

    app.state.push_transport = httpx.MockTransport(provider)
    asyncio.run(push_tick(app))
    if phase == "receipt":
        with app.state.db.SessionLocal() as db:
            identity = db.scalar(select(m.PushHint.id))
        asyncio.run(receipt(app, identity, utcnow() + timedelta(minutes=16)))
    with app.state.db.SessionLocal() as db:
        assert db.get(m.PhoneState, ids["phone"]).push_token is None
        assert db.scalar(select(m.PushHint.status)) == "failed"


def test_push_retries_are_bounded_and_use_same_collapse_identity(phone):
    client, app, ids, headers = phone
    register(client, headers)
    change_plan(app, ids)
    collect_hints(app, utcnow())
    sent = []
    app.state.push_transport = httpx.MockTransport(
        lambda req: sent.append(json.loads(req.content)) or httpx.Response(503)
    )
    with app.state.db.SessionLocal() as db:
        identity = db.scalar(select(m.PushHint.id))
    for _ in range(5):
        with app.state.db.SessionLocal() as db:
            row = db.get(m.PushHint, identity)
            row.next_attempt_at = utcnow()
            db.commit()
        asyncio.run(send_hint(app, identity, utcnow()))
    with app.state.db.SessionLocal() as db:
        row = db.get(m.PushHint, identity)
        assert row.attempts == 5 and row.status == "unknown"
    assert len(sent) == 5 and len({s["collapseId"] for s in sent}) == 1


def test_paused_route_and_old_registration_never_send_pending_hints(phone):
    client, app, ids, headers = phone
    register(client, headers)
    change_plan(app, ids)
    collect_hints(app, utcnow())
    with app.state.db.SessionLocal() as db:
        identity = db.scalar(select(m.PushHint.id))
    client.post(
        "/v1/phone/quiesce",
        headers=headers,
        json={"playback_stopped": True, "local_alerts_cleared": True},
    )
    app.state.push_transport = httpx.MockTransport(
        lambda request: pytest.fail("Old route must not reach provider")
    )
    asyncio.run(send_hint(app, identity, utcnow()))
    with app.state.db.SessionLocal() as db:
        assert db.get(m.PushHint, identity).status == "cancelled"


def test_phone_presence_is_separate_from_background_alert_capability(phone):
    client, app, ids, headers = phone
    schedule = client.get("/v1/phone/reminder-schedule", headers=headers).json()
    assert (
        client.put(
            "/v1/phone/presence",
            headers=headers,
            json={
                "lifecycle": "background",
                "microphone_permission": "granted",
                "notification_permission": "granted",
                "schedule_revision": schedule["revision"],
                "scheduled_until": schedule["covered_until"],
            },
        ).status_code
        == 200
    )
    owner = login(client)
    dashboard = client.get(
        "/v1/app/patients/" + ids["patient"] + "/dashboard", headers=owner
    ).json()
    device = next(d for d in dashboard["devices"] if d["id"] == ids["phone"])
    assert (
        device["status"] != "connected"
        and device["phone_presence"]["background_alerts_enabled"]
    )
    presence(client, headers)
    dashboard = client.get(
        "/v1/app/patients/" + ids["patient"] + "/dashboard", headers=owner
    ).json()
    device = next(d for d in dashboard["devices"] if d["id"] == ids["phone"])
    assert (
        device["status"] == "connected" and device["phone_presence"]["foreground_ready"]
    )
    assert "fixture_test_token" not in json.dumps(dashboard)
