import csv
import json
import re
from datetime import timedelta

import pytest
from sqlalchemy import select, func
from starlette.websockets import WebSocketDisconnect

from app.config import service_base_url
from app.models import Device, AccessGrant
from app.provisioning import prepare_device, renew_claim
from app.security import sha256, utcnow
from conftest import login


def dashboard(client, ids):
    return client.get('/v1/app/patients/%s/dashboard' % ids['patient']).json()


def test_two_simultaneous_claims_cannot_both_succeed(env):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    client, app, ids = env
    csrf = login(client)
    start = Barrier(2)
    def claim():
        start.wait(timeout=5)
        return client.post('/v1/app/devices/claim', json={'code':ids['claim_code'], 'patient_id':ids['patient']}, headers=csrf).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _:claim(), range(2)))
    assert sorted(results) in [[200,400],[200,409]]
    with app.state.db.SessionLocal() as db:
        device = db.get(Device, ids['unclaimed'])
        assert device.patient_id == ids['patient'] and device.claim_code_hash is None


def test_connection_needs_current_socket_heartbeat_and_revocation_closes_it(env):
    client, app, ids = env
    csrf = login(client)
    auth = {'Authorization': 'Bearer ' + ids['credential']}
    assert dashboard(client, ids)['devices'][0]['status'] == 'awaiting_connection'
    # A previous HTTP request's last_seen must never count as a live heartbeat.
    with app.state.db.SessionLocal() as db:
        device = db.get(Device, ids['device']); device.last_seen = utcnow(); db.commit()
    assert dashboard(client, ids)['devices'][0]['status'] == 'stale'
    with client.websocket_connect('/v1/device/events', headers=auth) as ws:
        assert dashboard(client, ids)['devices'][0]['status'] == 'stale'
        ws.send_json({'type': 'heartbeat', 'battery_mv': 3900, 'rssi': -50, 'firmware_version': 'test-fixture'})
        ack = ws.receive_json()
        assert ack['type'] == 'heartbeat.ack' and ack['device_id'] == ids['device']
        device = dashboard(client, ids)['devices'][0]
        assert device['status'] == 'connected' and device['battery_mv'] == 3900
        # Even a still-open socket becomes stale if heartbeats stop.
        socket = next(iter(app.state.sockets.connections[ids['device']]))
        app.state.sockets.heartbeats[socket] = utcnow() - timedelta(seconds=16)
        assert dashboard(client, ids)['devices'][0]['status'] == 'stale'
        ws.send_json({'type': 'heartbeat'}); ws.receive_json()
        assert dashboard(client, ids)['devices'][0]['status'] == 'connected'
    assert dashboard(client, ids)['devices'][0]['status'] == 'stale'
    with client.websocket_connect('/v1/device/events', headers=auth) as ws:
        ws.send_json({'type': 'heartbeat'}); ws.receive_json()
        assert client.post('/v1/app/devices/%s/revoke' % ids['device'], headers=csrf).status_code == 200
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 4403
    assert dashboard(client, ids)['devices'][0]['status'] == 'revoked'
    assert client.get('/v1/device/info', headers=auth).status_code == 403


def test_device_info_is_authenticated_and_does_not_claim_live_voice_test(env, monkeypatch):
    client, app, ids = env
    monkeypatch.setenv('CARELOOP_PROVIDER', 'unconfigured')
    assert client.get('/v1/device/info').status_code == 401
    assert client.get('/v1/device/info', headers={'Authorization': 'Bearer unclaimed-credential'}).status_code == 403
    auth = {'Authorization': 'Bearer ' + ids['credential']}
    result = client.get('/v1/device/info', headers=auth).json()
    assert result['device_id'] == ids['device']
    assert result['voice_service'] == 'unconfigured'
    assert result['live_voice_verified'] is False
    assert result['protocol']['sample_rate_hz'] == 16000
    assert ids['credential'] not in json.dumps(result)
    assert ids['patient'] not in json.dumps(result)
    monkeypatch.setenv('CARELOOP_PROVIDER', 'fixture'); monkeypatch.setenv('CARELOOP_TESTING', 'true')
    assert client.get('/v1/device/info', headers=auth).json()['voice_service'] == 'simulated'
    monkeypatch.setenv('CARELOOP_TESTING', 'false')
    assert client.get('/v1/device/info', headers=auth).json()['voice_service'] == 'invalid_configuration'
    monkeypatch.setenv('CARELOOP_PROVIDER', 'tencent')
    for key, value in {'TENCENT_SECRET_ID':'fixture-id', 'TENCENT_SECRET_KEY':'fixture-secret', 'CARELOOP_LLM_API_KEY':'fixture-key', 'CARELOOP_LLM_BASE_URL':'https://llm.example/v1', 'CARELOOP_LLM_MODEL':'test', 'CARELOOP_TTS_VOICE_TYPE':'1'}.items():
        monkeypatch.setenv(key, value)
    result = client.get('/v1/device/info', headers=auth).json()
    assert result['voice_service'] == 'configured' and result['live_voice_verified'] is False


def test_pairing_requires_owner_and_diagnostics_respect_scope(env):
    client, app, ids = env
    csrf = login(client, 'caregiver@example.invalid', 'caregiver-password')
    assert client.post('/v1/app/devices/claim', json={'code':ids['claim_code'], 'patient_id':ids['patient']}, headers=csrf).status_code == 403
    with app.state.db.SessionLocal() as db:
        grant = db.scalar(select(AccessGrant).where(AccessGrant.user_id == ids['caregiver']))
        grant.scopes = ['read:notes']; db.commit()
    data = dashboard(client, ids)
    assert data['devices'] == [] and 'device_setup' not in data


def test_private_provisioning_bundle_claim_and_code_renewal(env, tmp_path):
    client, app, ids = env
    target = tmp_path / 'private-device'
    with app.state.db.SessionLocal() as db:
        device_id = prepare_device(db, str(target), 'https://parse.example/')
        device = db.get(Device, device_id)
        original_hash = device.claim_code_hash
        rows = list(csv.DictReader((target / 'device-nvs.csv').open()))
        values = {r['key']:r['value'] for r in rows}
        token = values['token']
        assert device.credential_hash == sha256(token)
        assert values['backend'] == 'https://parse.example'
        assert re.fullmatch('[A-F0-9]{16}', values['setup_pw'])
        assert 'ssid' not in values and 'pass' not in values
        assert token not in (target / 'owner-setup.txt').read_text()
        assert token not in (target / 'device.json').read_text()
        assert target.stat().st_mode & 0o777 == 0o700
        assert all(p.stat().st_mode & 0o777 == 0o600 for p in target.iterdir())
        old_code = re.search(r'One-use pairing code: (\S+)', (target / 'owner-setup.txt').read_text())[1]
        new_code, expiry = renew_claim(db, device_id)
        db.refresh(device)
        assert device.credential_hash == sha256(token)
        assert device.claim_code_hash != original_hash
        assert device.claim_code_hash == sha256(new_code)
        with pytest.raises(FileExistsError):
            prepare_device(db, str(target), 'https://parse.example')
    auth = {'Authorization':'Bearer ' + token}
    assert client.get('/v1/device/info', headers=auth).status_code == 403
    csrf = login(client)
    assert client.post('/v1/app/devices/claim', json={'code':old_code, 'patient_id':ids['patient']}, headers=csrf).status_code == 400
    assert client.post('/v1/app/devices/claim', json={'code':new_code.lower(), 'patient_id':ids['patient']}, headers=csrf).status_code == 200
    assert client.get('/v1/device/info', headers=auth).json()['device_id'] == device_id
    assert client.post('/v1/app/devices/claim', json={'code':new_code, 'patient_id':ids['patient']}, headers=csrf).status_code == 400
    with app.state.db.SessionLocal() as db:
        with pytest.raises(ValueError):
            renew_claim(db, device_id)


def test_failed_bundle_rolls_back_without_leaving_credentials(env, tmp_path, monkeypatch):
    _, app, _ = env
    from app import provisioning
    real_write = provisioning.private_file
    def fail_manifest(path, content):
        if path.name == 'device.json':
            raise OSError('Simulated disk failure')
        real_write(path, content)
    monkeypatch.setattr(provisioning, 'private_file', fail_manifest)
    target = tmp_path / 'failed-bundle'
    with app.state.db.SessionLocal() as db:
        before = db.scalar(select(func.count(Device.id)))
        with pytest.raises(OSError):
            prepare_device(db, str(target), 'https://parse.example')
        assert db.scalar(select(func.count(Device.id))) == before
    assert not target.exists()


@pytest.mark.parametrize('value', ['http://parse.example', 'https://user:secret@parse.example', 'https://parse.example/api', 'https://parse.example?token=x', 'https://parse.example#x', 'https://parse.example:0', 'https://parse.example:bad', 'https://parse.example\\evil', 'https://' + 'x' * 200, 'https://parse.\nexample'])
def test_invalid_service_addresses(value):
    with pytest.raises(ValueError):
        service_base_url(value)
