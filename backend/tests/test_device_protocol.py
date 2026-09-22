import asyncio
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from uuid import uuid4

from sqlalchemy import select

from app import models as m
from app.security import utcnow
from app.services import materialize_plan_doses, sha_bytes
from app.worker import process_turn, scheduler_tick
from conftest import ORIGIN, login, wav_bytes


def auth(ids):
    return {"Authorization": "Bearer %s" % ids["credential"]}


def test_wav_validation_device_scope_and_idempotency(env, monkeypatch):
    client, app, ids = env

    class FakeProvider:
        async def transcribe_audio(self, wav):
            return "I have a sore knee"

        async def interpret_turn(self, transcript, context):
            return {"intent": "proposal", "kind": "health_note", "payload": {"wording": "Sore knee", "occurrence_text": "today"}, "spoken_text": ""}

        async def synthesise_speech(self, text):
            return wav_bytes(0.4)

    monkeypatch.setattr("app.worker._provider", lambda application: FakeProvider())
    monkeypatch.setattr("app.providers.get_provider", lambda fixture_transcripts=None: FakeProvider())
    key = str(uuid4())
    body = wav_bytes()
    headers = dict(auth(ids), **{"Content-Type": "audio/wav", "Idempotency-Key": key})
    first = client.post("/v1/device/turns", content=body, headers=headers)
    assert first.status_code == 202, first.text
    second = client.post("/v1/device/turns", content=body, headers=headers)
    assert second.status_code == 202
    assert first.json()["turn_id"] == second.json()["turn_id"]
    conflict = client.post("/v1/device/turns", content=wav_bytes(0.5), headers=headers)
    assert conflict.status_code == 409
    recovered = client.get("/v1/device/turns/%s" % first.json()["turn_id"], headers=auth(ids))
    assert recovered.status_code == 200
    assert recovered.json()["event"]["type"] == "turn.result"
    assert recovered.json()["event"]["payload"]["status"] == "awaiting_confirmation"
    invalid = client.post("/v1/device/turns", content=b"not wav", headers=dict(auth(ids), **{"Content-Type": "audio/wav", "Idempotency-Key": str(uuid4())}))
    assert invalid.status_code == 400


def test_playback_ack_does_not_report_dose_taken(env):
    client, app, ids = env
    db = app.state.db.SessionLocal()
    plan = m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone="Asia/Singapore", source="Fictional label", checked_by_user_id=ids["owner"], checked_by_name="Owner", active=True, medicines=[{"id": "med", "name": "Demo", "instructions": "Fictional", "reviewed_reference": "Fictional", "reference_source": "Label"}], schedule=[{"medicine_id": "med", "local_time": "08:00"}])
    db.add(plan)
    db.flush()
    dose = m.DoseInstance(patient_id=ids["patient"], plan_id=plan.id, plan_version=1, medicine_id="med", medicine_name="Demo", scheduled_at=utcnow())
    db.add(dose)
    db.flush()
    audio = wav_bytes()
    asset = m.AudioAsset(device_id=ids["device"], wav_bytes=audio, content_sha256=sha_bytes(audio), duration_ms=400, expires_at=utcnow() + timedelta(minutes=2))
    db.add(asset)
    db.flush()
    command = m.ReminderCommand(device_id=ids["device"], dose_instance_id=dose.id, plan_version=1, audio_asset_id=asset.id, expires_at=utcnow() + timedelta(minutes=2))
    db.add(command)
    db.commit()
    command_id, dose_id = command.id, dose.id
    db.close()
    response = client.post("/v1/device/acks", json={"ack_id": str(uuid4()), "command_id": command_id, "stage": "playback_completed", "device_time": None}, headers=auth(ids))
    assert response.status_code == 200, response.text
    db = app.state.db.SessionLocal()
    assert db.get(m.DoseInstance, dose_id).report_state == "unconfirmed"
    assert db.get(m.ReminderCommand, command_id).delivery_state == "playback_completed"
    db.close()


def test_one_use_claim_and_revoked_device_rejected(env):
    client, app, ids = env
    headers = login(client)
    claim = client.post("/v1/app/devices/claim", json={"code": ids["claim_code"], "patient_id": ids["patient"]}, headers=headers)
    assert claim.status_code == 200
    again = client.post("/v1/app/devices/claim", json={"code": ids["claim_code"], "patient_id": ids["patient"]}, headers=headers)
    assert again.status_code == 400
    revoked = client.post("/v1/app/devices/%s/revoke" % ids["device"], headers=headers)
    assert revoked.status_code == 200
    assert client.get("/v1/device/pending-commands", headers=auth(ids)).status_code == 403


def test_pending_commands_expose_current_plan_version_and_filter_stale(env):
    client, app, ids = env
    db = app.state.db.SessionLocal()
    old = m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone="Asia/Singapore", source="Old", checked_by_user_id=ids["owner"], checked_by_name="Owner", active=False, medicines=[], schedule=[])
    current = m.MedicationPlanVersion(patient_id=ids["patient"], version=2, timezone="Asia/Singapore", source="Current", checked_by_user_id=ids["owner"], checked_by_name="Owner", active=True, medicines=[], schedule=[])
    db.add_all([old, current]); db.flush()
    audio = wav_bytes(); asset = m.AudioAsset(device_id=ids["device"], wav_bytes=audio, content_sha256=sha_bytes(audio), duration_ms=400, expires_at=utcnow()+timedelta(minutes=2)); db.add(asset); db.flush()
    for plan in [old, current]:
        dose = m.DoseInstance(patient_id=ids["patient"], plan_id=plan.id, plan_version=plan.version, medicine_id="m", medicine_name="Demo", scheduled_at=utcnow()); db.add(dose); db.flush()
        db.add(m.ReminderCommand(device_id=ids["device"], dose_instance_id=dose.id, plan_version=plan.version, audio_asset_id=asset.id, expires_at=utcnow()+timedelta(minutes=2)))
    db.commit(); db.close()
    response = client.get("/v1/device/pending-commands", headers=auth(ids))
    assert response.status_code == 200
    assert response.json()["current_plan_version"] == 2
    assert [item["payload"]["plan_version"] for item in response.json()["commands"]] == [2]
    assert response.json()["checkins"] == []


def test_retry_after_confirmation_commit_returns_original_turn(env, monkeypatch):
    client, app, ids = env
    owner_headers = login(client)
    proposal = client.post("/v1/app/patients/%s/proposals" % ids["patient"], json={"kind": "health_note", "payload": {"wording": "Awaiting device confirmation"}}, headers=owner_headers).json()

    class FakeProvider:
        async def transcribe_audio(self, wav):
            return "yes save that"
        async def interpret_turn(self, transcript, context):
            return {"intent": "confirm", "kind": None, "payload": {}, "spoken_text": ""}
        async def synthesise_speech(self, text):
            return wav_bytes()

    monkeypatch.setattr("app.worker._provider", lambda application: FakeProvider())
    monkeypatch.setattr("app.providers.get_provider", lambda fixture_transcripts=None: FakeProvider())
    key, audio = str(uuid4()), wav_bytes()
    headers = dict(auth(ids), **{"Content-Type": "audio/wav", "Idempotency-Key": key, "X-Context-Id": proposal["context_id"]})
    first = client.post("/v1/device/turns", content=audio, headers=headers)
    assert first.status_code == 202
    retry = client.post("/v1/device/turns", content=audio, headers=headers)
    assert retry.status_code == 202
    assert retry.json()["turn_id"] == first.json()["turn_id"]
    db = app.state.db.SessionLocal()
    assert db.get(m.ConfirmationProposal, proposal["id"]).status == "committed"
    assert len(db.scalars(select(m.HealthNote).where(m.HealthNote.patient_id == ids["patient"])).all()) == 1
    db.close()


def test_stale_plan_audio_and_playback_start_are_rejected(env):
    client, app, ids = env
    db = app.state.db.SessionLocal()
    old = m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone="Asia/Singapore", source="Old", checked_by_user_id=ids["owner"], checked_by_name="Owner", active=False, medicines=[], schedule=[])
    current = m.MedicationPlanVersion(patient_id=ids["patient"], version=2, timezone="Asia/Singapore", source="Current", checked_by_user_id=ids["owner"], checked_by_name="Owner", active=True, medicines=[], schedule=[])
    db.add_all([old, current]); db.flush()
    dose = m.DoseInstance(patient_id=ids["patient"], plan_id=old.id, plan_version=1, medicine_id="m", medicine_name="Old", scheduled_at=utcnow())
    db.add(dose); db.flush()
    audio = wav_bytes(); asset = m.AudioAsset(device_id=ids["device"], wav_bytes=audio, content_sha256=sha_bytes(audio), duration_ms=400, expires_at=utcnow()+timedelta(minutes=2)); db.add(asset); db.flush()
    command = m.ReminderCommand(device_id=ids["device"], dose_instance_id=dose.id, plan_version=1, audio_asset_id=asset.id, expires_at=utcnow()+timedelta(minutes=2)); db.add(command); db.commit()
    asset_id, command_id = asset.id, command.id; db.close()
    assert client.get("/v1/device/audio/%s" % asset_id, headers=auth(ids)).status_code == 410
    started = client.post("/v1/device/acks", json={"ack_id": str(uuid4()), "command_id": command_id, "stage": "playback_started"}, headers=auth(ids))
    assert started.status_code == 409
    expired = client.post("/v1/device/acks", json={"ack_id": str(uuid4()), "command_id": command_id, "stage": "expired"}, headers=auth(ids))
    assert expired.status_code == 200


def test_daily_checkin_is_durable_once_per_local_day(env, monkeypatch):
    client, app, ids = env

    class FakeProvider:
        async def synthesise_speech(self, text):
            return wav_bytes()

    monkeypatch.setattr("app.worker._provider", lambda application: FakeProvider())
    now = utcnow()
    local_now = now.astimezone(ZoneInfo("Asia/Singapore"))
    db = app.state.db.SessionLocal(); patient = db.get(m.Patient, ids["patient"])
    patient.daily_check_in_enabled = True
    patient.daily_check_in_local_time = local_now.strftime("%H:%M")
    patient.preferred_name = "Mei"
    db.commit(); db.close()
    asyncio.run(scheduler_tick(app)); asyncio.run(scheduler_tick(app))
    db = app.state.db.SessionLocal()
    checkins = db.scalars(select(m.CheckInDelivery).where(m.CheckInDelivery.patient_id == ids["patient"])).all()
    assert len(checkins) == 1
    assert checkins[0].greeting_text.startswith("Hello Mei")
    assert db.get(m.DeviceEvent, checkins[0].event_id).event_type == "checkin.play"
    checkin_id = checkins[0].id
    db.close()
    pending = client.get("/v1/device/pending-commands", headers=auth(ids)).json()
    assert [item["payload"]["command_id"] for item in pending["checkins"]] == [checkin_id]
    ack = client.post("/v1/device/acks", json={"ack_id": str(uuid4()), "command_id": checkin_id, "stage": "playback_completed"}, headers=auth(ids))
    assert ack.status_code == 200


def test_scheduler_extends_recurring_doses_without_duplicates(env):
    client, app, ids = env
    now = datetime(2026, 9, 22, 0, 0, tzinfo=timezone.utc)
    db = app.state.db.SessionLocal()
    plan = m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone="Asia/Singapore", source="Fictional", checked_by_user_id=ids["owner"], checked_by_name="Owner", active=True, medicines=[{"id": "med", "name": "Demo", "instructions": "Fictional", "reviewed_reference": "Fictional", "reference_source": "Demo"}], schedule=[{"medicine_id": "med", "local_time": "08:00"}])
    db.add(plan); db.flush()
    assert materialize_plan_doses(db, plan, now=now) == 3
    db.flush()
    later = now + timedelta(days=4)
    assert materialize_plan_doses(db, plan, now=later) == 3
    db.flush()
    assert materialize_plan_doses(db, plan, now=later) == 0
    assert len(db.scalars(select(m.DoseInstance).where(m.DoseInstance.plan_id == plan.id)).all()) == 6
    db.close()


def test_scheduler_persists_due_reminder_without_changing_report_state(env, monkeypatch):
    client, app, ids = env

    class FakeProvider:
        async def synthesise_speech(self, text):
            return wav_bytes()

    monkeypatch.setattr("app.worker._provider", lambda application: FakeProvider())
    db = app.state.db.SessionLocal()
    plan = m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone="Asia/Singapore", source="Fictional", checked_by_user_id=ids["owner"], checked_by_name="Owner", active=True, medicines=[], schedule=[])
    db.add(plan); db.flush()
    dose = m.DoseInstance(patient_id=ids["patient"], plan_id=plan.id, plan_version=1, medicine_id="m", medicine_name="DemoMed", scheduled_at=utcnow())
    future = m.DoseInstance(patient_id=ids["patient"], plan_id=plan.id, plan_version=1, medicine_id="m", medicine_name="LaterMed", scheduled_at=utcnow() + timedelta(seconds=5))
    db.add_all([dose, future]); db.commit(); dose_id, future_id = dose.id, future.id; db.close()
    asyncio.run(scheduler_tick(app))
    db = app.state.db.SessionLocal()
    command = db.scalar(select(m.ReminderCommand).where(m.ReminderCommand.dose_instance_id == dose_id))
    assert command is not None and command.delivery_state == "queued"
    assert db.scalar(select(m.ReminderCommand).where(m.ReminderCommand.dose_instance_id == future_id)) is None
    assert db.get(m.DoseInstance, dose_id).report_state == "unconfirmed"
    assert db.get(m.DeviceEvent, command.event_id).event_type == "reminder.play"
    db.close()


def test_turn_processing_claim_is_atomic_and_raw_audio_clears_after_asr(env, monkeypatch):
    client, app, ids = env
    calls = {"transcribe": 0}

    class FakeProvider:
        async def transcribe_audio(self, wav):
            calls["transcribe"] += 1
            await asyncio.sleep(0.02)
            return "hello"

        async def interpret_turn(self, transcript, context):
            return {"intent": "chat", "kind": None, "payload": {}, "spoken_text": "Hello."}

        async def synthesise_speech(self, text):
            return wav_bytes()

    monkeypatch.setattr("app.worker._provider", lambda application: FakeProvider())
    audio = wav_bytes()
    db = app.state.db.SessionLocal()
    turn = m.VoiceTurn(device_id=ids["device"], patient_id=ids["patient"], idempotency_key=str(uuid4()), content_sha256=sha_bytes(audio), raw_audio=audio)
    db.add(turn); db.commit(); turn_id = turn.id; db.close()

    async def race():
        await asyncio.gather(process_turn(app, turn_id), process_turn(app, turn_id))

    asyncio.run(race())
    db = app.state.db.SessionLocal()
    stored = db.get(m.VoiceTurn, turn_id)
    assert calls["transcribe"] == 1
    assert stored.status == "completed"
    assert stored.raw_audio is None
    assert stored.transcript == "hello"
    db.close()


def test_long_grounded_explanation_is_split_without_omission(env, monkeypatch):
    client, app, ids = env
    spoken_chunks = []

    class FakeProvider:
        async def transcribe_audio(self, wav):
            return "Explain DemoMed"

        async def interpret_turn(self, transcript, context):
            return {"intent": "explain", "kind": None, "payload": {"medicine_id": "med"}, "spoken_text": "ignored"}

        async def synthesise_speech(self, text):
            assert len(text) <= 160
            spoken_chunks.append(text)
            return wav_bytes(0.4)

    monkeypatch.setattr("app.worker._provider", lambda application: FakeProvider())
    instructions = " ".join(["Follow the checked fictional instruction."] * 12)
    reference = " ".join(["This is reviewed fictional reference text."] * 18)
    db = app.state.db.SessionLocal()
    plan = m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone="Asia/Singapore", source="Fictional source", checked_by_user_id=ids["owner"], checked_by_name="Owner", active=True, medicines=[{"id": "med", "name": "DemoMed", "instructions": instructions, "reviewed_reference": reference, "reference_source": "Fictional label"}], schedule=[])
    audio = wav_bytes()
    turn = m.VoiceTurn(device_id=ids["device"], patient_id=ids["patient"], idempotency_key=str(uuid4()), content_sha256=sha_bytes(audio), raw_audio=audio)
    db.add_all([plan, turn]); db.commit(); turn_id = turn.id; db.close()
    asyncio.run(process_turn(app, turn_id))
    db = app.state.db.SessionLocal(); stored = db.get(m.VoiceTurn, turn_id)
    assert stored.status == "completed"
    assert 1 < len(stored.result["audio_paths"]) <= 20
    assert stored.result["audio_path"] == stored.result["audio_paths"][0]
    assert " ".join(spoken_chunks) == " ".join(stored.result["spoken_text"].split())
    assert len(db.scalars(select(m.AudioAsset).where(m.AudioAsset.device_id == ids["device"])).all()) == len(spoken_chunks)
    db.close()
