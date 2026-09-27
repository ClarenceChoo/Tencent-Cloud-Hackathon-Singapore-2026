import io
import shutil
import subprocess
import wave
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import models as m
from app.phone_audio import MAX_INPUT, normalize_phone_audio
from app.services import sha_bytes, validate_wav
from conftest import login, wav_bytes
from test_phone_identity import enrollment, approve


@pytest.fixture
def m4a(tmp_path):
    assert shutil.which('ffmpeg'), 'Install FFmpeg to verify the phone decoder'
    path = tmp_path / 'microphone-format.m4a'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                    'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'aac', str(path)], check=True)
    return path.read_bytes()


def test_actual_aac_decoding_and_format_bounds(m4a):
    wav = normalize_phone_audio(m4a, 'audio/mp4')
    assert 900 <= validate_wav(wav) <= 1100
    with wave.open(io.BytesIO(wav)) as reader:
        assert (reader.getnchannels(), reader.getframerate(), reader.getsampwidth()) == (1, 16000, 2)
    for body, mime in [(m4a, 'audio/wav'), (wav, 'audio/mp4'), (b'bad', 'audio/mp4'), (m4a, 'audio/aac'), (b'x' * (MAX_INPUT + 1), 'audio/mp4'), (m4a[:24], 'audio/mp4')]:
        with pytest.raises(HTTPException):
            normalize_phone_audio(body, mime)


def test_decoder_rejects_non_audio_overlong_and_missing_tool(tmp_path, monkeypatch):
    for name, source, codec in [('long', 'sine=duration=21', 'aac'), ('video', 'color=duration=1:size=16x16', 'mpeg4')]:
        path = tmp_path / (name + '.mp4')
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', source, '-c', codec, str(path)], check=True)
        with pytest.raises(HTTPException) as exc:
            normalize_phone_audio(path.read_bytes(), 'audio/mp4')
        assert exc.value.status_code == 400
    monkeypatch.setattr('app.phone_audio.shutil.which', lambda _: None)
    with pytest.raises(HTTPException) as exc:
        normalize_phone_audio(path.read_bytes(), 'audio/mp4')
    assert exc.value.status_code == 503


@pytest.fixture
def phone(env, monkeypatch):
    client, app, ids = env
    created, headers = enrollment(client)
    assert approve(client, ids, created.json()['code']).status_code == 200

    class FixtureSpeech:
        async def transcribe_audio(self, wav):
            validate_wav(wav)
            return 'My knee hurt after walking'
        async def interpret_turn(self, transcript, context):
            return {'intent': 'proposal', 'kind': 'health_note', 'payload': {
                'wording': 'My knee hurt after walking', 'share_with_user_ids': [ids['caregiver']]}, 'spoken_text': ''}
        async def synthesise_speech(self, text):
            return wav_bytes()
    monkeypatch.setattr('app.worker._provider', lambda _: FixtureSpeech())
    monkeypatch.setattr('app.providers.get_provider', lambda **_: FixtureSpeech())
    return client, app, ids, headers


def proposal_for(client, headers, body):
    response = client.post('/v1/phone/turns', content=body, headers={**headers, 'Content-Type': 'audio/mp4'})
    assert response.status_code == 202, response.text
    home = client.get('/v1/phone/home', headers=headers)
    assert home.status_code == 200, home.text
    return response.json(), home.json()['current_proposal']


def test_phone_turn_recovery_confirmation_and_dashboard_share(phone, m4a):
    client, app, ids, headers = phone
    receipt, proposal = proposal_for(client, headers, m4a)
    with app.state.db.SessionLocal() as db:
        turn = db.get(m.VoiceTurn, receipt['turn_id'])
        assert turn.content_sha256 == sha_bytes(m4a) and turn.raw_audio is None
        assert len(db.scalars(select(m.HealthNote)).all()) == 0
    retry = client.post('/v1/phone/turns', content=m4a, headers={**headers, 'Content-Type': 'audio/mp4'})
    assert retry.json()['turn_id'] == receipt['turn_id']
    recovered = client.get('/v1/phone/turn-receipts/' + headers['Idempotency-Key'], headers=headers)
    assert recovered.json()['turn_id'] == receipt['turn_id']
    result = client.get('/v1/device/turns/' + receipt['turn_id'], headers=headers).json()['event']['payload']
    assert result['status'] == 'awaiting_confirmation'
    audio = result['audio_paths'][0]
    assert client.get(audio, headers=headers).status_code == 200
    readback = client.post('/v1/phone/proposals/' + proposal['id'] + '/speech', json={'context_id': proposal['context_id']}, headers=headers)
    assert readback.status_code == 200 and readback.json()['payload']['spoken_text'] == proposal['readback']
    assert client.get(audio, headers={'Authorization': 'Bearer ' + ids['credential']}).status_code == 404
    confirmation = {'confirmed': True, 'context_id': proposal['context_id']}
    url = '/v1/phone/proposals/' + proposal['id'] + '/confirm'
    assert client.post(url, json={**confirmation, 'context_id': 'wrong'}, headers=headers).status_code == 404
    assert client.post(url, json={**confirmation, 'confirmed': False}, headers=headers).status_code == 422
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: client.post(url, json=confirmation, headers=headers), range(2)))
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    assert results[0].json() == results[1].json()
    saved = client.post('/v1/phone/proposals/' + proposal['id'] + '/speech', json={'context_id': proposal['context_id']}, headers=headers)
    assert saved.json()['payload']['spoken_text'] == 'Saved.'
    home = client.get('/v1/phone/home', headers=headers).json()
    assert home['notes'][0]['source']['type'] == 'phone'
    assert 'access_grants' not in home and 'password' not in str(home)
    login(client, 'caregiver@example.invalid', 'caregiver-password')
    dashboard = client.get('/v1/app/patients/' + ids['patient'] + '/dashboard').json()
    assert len(dashboard['notes']) == 1
    login(client, 'caregiver2@example.invalid', 'caregiver2-password')
    assert client.get('/v1/app/patients/' + ids['patient'] + '/dashboard').json()['notes'] == []


def test_correction_invalidates_readback_and_phone_scope_is_enforced(phone, m4a):
    client, app, ids, headers = phone
    _, proposal = proposal_for(client, headers, m4a)
    created, second = enrollment(client)
    assert approve(client, ids, created.json()['code']).status_code == 200
    url = '/v1/phone/proposals/' + proposal['id']
    confirmation = {'context_id': proposal['context_id'], 'confirmed': True}
    assert client.post(url + '/confirm', json=confirmation, headers=second).status_code == 404
    assert client.post('/v1/phone/turns', content=m4a, headers={**second, 'Content-Type': 'audio/mp4', 'X-Context-Id': proposal['context_id']}).status_code == 404
    revised = client.post(url + '/revise', json={'context_id': proposal['context_id'], 'payload': {'wording': 'Left knee yesterday'}}, headers=headers)
    assert revised.status_code == 201, revised.text
    assert client.post(url + '/confirm', json=confirmation, headers=headers).status_code == 409
    corrected = revised.json()
    cancel_url = '/v1/phone/proposals/' + corrected['id'] + '/cancel'
    assert client.post(cancel_url, json={'context_id': corrected['context_id']}, headers=headers).status_code == 200
    assert client.post(cancel_url, json={'context_id': corrected['context_id']}, headers=headers).status_code == 200
    with app.state.db.SessionLocal() as db:
        assert not db.scalars(select(m.HealthNote)).all()
    client.delete('/v1/phone/installation', headers=headers)
    assert client.get('/v1/phone/home', headers=headers).status_code == 403
    assert client.get('/v1/phone/turn-receipts/' + headers['Idempotency-Key'], headers=headers).status_code == 403


def test_revocation_during_provider_work_prevents_new_care_record(phone, m4a, monkeypatch):
    client, app, ids, headers = phone
    class RevokingProvider:
        async def transcribe_audio(self, body):
            return 'A note that must not be committed after revocation'
        async def interpret_turn(self, transcript, context):
            with app.state.db.SessionLocal() as db:
                device = db.get(m.Device, context['device']['id'])
                from app.security import utcnow
                device.revoked_at = utcnow()
                db.commit()
            return {'intent': 'proposal', 'kind': 'health_note', 'payload': {'wording': transcript}, 'spoken_text': ''}
        async def synthesise_speech(self, text):
            raise AssertionError('Revoked phones must not synthesize a new reply')
    monkeypatch.setattr('app.worker._provider', lambda _: RevokingProvider())
    accepted = client.post('/v1/phone/turns', content=m4a, headers={**headers, 'Content-Type': 'audio/mp4'})
    assert accepted.status_code == 202
    with app.state.db.SessionLocal() as db:
        turn = db.get(m.VoiceTurn, accepted.json()['turn_id'])
        assert turn.status == 'failed' and turn.raw_audio is None
        assert not db.scalars(select(m.ConfirmationProposal)).all()
        assert not db.scalars(select(m.HealthNote)).all()
    assert client.get('/v1/phone/home', headers=headers).status_code == 403


def test_decoder_concurrency_bound_releases_slots():
    from app.phone_audio import DECODER_SLOTS
    DECODER_SLOTS.acquire(); DECODER_SLOTS.acquire()
    try:
        with pytest.raises(HTTPException) as exc:
            normalize_phone_audio(wav_bytes(), 'audio/wav')
        assert exc.value.status_code == 429
    finally:
        DECODER_SLOTS.release(); DECODER_SLOTS.release()
    assert normalize_phone_audio(wav_bytes(), 'audio/wav') == wav_bytes()
