"""Route and per-target history regressions on both supported databases."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from zoneinfo import ZoneInfo
import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from app import models as m
from app.routing import choose_target
from app.security import aware, sha256, utcnow
from app.worker import process_turn, scheduler_tick
from conftest import login, wav_bytes


def auth(token): return {'Authorization': 'Bearer ' + token}


def setup(env, monkeypatch, kind='medication'):
    _, app, ids = env
    class Speech:
        async def synthesise_speech(self, text): return wav_bytes()
    monkeypatch.setattr('app.worker._provider', lambda app: Speech())
    token = uuid4().hex + uuid4().hex
    with app.state.db.SessionLocal() as db:
        phone = m.Device(device_type='phone', platform='ios', credential_hash=sha256(token), patient_id=ids['patient'])
        db.add(phone)
        if kind == 'medication':
            plan = m.MedicationPlanVersion(patient_id=ids['patient'], version=1, timezone='Asia/Singapore', source='Fictional', checked_by_user_id=ids['owner'], checked_by_name='Owner', active=True, medicines=[], schedule=[])
            db.add(plan); db.flush()
            db.add(m.DoseInstance(patient_id=ids['patient'], plan_id=plan.id, plan_version=1, medicine_id='demo', medicine_name='Fictional', scheduled_at=utcnow()))
        else:
            p = db.get(m.Patient, ids['patient']); p.daily_check_in_enabled = True
            p.daily_check_in_local_time = utcnow().astimezone(ZoneInfo(p.timezone)).strftime('%H:%M')
        db.commit()
        return phone.id, token


def choose(client, ids, phone, headers, generation=1, powered=True):
    return client.put('/v1/app/patients/' + ids['patient'] + '/active-companion', headers=headers,
        json={'device_id':phone,'expected_generation':generation,'other_pendants_powered_off':powered})


@pytest.mark.parametrize('kind', ['medication', 'checkin'])
def test_unplayed_attempt_reroutes_without_duplicate_occurrence(env, monkeypatch, kind):
    client, app, ids = env
    phone, token = setup(env, monkeypatch, kind)
    asyncio.run(scheduler_tick(app))
    model = m.ReminderCommand if kind == 'medication' else m.CheckInDelivery
    with app.state.db.SessionLocal() as db:
        first = db.scalar(select(model))
        first_id, occurrence, expiry, context = first.id, first.occurrence_id, aware(first.expires_at), first.context_id
    headers = login(client)
    assert choose(client, ids, phone, headers, powered=False).status_code == 409
    switched = choose(client, ids, phone, headers)
    assert switched.status_code == 200, switched.text
    assert switched.json()['generation'] == 2
    asyncio.run(scheduler_tick(app)); asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        attempts = db.scalars(select(model).order_by(model.created_at)).all()
        assert len(attempts) == 2
        assert attempts[0].id == first_id and attempts[0].delivery_state == 'cancelled'
        assert attempts[0].cancel_reason == 'route_changed'
        assert attempts[1].device_id == phone and attempts[1].route_generation == 2
        assert {a.occurrence_id for a in attempts} == {occurrence}
        assert all(aware(a.expires_at) == expiry for a in attempts)
        assert db.scalar(select(func.count()).select_from(m.ReminderOccurrence)) == 1
        if kind == 'medication':
            assert db.scalar(select(func.count()).select_from(m.DoseInstance)) == 1
            assert db.scalar(select(m.DoseInstance.report_state)) == 'unconfirmed'
    old = client.get('/v1/device/pending-commands', headers=auth(ids['credential'])).json()
    assert old['commands'] == old['checkins'] == []
    new = client.get('/v1/device/pending-commands', headers=auth(token)).json()
    assert len(new['commands'] + new['checkins']) == 1
    assert client.post('/v1/device/turns', content=wav_bytes(), headers={**auth(ids['credential']), 'Content-Type':'audio/wav','Idempotency-Key':str(uuid4()), 'X-Context-Id':context}).status_code == 409


@pytest.mark.parametrize('state', ['downloaded','playback_started','playback_completed','interrupted','playback_unknown','failed'])
def test_possible_playback_never_silently_repeats(env, monkeypatch, state):
    client, app, ids = env
    phone, _ = setup(env, monkeypatch)
    asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        attempt = db.scalar(select(m.ReminderCommand)); asset, command = attempt.audio_asset_id, attempt.id
        if state != 'downloaded': attempt.delivery_state = state; db.commit()
    if state == 'downloaded':
        assert client.get('/v1/device/audio/' + asset, headers=auth(ids['credential'])).status_code == 200
    assert choose(client, ids, phone, login(client)).status_code == 200
    asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(m.ReminderCommand)) == 1
        assert db.scalar(select(m.DoseInstance.report_state)) == 'unconfirmed'
    assert client.get('/v1/device/audio/' + asset, headers=auth(ids['credential'])).status_code == 410
    assert client.post('/v1/device/acks', headers=auth(ids['credential']), json={'ack_id':str(uuid4()),'command_id':command,'stage':'playback_started'}).status_code == 409


def test_phone_quiescence_required_even_after_owner_revocation(env, monkeypatch):
    client, app, ids = env
    phone, token = setup(env, monkeypatch); headers = login(client)
    assert choose(client, ids, phone, headers).status_code == 200
    assert choose(client, ids, ids['device'], headers, generation=2).status_code == 409
    assert client.delete('/v1/phone/installation', headers=auth(token)).status_code == 409
    body = {'playback_stopped':True,'local_alerts_cleared':False}
    assert client.post('/v1/phone/quiesce', headers=auth(token), json=body).status_code == 422
    assert client.post('/v1/app/devices/' + phone + '/revoke', headers=headers).status_code == 200
    assert choose(client, ids, ids['device'], headers, generation=2).status_code == 409
    assert client.get('/v1/phone/home', headers=auth(token)).status_code == 403
    body['local_alerts_cleared'] = True
    assert client.post('/v1/phone/quiesce', headers=auth(token), json=body).json() == {'status':'paused'}
    assert client.get('/v1/phone/home', headers=auth(token)).status_code == 403
    assert choose(client, ids, ids['device'], headers, generation=2).status_code == 409
    assert choose(client, ids, ids['device'], headers, generation=3).status_code == 200
    assert client.post('/v1/phone/quiesce', headers=auth(token), json=body).status_code == 200
    with app.state.db.SessionLocal() as db:
        route = db.get(m.CompanionRoute, ids['patient'])
        assert route.active_device_id == ids['device'] and route.generation == 4


def test_permissions_scope_and_concurrent_compare_and_set(env, monkeypatch):
    client, app, ids = env
    phone, _ = setup(env, monkeypatch)
    caregiver = login(client,'caregiver@example.invalid','caregiver-password')
    assert choose(client, ids, phone, caregiver).status_code == 403
    owner = login(client)
    assert choose(client, ids, phone, {}).status_code == 403
    with app.state.db.SessionLocal() as db:
        foreign = m.Device(credential_hash=sha256('foreign'),patient_id=ids['other_patient'])
        db.add(foreign); db.commit(); foreign_id = foreign.id
    assert choose(client, ids, foreign_id, owner).status_code == 422
    def change(_):
        with app.state.db.SessionLocal() as db:
            try:
                result = choose_target(db, ids['patient'], phone, 1, True, ids['owner']); db.commit()
                return result['generation']
            except HTTPException as e: return e.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(change, range(2))) == [2,409]


def test_no_automatic_target_and_switch_during_tts_fences_enqueue(env, monkeypatch):
    _, app, ids = env
    phone, _ = setup(env, monkeypatch)
    with app.state.db.SessionLocal() as db:
        db.delete(db.get(m.CompanionRoute, ids['patient'])); db.commit()
    asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(m.ReminderCommand)) == 0
        choose_target(db, ids['patient'], ids['device'], 0, True, ids['owner']); db.commit()
    class SwitchingSpeech:
        async def synthesise_speech(self, text):
            with app.state.db.SessionLocal() as db:
                choose_target(db, ids['patient'], phone, 1, True, ids['owner']); db.commit()
            return wav_bytes()
    monkeypatch.setattr('app.worker._provider',lambda app: SwitchingSpeech())
    asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(m.ReminderCommand)) == 0
        assert db.scalar(select(func.count()).select_from(m.AudioAsset)) == 0


def test_plan_change_during_speech_prevents_enqueue(env, monkeypatch):
    _, app, _ = env
    setup(env, monkeypatch)
    class ChangingSpeech:
        async def synthesise_speech(self, text):
            with app.state.db.SessionLocal() as db:
                plan = db.scalar(select(m.MedicationPlanVersion)); plan.active = False; db.commit()
            return wav_bytes()
    monkeypatch.setattr('app.worker._provider',lambda app: ChangingSpeech())
    asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(m.ReminderCommand)) == 0


def test_recorded_ack_retry_remains_idempotent_after_switch(env, monkeypatch):
    client, app, ids = env
    phone, _ = setup(env, monkeypatch); asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db: command = db.scalar(select(m.ReminderCommand)).id
    ack = {'command_id':command,'ack_id':str(uuid4()),'stage':'received'}
    assert client.post('/v1/device/acks',headers=auth(ids['credential']),json=ack).status_code == 200
    assert choose(client, ids, phone, login(client)).status_code == 200
    assert client.post('/v1/device/acks',headers=auth(ids['credential']),json=ack).status_code == 200
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(m.ReminderAck)) == 1
        assert db.get(m.ReminderCommand,command).delivery_state == 'cancelled'


def test_voice_tts_holds_no_write_lock_and_revocation_prevents_proposal(env, monkeypatch):
    _, app, ids = env
    phone, _ = setup(env, monkeypatch)
    class RevokingSpeech:
        async def transcribe_audio(self, wav, *, vocabulary=None): return 'My knee hurts'
        async def interpret_turn(self, transcript, context):
            return {'intent':'proposal','kind':'health_note','payload':{'wording':'My knee hurts'}}
        async def synthesise_speech(self, text):
            with app.state.db.SessionLocal() as db:
                device = db.get(m.Device,phone); device.revoked_at = utcnow(); db.commit()
            return wav_bytes()
    monkeypatch.setattr('app.worker._provider',lambda app: RevokingSpeech())
    with app.state.db.SessionLocal() as db:
        turn=m.VoiceTurn(device_id=phone,patient_id=ids['patient'],idempotency_key=str(uuid4()),content_sha256='fixture',raw_audio=wav_bytes())
        db.add(turn); db.commit(); turn_id=turn.id
    asyncio.run(process_turn(app,turn_id))
    with app.state.db.SessionLocal() as db:
        assert db.get(m.VoiceTurn,turn_id).status == 'failed'
        assert db.scalar(select(func.count()).select_from(m.ConfirmationProposal)) == 0
        assert db.scalar(select(func.count()).select_from(m.AudioAsset)) == 0


def test_new_phone_readback_invalidates_old_and_late_older_completion(env, monkeypatch):
    from datetime import timedelta
    from app.services import create_proposal,commit_proposal
    _,app,ids=env
    phone,_=setup(env,monkeypatch)
    with app.state.db.SessionLocal() as db:
        first=m.VoiceTurn(device_id=phone,patient_id=ids['patient'],idempotency_key=str(uuid4()),content_sha256='first',status='awaiting_confirmation',received_at=utcnow()-timedelta(seconds=2))
        second=m.VoiceTurn(device_id=phone,patient_id=ids['patient'],idempotency_key=str(uuid4()),content_sha256='second',status='processing')
        db.add_all([first,second]);db.commit()
        original=create_proposal(db,ids['patient'],'health_note',{'wording':'First note'},source_turn_id=first.id)
        db.commit(); original_id=original.id
        current=create_proposal(db,ids['patient'],'health_note',{'wording':'Second note'},source_turn_id=second.id)
        second.status='awaiting_confirmation';db.commit()
        with pytest.raises(HTTPException) as error: commit_proposal(db,original_id,ids['patient'])
        assert error.value.status_code==409
        db.rollback()
        with pytest.raises(HTTPException) as error: create_proposal(db,ids['patient'],'health_note',{'wording':'Late first note'},source_turn_id=first.id)
        assert error.value.status_code==409
        db.rollback()
        assert db.get(m.ConfirmationProposal,current.id,populate_existing=True).status=='pending'
        assert db.scalar(select(func.count()).select_from(m.HealthNote))==0


@pytest.mark.parametrize('kind', ['medication', 'checkin'])
def test_head_checks_route_without_claiming_audio_was_downloaded(env, monkeypatch, kind):
    client, app, ids = env
    phone, _ = setup(env, monkeypatch, kind)
    asyncio.run(scheduler_tick(app))
    model = m.ReminderCommand if kind == 'medication' else m.CheckInDelivery
    with app.state.db.SessionLocal() as db:
        command = db.scalar(select(model))
        command_id = command.id
        asset = command.audio_asset_id if kind == 'medication' else command.audio_asset_ids[0]
    path = '/v1/device/audio/' + asset
    assert client.head(path, headers=auth(ids['credential'])).status_code == 200
    with app.state.db.SessionLocal() as db:
        assert db.get(model, command_id).audio_accessed_at is None
    assert choose(client, ids, phone, login(client)).status_code == 200
    assert client.head(path, headers=auth(ids['credential'])).status_code == 410
    asyncio.run(scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        # A metadata check is not download/playback evidence: the unplayed
        # occurrence may still move to the explicitly selected replacement.
        assert db.scalar(select(func.count()).select_from(model)) == 2
