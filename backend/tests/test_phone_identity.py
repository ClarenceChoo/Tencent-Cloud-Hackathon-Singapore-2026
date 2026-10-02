import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import select

from app import models as m
from app.security import sha256, utcnow
from conftest import login


def enrollment(client, token=None, key=None):
    token, key = token or secrets.token_hex(32), key or str(uuid4())
    headers = {'Authorization': 'Bearer ' + token, 'Idempotency-Key': key}
    response = client.post('/v1/phone/enrollments', json={'platform': 'ios', 'display_name': 'Test iPhone'}, headers=headers)
    return response, headers


def approve(client, ids, code, headers=None):
    return client.post('/v1/app/phone-enrollments/approve', json={'code': code, 'patient_id': ids['patient']}, headers=headers or login(client))


def test_enrollment_retry_binding_and_revocation(env):
    client, app, ids = env
    created, headers = enrollment(client)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body['status'] == 'awaiting_approval' and 'patient' not in body
    assert created.headers['cache-control'] == 'private, no-store'
    replay, _ = enrollment(client, headers['Authorization'][7:], headers['Idempotency-Key'])
    assert replay.status_code == 200 and replay.json() == body
    assert client.get('/v1/device/info', headers=headers).status_code == 403
    assert client.get('/v1/auth/session', headers=headers).status_code == 401
    assert client.get('/v1/phone/enrollments/current', headers={'Authorization': 'Bearer ' + body['code']}).status_code == 401
    with app.state.db.SessionLocal() as db:
        device = db.get(m.Device, body['device_id'])
        assert device.credential_hash == sha256(headers['Authorization'][7:])
        assert device.claim_code_hash == sha256(body['code'])
        assert device.device_type == 'phone'
    owner = login(client)
    assert client.post('/v1/app/devices/claim', json={'code': body['code'], 'patient_id': ids['patient']}, headers=owner).status_code == 400
    assert approve(client, ids, body['code'], owner).status_code == 200
    assert approve(client, ids, body['code'], owner).status_code == 400
    current = client.get('/v1/phone/enrollments/current', headers=headers).json()
    assert current['patient']['id'] == ids['patient'] and current['status'] == 'paired'
    assert 'code' not in current
    assert client.get('/v1/device/info', headers=headers).status_code == 200
    assert client.post('/v1/app/devices/' + body['device_id'] + '/revoke', headers=owner).status_code == 200
    assert client.get('/v1/phone/enrollments/current', headers=headers).status_code == 403
    assert client.get('/v1/device/pending-commands', headers=headers).status_code == 403


def test_pairing_permission_csrf_expiry_and_scope(env):
    client, app, ids = env
    created, headers = enrollment(client)
    code = created.json()['code']
    assert approve(client, ids, code, {'Origin': 'http://testserver'}).status_code == 401
    caregiver = login(client, 'caregiver@example.invalid', 'caregiver-password')
    assert approve(client, ids, code, caregiver).status_code == 403
    owner = login(client)
    assert approve(client, ids, code, {'Origin': 'http://testserver'}).status_code == 403
    assert approve(client, ids, code, {**owner, 'Origin': 'https://other.invalid'}).status_code == 403
    assert approve(client, {**ids, 'patient': ids['other_patient']}, code, owner).status_code == 403
    with app.state.db.SessionLocal() as db:
        device = db.get(m.Device, created.json()['device_id'])
        device.claim_expires_at = utcnow() - timedelta(seconds=1)
        db.get(m.PhoneEnrollment, device.id).expires_at = device.claim_expires_at
        db.commit()
    assert approve(client, ids, code, owner).status_code == 400
    assert client.get('/v1/phone/enrollments/current', headers=headers).status_code == 410


def test_enrollment_keys_cannot_take_over_identity(env):
    client, app, ids = env
    created, headers = enrollment(client)
    assert enrollment(client, key=headers['Idempotency-Key'])[0].status_code == 409
    assert enrollment(client, token=headers['Authorization'][7:])[0].status_code == 409
    wrong_payload = client.post('/v1/phone/enrollments', json={'platform': 'android', 'display_name': 'Test iPhone'}, headers=headers)
    assert wrong_payload.status_code == 409
    injected = client.post('/v1/phone/enrollments', json={'platform': 'ios', 'display_name': 'Test', 'patient_id': ids['patient']}, headers=headers)
    assert injected.status_code == 422
    assert client.delete('/v1/phone/installation', headers={'Authorization': 'Bearer ' + ids['credential']}).status_code == 403
    assert client.get('/v1/phone/enrollments/current', headers={'Authorization': 'Bearer ' + secrets.token_hex(32)}).status_code == 401


def test_concurrent_registration_and_approval_are_single_use(env):
    client, app, ids = env
    token, key = secrets.token_hex(32), str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: enrollment(client, token, key)[0], range(2)))
    assert sorted(r.status_code for r in results) == [200, 201]
    assert results[0].json()['device_id'] == results[1].json()['device_id']
    owner = login(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: approve(client, ids, results[0].json()['code'], owner), range(2)))
    assert sum(c.status_code == 200 for c in claims) == 1
    assert all(c.status_code in {200, 400, 409} for c in claims)
    with app.state.db.SessionLocal() as db:
        assert len(db.scalars(select(m.PhoneEnrollment)).all()) == 1


def test_pairing_is_rate_limited_and_requires_tls(env):
    client, app, ids = env
    for _ in range(8):
        assert enrollment(client)[0].status_code == 201
    limited, _ = enrollment(client)
    assert limited.status_code == 429 and 'retry-after' in limited.headers
    app.state.settings.testing = False
    assert client.get('/v1/phone/enrollments/current', headers={'Authorization': 'Bearer ' + secrets.token_hex(32)}).status_code == 400


def test_phone_can_revoke_only_its_own_installation(env):
    client, app, ids = env
    created, headers = enrollment(client)
    assert approve(client, ids, created.json()['code']).status_code == 200
    assert client.delete('/v1/phone/installation', headers=headers).json()['status'] == 'revoked'
    assert client.get('/v1/device/info', headers=headers).status_code == 403
    assert client.get('/v1/device/info', headers={'Authorization': 'Bearer ' + ids['credential']}).status_code == 200
