"""Owner recovery when uninstall/reset removed a selected phone's credential."""
import asyncio
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from app import models as m
from app.security import utcnow
from app.worker import scheduler_tick
from conftest import login
from test_reminder_routing import auth, choose, setup


def release(client, device_id, headers, generation=2, confirmed=True):
    return client.post('/v1/app/devices/' + device_id + '/release-removed-phone',
                       headers=headers, json={'expected_generation': generation,
                                              'app_removed_or_reset': confirmed})


@pytest.mark.parametrize('kind', ['medication', 'checkin'])
@pytest.mark.parametrize('state', ['queued', 'downloaded', 'playback_started'])
def test_removed_phone_release_preserves_history_and_requires_new_selection(env, monkeypatch, kind, state):
    client, app, ids = env
    phone, token = setup(env, monkeypatch, kind)
    headers = login(client)
    assert choose(client, ids, phone, headers).status_code == 200
    asyncio.run(scheduler_tick(app))
    model = m.ReminderCommand if kind == 'medication' else m.CheckInDelivery
    with app.state.db.SessionLocal() as db:
        first = db.scalar(select(model)); first_id, occurrence = first.id, first.occurrence_id
        if state != 'queued': first.audio_accessed_at = utcnow()
        if state == 'playback_started': first.delivery_state = state
        db.commit()
    assert client.post('/v1/app/devices/' + phone + '/revoke', headers=headers).status_code == 200
    # Reinstall cannot call /phone/quiesce: its old credential no longer exists.
    assert choose(client, ids, ids['device'], headers, generation=2).status_code == 409
    result = release(client, phone, headers)
    assert result.status_code == 200, result.text
    assert result.json()['device_id'] is None and result.json()['generation'] == 3
    assert client.get('/v1/phone/home', headers=auth(token)).status_code == 403
    assert client.get('/v1/device/pending-commands', headers=auth(token)).status_code == 403
    asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(model)) == 1
        first = db.get(model, first_id)
        assert first.delivery_state == ('playback_unknown' if state == 'playback_started' else 'cancelled')
        assert first.cancel_reason == 'route_changed'
        audit = db.scalar(select(m.AuditEvent).where(m.AuditEvent.action == 'phone.removed_installation_released'))
        assert audit.actor_type == 'user' and audit.actor_id == ids['owner']
        assert audit.details['app_removed_or_reset'] is True
        assert audit.details['local_cleanup_verified_by_server'] is False
        assert audit.details['generation'] == 3
    assert choose(client, ids, ids['device'], headers, generation=3).status_code == 200
    # A stale retry cannot clear the replacement route.
    assert release(client, phone, headers).status_code == 409
    asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        attempts = db.scalars(select(model)).all()
        assert len(attempts) == (2 if state == 'queued' else 1)
        assert {item.occurrence_id for item in attempts} == {occurrence}
        assert db.get(m.Device, phone).revoked_at
        assert db.get(m.CompanionRoute, ids['patient']).active_device_id == ids['device']
        if kind == 'medication': assert db.scalar(select(m.DoseInstance.report_state)) == 'unconfirmed'


def test_removed_phone_requires_revocation_attestation_scope_and_generation(env, monkeypatch):
    client, app, ids = env
    phone, _ = setup(env, monkeypatch)
    owner = login(client)
    assert choose(client, ids, phone, owner).status_code == 200
    assert release(client, phone, owner).status_code == 409
    assert client.post('/v1/app/devices/' + phone + '/revoke', headers=owner).status_code == 200
    assert release(client, phone, owner, confirmed=False).status_code == 422
    assert release(client, phone, owner, generation=1).status_code == 409
    assert release(client, phone, {}).status_code == 403
    assert release(client, phone, {**owner, 'Origin': 'https://other.invalid'}).status_code == 403
    caregiver = login(client, 'caregiver@example.invalid', 'caregiver-password')
    assert release(client, phone, caregiver).status_code == 403
    outsider = login(client, 'outsider@example.invalid', 'outsider-password')
    assert release(client, phone, outsider).status_code == 403
    owner = login(client)
    assert release(client, ids['device'], owner).status_code == 409
    assert release(client, 'missing-device', owner).status_code == 404
    with app.state.db.SessionLocal() as db:
        current = db.get(m.CompanionRoute, ids['patient'])
        assert current.active_device_id == phone and current.generation == 2
    assert release(client, phone, owner).status_code == 200


def test_removed_phone_release_serializes_with_phone_quiescence(env, monkeypatch):
    from app.routing import pause_phone, release_removed_phone
    client, app, ids = env
    phone, _ = setup(env, monkeypatch); owner = login(client)
    assert choose(client, ids, phone, owner).status_code == 200
    assert client.post('/v1/app/devices/' + phone + '/revoke', headers=owner).status_code == 200
    def change(mode):
        with app.state.db.SessionLocal() as db:
            try:
                if mode == 'owner': release_removed_phone(db, ids['patient'], phone, 2, ids['owner'])
                else: pause_phone(db, db.get(m.Device, phone))
                db.commit()
                return 200
            except HTTPException as error: return error.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert set(pool.map(change, ['owner', 'phone'])) <= {200, 409}
    with app.state.db.SessionLocal() as db:
        current = db.get(m.CompanionRoute, ids['patient'])
        assert current.active_device_id is None and current.generation == 3
