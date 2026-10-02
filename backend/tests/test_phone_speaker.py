"""A speaker check exercises protected speech without entering the care pipeline."""
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app import models as m
from app.security import utcnow
from conftest import wav_bytes
from test_phone_identity import enrollment, approve


@pytest.fixture
def speaker(env, monkeypatch):
    client, app, ids = env
    created, headers = enrollment(client)
    assert approve(client, ids, created.json()['code']).status_code == 200
    calls = []
    class Speech:
        async def synthesise_speech(self, text):
            calls.append(text)
            return wav_bytes()
    monkeypatch.setattr('app.worker._provider', lambda _: Speech())
    return client, app, ids, headers, created.json()['device_id'], calls


def test_speaker_check_uses_owned_expiring_audio_and_creates_no_care_or_turn(speaker):
    client, app, ids, headers, device_id, calls = speaker
    result = client.post('/v1/phone/speaker-check', headers=headers)
    assert result.status_code == 200, result.text
    assert result.headers['cache-control'] == 'private, no-store'
    event = result.json(); payload = event['payload']
    assert payload['status'] == 'speaker_check'
    assert 'If you can hear this message' in payload['spoken_text']
    assert calls == [payload['spoken_text']]
    assert 'context_id' not in payload and 'record_id' not in payload
    asset_path = payload['audio_paths'][0]
    assert client.get(asset_path, headers=headers).content == wav_bytes()
    assert client.head(asset_path, headers=headers).status_code == 200
    created, other = enrollment(client)
    assert approve(client, ids, created.json()['code']).status_code == 200
    assert client.get(asset_path, headers=other).status_code == 404
    assert client.get(asset_path, headers={'Authorization':'Bearer '+ids['credential']}).status_code == 404
    with app.state.db.SessionLocal() as db:
        for model in [m.VoiceTurn,m.ConfirmationProposal,m.HealthNote,m.Measurement,m.SupportRequest,m.FollowUp]:
            assert db.scalar(select(func.count()).select_from(model)) == 0
        asset = db.get(m.AudioAsset, asset_path.rsplit('/',1)[1])
        assert asset.device_id == device_id
        asset.expires_at = utcnow()-timedelta(seconds=1); db.commit()
    assert client.get(asset_path, headers=headers).status_code == 410


def test_speaker_check_rejects_unpaired_pendant_and_browser_credentials(speaker):
    client, app, ids, headers, device_id, calls = speaker
    _, unpaired = enrollment(client)
    for auth in [{}, unpaired, {'Authorization':'Bearer '+ids['credential']}]:
        assert client.post('/v1/phone/speaker-check', headers=auth).status_code in {401,403}
    with app.state.db.SessionLocal() as db:
        db.get(m.Device,device_id).revoked_at=utcnow();db.commit()
    assert client.post('/v1/phone/speaker-check',headers=headers).status_code==403
    assert calls == []


@pytest.mark.parametrize('bad_audio',[False,True])
def test_speaker_check_provider_failure_is_actionable_and_creates_no_asset(speaker,monkeypatch,bad_audio):
    client, app, ids, headers, device_id, calls = speaker
    class FailedSpeech:
        async def synthesise_speech(self,text):
            if bad_audio:return b'not a WAV'
            raise RuntimeError('private upstream error must not leak')
    monkeypatch.setattr('app.worker._provider',lambda _:FailedSpeech())
    result=client.post('/v1/phone/speaker-check',headers=headers)
    assert result.status_code==503
    assert 'speaker test is unavailable' in result.json()['detail']
    assert 'private upstream' not in result.text
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(m.AudioAsset))==0


def test_speaker_check_rechecks_revocation_after_synthesis(speaker,monkeypatch):
    client, app, ids, headers, device_id, calls = speaker
    class RevokingSpeech:
        async def synthesise_speech(self,text):
            with app.state.db.SessionLocal() as db:
                db.get(m.Device,device_id).revoked_at=utcnow();db.commit()
            return wav_bytes()
    monkeypatch.setattr('app.worker._provider',lambda _:RevokingSpeech())
    assert client.post('/v1/phone/speaker-check',headers=headers).status_code==403
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(m.AudioAsset))==0


def test_speaker_check_bounds_repeated_requests_per_installation(speaker):
    client, app, ids, headers, device_id, calls = speaker
    for _ in range(6):assert client.post('/v1/phone/speaker-check',headers=headers).status_code==200
    denied=client.post('/v1/phone/speaker-check',headers=headers)
    assert denied.status_code==429 and int(denied.headers['retry-after'])>0
    assert 'speaker tests' in denied.json()['detail']
    assert len(calls)==6
