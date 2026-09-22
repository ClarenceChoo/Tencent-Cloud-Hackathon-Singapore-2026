import asyncio
from datetime import datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, ValidationError
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from . import models as m
from .security import aware, iso, utcnow
from .services import (
    build_readback,
    commit_proposal,
    create_proposal,
    explicit_confirmation,
    materialize_plan_doses,
    proposal_dict,
    sha_bytes,
    validate_wav,
)


class Interpretation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    intent: str
    kind: Optional[str] = None
    payload: dict = {}
    spoken_text: str = ""


def _split_text(text: str, limit: int = 160) -> list[str]:
    remaining = " ".join(text.split())
    parts = []
    while remaining:
        if len(remaining) <= limit:
            parts.append(remaining)
            break
        cut = remaining.rfind(" ", 0, limit + 1)
        if cut < 1:
            cut = limit
        parts.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    return parts


def _split_in_half(text: str) -> list[str]:
    words = text.split()
    if len(words) > 1:
        middle = len(words) // 2
        return [" ".join(words[:middle]), " ".join(words[middle:])]
    middle = max(1, len(text) // 2)
    return [text[:middle], text[middle:]]


async def _synthesise_sequence(provider, text: str) -> list[tuple[bytes, int]]:
    pending = _split_text(text)
    if not pending:
        raise ValueError("Spoken response is empty")
    completed = []
    total_ms = 0
    while pending:
        if len(completed) + len(pending) > 20:
            raise ValueError("Spoken response exceeds the 20-asset playback limit")
        piece = pending.pop(0)
        wav = await provider.synthesise_speech(piece)
        try:
            duration_ms = validate_wav(wav)
        except ValueError as exc:
            if "duration" in str(exc).lower() or "20 seconds" in str(exc).lower():
                if len(piece) <= 1:
                    raise
                pending = _split_in_half(piece) + pending
                continue
            raise
        total_ms += duration_ms
        if total_ms > 120000:
            raise ValueError("Spoken response exceeds the 120-second playback limit")
        completed.append((wav, duration_ms))
    return completed


def _provider(app):
    from .providers import get_provider

    return get_provider(fixture_transcripts=getattr(app.state, "fixture_transcripts", None))


def _context(db, device: m.Device, context_id: Optional[str]) -> dict:
    current = None
    reminder = None
    if context_id:
        proposal = db.scalar(select(m.ConfirmationProposal).where(m.ConfirmationProposal.context_id == context_id))
        if proposal and proposal.patient_id == device.patient_id:
            current = proposal_dict(proposal)
        else:
            command = db.scalar(select(m.ReminderCommand).where(m.ReminderCommand.context_id == context_id, m.ReminderCommand.device_id == device.id))
            if command:
                dose = db.get(m.DoseInstance, command.dose_instance_id)
                reminder = {"command_id": command.id, "dose_instance_id": dose.id, "medicine_id": dose.medicine_id, "medicine_name": dose.medicine_name, "scheduled_at": iso(dose.scheduled_at), "plan_version": dose.plan_version, "report_state": dose.report_state}
            else:
                checkin = db.scalar(select(m.CheckInDelivery).where(m.CheckInDelivery.context_id == context_id, m.CheckInDelivery.device_id == device.id))
                if checkin:
                    reminder = {"check_in_id": checkin.id, "local_date": iso(checkin.local_date), "type": "daily_check_in"}
    plan = db.scalar(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.patient_id == device.patient_id, m.MedicationPlanVersion.active.is_(True)))
    doses = db.scalars(select(m.DoseInstance).where(m.DoseInstance.patient_id == device.patient_id, m.DoseInstance.report_state == "unconfirmed").order_by(m.DoseInstance.scheduled_at).limit(12)).all()
    recipient_rows = db.execute(
        select(m.User.id, m.User.name)
        .join(m.AccessGrant, m.AccessGrant.user_id == m.User.id)
        .where(m.AccessGrant.patient_id == device.patient_id, m.AccessGrant.revoked_at.is_(None))
    ).all()
    recipients = []
    for row in recipient_rows:
        grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == device.patient_id, m.AccessGrant.user_id == row.id))
        if grant and (not grant.expires_at or aware(grant.expires_at) > utcnow()):
            recipients.append(row)
    tasks = db.scalars(select(m.PreventiveTask).where(m.PreventiveTask.patient_id == device.patient_id)).all()
    supports = db.scalars(select(m.SupportRequest).where(m.SupportRequest.patient_id == device.patient_id, m.SupportRequest.status != "resolved")).all()
    followups = db.scalars(select(m.FollowUp).where(m.FollowUp.patient_id == device.patient_id, m.FollowUp.resolution_state == "open")).all()
    patient = db.get(m.Patient, device.patient_id)
    return {
        "device": {"id": device.id, "preferred_name": patient.preferred_name or patient.name, "language": patient.language, "timezone": patient.timezone, "calling_route": patient.calling_route, "calling_route_message": patient.calling_route or "No calling route is configured. Use your usual local support or emergency contact method."},
        "server_time": iso(utcnow()),
        "current_proposal": current,
        "reminder_context": reminder,
        "active_medication_plan": ({"id": plan.id, "version": plan.version, "medicines": plan.medicines, "schedule": plan.schedule} if plan else None),
        "doses": [{"id": dose.id, "medicine_id": dose.medicine_id, "medicine_name": dose.medicine_name, "scheduled_at": iso(dose.scheduled_at), "report_state": dose.report_state} for dose in doses],
        "permitted_recipients": [{"id": row.id, "name": row.name} for row in recipients],
        "preventive_tasks": [{"id": task.id, "description": task.description, "state": task.state, "due_date": iso(task.due_date)} for task in tasks],
        "support_requests": [{"id": item.id, "request_text": item.request_text, "status": item.status} for item in supports],
        "followups": [{"id": item.id, "related_type": item.related_type, "related_id": item.related_id, "resolution_state": item.resolution_state} for item in followups],
    }


def _grounded_explanation(context: dict, interpreted: Interpretation) -> str:
    plan = context.get("active_medication_plan")
    requested = str(interpreted.payload.get("medicine_id") or interpreted.payload.get("medicine_name") or "").strip().lower()
    if not plan or not requested:
        return "I could not identify a medicine in the checked plan. Please ask the pharmacist or clinician."
    matches = [item for item in plan["medicines"] if requested in {str(item.get("id", "")).lower(), str(item.get("name", "")).lower()}]
    if len(matches) != 1:
        return "I could not identify one medicine in the checked plan. Please say its name, or ask the pharmacist or clinician."
    med = matches[0]
    return "%s. The checked instruction says: %s. Reviewed information: %s. Source: %s. I cannot change the dose or advise what to do about a missed dose." % (
        med["name"], med["instructions"], med["reviewed_reference"], med["reference_source"]
    )


async def process_turn(app, turn_id: str) -> None:
    db = app.state.db.SessionLocal()
    turn = db.get(m.VoiceTurn, turn_id)
    if not turn or turn.status not in {"accepted", "transcribed"}:
        db.close()
        return
    device = db.get(m.Device, turn.device_id)
    try:
        provider = _provider(app)
        if turn.status == "accepted":
            claimed = db.execute(update(m.VoiceTurn).where(m.VoiceTurn.id == turn_id, m.VoiceTurn.status == "accepted").values(status="transcribing", processing_started_at=utcnow()))
            if claimed.rowcount != 1:
                db.rollback()
                return
            db.commit()
            turn = db.get(m.VoiceTurn, turn_id)
            if not turn.raw_audio:
                raise ValueError("Accepted turn has no audio")
            transcript = await provider.transcribe_audio(bytes(turn.raw_audio))
            if not isinstance(transcript, str) or not transcript.strip():
                raise ValueError("Transcription was empty")
            turn.transcript = transcript[:10000]
            turn.raw_audio = None
            turn.status = "transcribed"
            turn.processing_started_at = None
            db.commit()
        claimed = db.execute(update(m.VoiceTurn).where(m.VoiceTurn.id == turn_id, m.VoiceTurn.status == "transcribed").values(status="processing", processing_started_at=utcnow()))
        if claimed.rowcount != 1:
            db.rollback()
            return
        db.commit()
        turn = db.get(m.VoiceTurn, turn_id)
        context = _context(db, device, turn.context_id)
        raw = await provider.interpret_turn(turn.transcript, context)
        interpretation = Interpretation.model_validate(raw)
        if interpretation.intent not in {"proposal", "confirm", "correct", "clarify", "explain", "chat"}:
            raise ValueError("Provider returned an unsupported intent")

        proposal = None
        record_type = None
        record_id = None
        status = "completed"
        spoken = interpretation.spoken_text.strip() or "Please try that again."
        current = context.get("current_proposal")
        if interpretation.intent == "proposal":
            if not interpretation.kind:
                raise ValueError("Proposal intent omitted a kind")
            proposal = create_proposal(db, turn.patient_id, interpretation.kind, interpretation.payload, source_turn_id=turn.id)
            status = "awaiting_confirmation"
            spoken = proposal.readback
        elif interpretation.intent == "correct":
            if not current:
                status = "clarification_required"
                spoken = "I do not have a current item to correct. Please state the full item again."
            else:
                previous = db.get(m.ConfirmationProposal, current["id"])
                proposal = create_proposal(db, turn.patient_id, previous.kind, interpretation.payload, source_turn_id=turn.id, replaces=previous)
                status = "awaiting_confirmation"
                spoken = proposal.readback
        elif interpretation.intent == "confirm":
            if not current or not explicit_confirmation(turn.transcript):
                status = "clarification_required"
                spoken = "Please clearly confirm the current read-back, or state the correction."
            else:
                try:
                    committed = commit_proposal(db, current["id"], patient_id=turn.patient_id)
                    status = "committed"
                    record_type, record_id = committed.record_type, committed.record_id
                    spoken = "Saved."
                except HTTPException as exc:
                    status = "clarification_required"
                    spoken = str(exc.detail)
        elif interpretation.intent == "explain":
            spoken = _grounded_explanation(context, interpretation)
        elif interpretation.intent == "clarify":
            status = "clarification_required"
            spoken = spoken or "Please tell me one item at a time."
        elif interpretation.intent == "chat":
            status = "completed"

        clips = await _synthesise_sequence(provider, spoken)
        audio_paths = []
        for wav, duration_ms in clips:
            asset = m.AudioAsset(device_id=device.id, wav_bytes=wav, content_sha256=sha_bytes(wav), duration_ms=duration_ms, expires_at=utcnow() + timedelta(minutes=5))
            db.add(asset)
            db.flush()
            audio_paths.append("/v1/device/audio/%s" % asset.id)
        payload = {
            "turn_id": turn.id,
            "context_id": proposal.context_id if proposal else (current["context_id"] if current and status == "clarification_required" else None),
            "status": status,
            "spoken_text": spoken,
            "audio_path": audio_paths[0],
            "audio_paths": audio_paths,
            "record_type": record_type,
            "record_id": record_id,
        }
        turn.status = status
        turn.result = payload
        turn.raw_audio = None
        turn.processing_started_at = None
        event = m.DeviceEvent(device_id=device.id, event_type="turn.result", payload=payload, expires_at=utcnow() + timedelta(minutes=2))
        db.add(event)
        db.commit()
    except Exception as exc:
        db.rollback()
        turn = db.get(m.VoiceTurn, turn_id)
        if turn:
            turn.status = "failed"
            turn.processing_error = "Provider or processing service unavailable"
            turn.raw_audio = None
            turn.processing_started_at = None
            turn.result = {"turn_id": turn.id, "status": "failed", "retryable": True}
            db.add(m.DeviceEvent(device_id=turn.device_id, event_type="turn.result", payload=turn.result, expires_at=utcnow() + timedelta(minutes=2)))
            db.commit()
    finally:
        db.close()


def event_envelope(event: m.DeviceEvent, device_id: str) -> dict:
    return {"protocol_version": 1, "event_id": event.id, "type": event.event_type, "device_id": device_id, "server_time": iso(utcnow()), "expires_at": iso(event.expires_at), "payload": event.payload}


def command_envelope(command: m.ReminderCommand) -> dict:
    return {
        "protocol_version": 1,
        "event_id": command.event_id,
        "type": "reminder.play",
        "device_id": command.device_id,
        "server_time": iso(utcnow()),
        "expires_at": iso(command.expires_at),
        "payload": {"command_id": command.id, "dose_instance_id": command.dose_instance_id, "plan_version": command.plan_version, "context_id": command.context_id, "audio_path": "/v1/device/audio/%s" % command.audio_asset_id},
    }


def checkin_envelope(checkin: m.CheckInDelivery) -> dict:
    paths = ["/v1/device/audio/%s" % asset_id for asset_id in checkin.audio_asset_ids]
    return {
        "protocol_version": 1,
        "event_id": checkin.event_id,
        "type": "checkin.play",
        "device_id": checkin.device_id,
        "server_time": iso(utcnow()),
        "expires_at": iso(checkin.expires_at),
        "payload": {"command_id": checkin.id, "context_id": checkin.context_id, "greeting_text": checkin.greeting_text, "audio_path": paths[0], "audio_paths": paths},
    }


async def scheduler_tick(app) -> None:
    db = app.state.db.SessionLocal()
    now = utcnow()
    try:
        expired = db.scalars(select(m.ReminderCommand).where(m.ReminderCommand.expires_at < now, m.ReminderCommand.delivery_state.in_(["queued", "received"]))).all()
        for command in expired:
            command.delivery_state = "expired"
        expired_checkins = db.scalars(select(m.CheckInDelivery).where(m.CheckInDelivery.expires_at < now, m.CheckInDelivery.delivery_state.in_(["preparing", "queued", "received"]))).all()
        for checkin in expired_checkins:
            checkin.delivery_state = "expired"
        abandoned_before = now - timedelta(hours=app.state.settings.audio_retention_hours)
        for turn in db.scalars(select(m.VoiceTurn).where(m.VoiceTurn.raw_audio.is_not(None), m.VoiceTurn.received_at < abandoned_before)).all():
            turn.raw_audio = None
            turn.status = "failed"
            turn.processing_error = "Abandoned audio expired"
        db.commit()

        stale_before = now - timedelta(minutes=5)
        for stale in db.scalars(select(m.VoiceTurn).where(m.VoiceTurn.status.in_(["transcribing", "processing"]), m.VoiceTurn.processing_started_at < stale_before)).all():
            stale.status = "accepted" if stale.raw_audio else "transcribed"
            stale.processing_started_at = None
        db.commit()
        accepted_turn_ids = db.scalars(select(m.VoiceTurn.id).where(m.VoiceTurn.status.in_(["accepted", "transcribed"])).limit(20)).all()
        for turn_id in accepted_turn_ids:
            await process_turn(app, turn_id)

        active_plans = db.scalars(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.active.is_(True))).all()
        for plan in active_plans:
            materialize_plan_doses(db, plan, now=now)
        db.commit()

        checkin_patients = db.scalars(select(m.Patient).where(m.Patient.daily_check_in_enabled.is_(True), m.Patient.daily_check_in_local_time.is_not(None))).all()
        for patient in checkin_patients:
            try:
                tz = ZoneInfo(patient.timezone)
                hour, minute = [int(part) for part in patient.daily_check_in_local_time.split(":")]
            except (ZoneInfoNotFoundError, ValueError):
                continue
            local_now = now.astimezone(tz)
            due_at = datetime.combine(local_now.date(), time(hour, minute), tzinfo=tz).astimezone(timezone.utc)
            if now < due_at:
                continue
            existing_checkin = db.scalar(select(m.CheckInDelivery.id).where(m.CheckInDelivery.patient_id == patient.id, m.CheckInDelivery.local_date == local_now.date()))
            if existing_checkin:
                continue
            expires_at = due_at + timedelta(minutes=30)
            greeting = "Hello %s. This is your daily check-in. How are you today?" % (patient.preferred_name or patient.name)
            device = db.scalar(select(m.Device).where(m.Device.patient_id == patient.id, m.Device.revoked_at.is_(None)))
            checkin = m.CheckInDelivery(device_id=device.id if device else None, patient_id=patient.id, local_date=local_now.date(), greeting_text=greeting, delivery_state="preparing", due_at=due_at, expires_at=expires_at)
            db.add(checkin)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                continue
            if now >= expires_at or not device:
                checkin = db.get(m.CheckInDelivery, checkin.id)
                checkin.delivery_state = "expired" if now >= expires_at else "failed"
                db.commit()
                continue
            try:
                clips = await _synthesise_sequence(_provider(app), greeting)
            except Exception:
                checkin = db.get(m.CheckInDelivery, checkin.id)
                checkin.delivery_state = "failed"
                db.add(m.AuditEvent(actor_type="system", patient_id=patient.id, action="checkin.audio_failed", object_type="patient", object_id=patient.id, details={"retryable": True}))
                db.commit()
                continue
            asset_ids = []
            for wav, duration_ms in clips:
                asset = m.AudioAsset(device_id=device.id, wav_bytes=wav, content_sha256=sha_bytes(wav), duration_ms=duration_ms, expires_at=expires_at)
                db.add(asset); db.flush(); asset_ids.append(asset.id)
            checkin = db.get(m.CheckInDelivery, checkin.id)
            checkin.audio_asset_ids = asset_ids
            checkin.delivery_state = "queued"
            db.flush()
            envelope = checkin_envelope(checkin)
            db.add(m.DeviceEvent(id=checkin.event_id, device_id=device.id, event_type="checkin.play", payload=envelope["payload"], expires_at=expires_at))
            db.commit()

        due_doses = db.scalars(
            select(m.DoseInstance)
            .join(m.MedicationPlanVersion, m.DoseInstance.plan_id == m.MedicationPlanVersion.id)
            .where(m.MedicationPlanVersion.active.is_(True), m.DoseInstance.scheduled_at <= now, m.DoseInstance.scheduled_at >= now - timedelta(minutes=2))
        ).all()
        for dose in due_doses:
            exists = db.scalar(select(m.ReminderCommand.id).where(m.ReminderCommand.dose_instance_id == dose.id))
            if exists:
                continue
            device = db.scalar(select(m.Device).where(m.Device.patient_id == dose.patient_id, m.Device.revoked_at.is_(None)))
            if not device:
                continue
            provider = _provider(app)
            spoken = "Reminder for %s scheduled now. Playback does not record whether it was taken. Please report your status separately." % dose.medicine_name
            try:
                wav = await provider.synthesise_speech(spoken)
                duration_ms = validate_wav(wav)
            except Exception:
                db.add(m.AuditEvent(actor_type="system", patient_id=dose.patient_id, action="reminder.audio_failed", object_type="dose", object_id=dose.id, details={"retryable": True}))
                db.commit()
                continue
            expiry = now + timedelta(minutes=2)
            asset = m.AudioAsset(device_id=device.id, wav_bytes=wav, content_sha256=sha_bytes(wav), duration_ms=duration_ms, expires_at=expiry)
            db.add(asset)
            db.flush()
            command = m.ReminderCommand(device_id=device.id, dose_instance_id=dose.id, plan_version=dose.plan_version, audio_asset_id=asset.id, expires_at=expiry)
            db.add(command)
            db.flush()
            event = m.DeviceEvent(device_id=device.id, event_type="reminder.play", payload=command_envelope(command)["payload"], expires_at=expiry, id=command.event_id)
            db.add(event)
            db.commit()
    finally:
        db.close()


async def scheduler_loop(app) -> None:
    while True:
        try:
            await scheduler_tick(app)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(app.state.settings.scheduler_interval_seconds)
