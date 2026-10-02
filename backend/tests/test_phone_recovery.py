"""Late phone evidence reconciles history without authorizing replay or doses."""

import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app import models as m
from app.routing import expire_attempts
from app.security import utcnow
from app.worker import scheduler_tick
from conftest import login
from test_reminder_routing import auth, choose, setup


@pytest.mark.parametrize("kind", ["medication", "checkin"])
@pytest.mark.parametrize("stage", ["playback_completed", "interrupted"])
@pytest.mark.parametrize("boundary", ["expiry", "handoff"])
def test_phone_recovery_reconciles_terminal_evidence_without_replay(
    env, monkeypatch, kind, stage, boundary
):
    client, app, ids = env
    phone, token = setup(env, monkeypatch, kind)
    owner = login(client)
    assert choose(client, ids, phone, owner).status_code == 200
    asyncio.run(scheduler_tick(app))
    headers = auth(token)
    pending = client.get("/v1/device/pending-commands", headers=headers).json()
    event = (pending["commands"] + pending["checkins"])[0]
    command = event["payload"]["command_id"]
    asset = event["payload"]["audio_paths"][0]
    model = m.ReminderCommand if kind == "medication" else m.CheckInDelivery
    start = {"ack_id": str(uuid4()), "command_id": command, "stage": "playback_started"}
    assert (
        client.post("/v1/device/acks", headers=headers, json=start).status_code == 200
    )
    if boundary == "expiry":
        with app.state.db.SessionLocal() as db:
            db.get(model, command).expires_at = utcnow() - timedelta(seconds=1)
            db.flush()
            expire_attempts(db, utcnow())
            db.commit()
    else:
        assert (
            client.post(
                "/v1/phone/quiesce",
                headers=headers,
                json={"playback_stopped": True, "local_alerts_cleared": True},
            ).status_code
            == 200
        )
        assert (
            choose(client, ids, ids["device"], owner, generation=3).status_code == 200
        )
    terminal = {"ack_id": str(uuid4()), "command_id": command, "stage": stage}
    for _ in range(2):
        result = client.post("/v1/device/acks", headers=headers, json=terminal)
        assert result.status_code == 200, result.text
    assert client.get(asset, headers=headers).status_code == 410
    assert (
        client.get("/v1/phone/reminders/" + command, headers=headers).status_code == 409
    )
    assert (
        client.post(
            "/v1/device/acks", headers=headers, json={**start, "ack_id": str(uuid4())}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/v1/device/acks",
            headers=headers,
            json={
                **terminal,
                "ack_id": str(uuid4()),
                "stage": "interrupted"
                if stage == "playback_completed"
                else "playback_completed",
            },
        ).status_code
        == 409
    )
    asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        assert db.get(model, command).delivery_state == stage
        assert db.scalar(select(func.count()).select_from(m.ReminderAck)) == 2
        assert db.scalar(select(func.count()).select_from(model)) == 1
        if kind == "medication":
            assert db.scalar(select(m.DoseInstance.report_state)) == "unconfirmed"


def test_expired_phone_evidence_requires_recorded_start_and_own_unrevoked_identity(
    env, monkeypatch
):
    client, app, ids = env
    phone, token = setup(env, monkeypatch)
    owner = login(client)
    assert choose(client, ids, phone, owner).status_code == 200
    asyncio.run(scheduler_tick(app))
    headers = auth(token)
    with app.state.db.SessionLocal() as db:
        item = db.scalar(select(m.ReminderCommand))
        item.delivery_state = "playback_unknown"
        item.expires_at = utcnow() - timedelta(seconds=1)
        command = item.id
        db.commit()
    ack = {"ack_id": str(uuid4()), "command_id": command, "stage": "playback_completed"}
    assert client.post("/v1/device/acks", headers=headers, json=ack).status_code == 409
    assert (
        client.post(
            "/v1/device/acks", headers=auth(ids["credential"]), json=ack
        ).status_code
        == 404
    )
    with app.state.db.SessionLocal() as db:
        db.add(
            m.ReminderAck(
                device_id=phone,
                command_id=command,
                ack_id=str(uuid4()),
                stage="playback_started",
            )
        )
        db.commit()
    assert (
        client.post("/v1/app/devices/" + phone + "/revoke", headers=owner).status_code
        == 200
    )
    assert client.post("/v1/device/acks", headers=headers, json=ack).status_code == 403
    with app.state.db.SessionLocal() as db:
        assert db.get(m.ReminderCommand, command).delivery_state == "playback_unknown"
        assert db.scalar(select(m.DoseInstance.report_state)) == "unconfirmed"
