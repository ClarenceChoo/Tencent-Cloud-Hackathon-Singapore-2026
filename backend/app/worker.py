import asyncio
from datetime import timedelta
from typing import Optional

from pydantic import BaseModel, ConfigDict
from fastapi import HTTPException
from sqlalchemy import select, update

from . import models as m
from .providers import SpeechTooLong, SpeechVocabulary
from .vocabulary_service import read_vocabulary, read_vocabulary_version
from .security import aware, iso, utcnow
from .care_status import status_reply
from .services import (
    UPDATABLE_REPORT_STATES,
    build_readback,
    commit_proposal,
    create_proposal,
    explicit_confirmation,
    materialize_plan_doses,
    proposal_dict,
    sha_bytes,
    validate_wav,
    validate_payload,
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
        try:
            wav = await provider.synthesise_speech(piece)
        except SpeechTooLong:
            if len(piece) <= 1:
                raise
            pending = _split_in_half(piece) + pending
            continue
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
    doses = db.scalars(select(m.DoseInstance).join(m.MedicationPlanVersion, m.MedicationPlanVersion.id == m.DoseInstance.plan_id).where(m.DoseInstance.patient_id == device.patient_id, m.MedicationPlanVersion.active.is_(True), m.DoseInstance.report_state.in_(UPDATABLE_REPORT_STATES)).order_by(m.DoseInstance.scheduled_at).limit(12)).all()
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
    supports = db.scalars(select(m.SupportRequest).where(m.SupportRequest.patient_id == device.patient_id).order_by(m.SupportRequest.created_at.desc()).limit(30)).all()
    followups = db.scalars(select(m.FollowUp).where(m.FollowUp.patient_id == device.patient_id).order_by(m.FollowUp.check_at.desc()).limit(30)).all()
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
        "support_requests": [{"id": item.id, "request_text": item.request_text, "status": item.status, "acknowledged_at": iso(item.acknowledged_at), "resolved_at": iso(item.resolved_at), "outcome": item.outcome} for item in supports],
        "followups": [{"id": item.id, "related_type": item.related_type, "related_id": item.related_id, "resolution_state": item.resolution_state, "reported_outcome": item.reported_outcome} for item in followups],
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
    def require_active_device():
        if not device:
            raise ValueError("Device unavailable")
        db.refresh(device)
        if device.revoked_at or device.patient_id != turn.patient_id:
            raise ValueError("Device access changed")
    try:
        require_active_device()
        provider = _provider(app)
        if turn.status == "accepted":
            vocabulary = (read_vocabulary_version(db, turn.patient_id, turn.vocabulary_version)
                          if turn.vocabulary_version is not None else read_vocabulary(db, turn.patient_id))
            claimed = db.execute(update(m.VoiceTurn).where(m.VoiceTurn.id == turn_id, m.VoiceTurn.status == "accepted").values(
                status="transcribing", processing_started_at=utcnow(), vocabulary_version=vocabulary.version))
            if claimed.rowcount != 1:
                db.rollback()
                return
            db.commit()
            turn = db.get(m.VoiceTurn, turn_id)
            if not turn.raw_audio:
                raise ValueError("Accepted turn has no audio")
            transcript = await provider.transcribe_audio(bytes(turn.raw_audio), vocabulary=SpeechVocabulary(
                version=vocabulary.version, terms=[term.canonical for term in vocabulary.terms]))
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
        vocabulary = (read_vocabulary_version(db, turn.patient_id, turn.vocabulary_version)
                      if turn.vocabulary_version is not None else read_vocabulary(db, turn.patient_id))
        if turn.vocabulary_version is None:
            turn.vocabulary_version = vocabulary.version
            db.commit()
        context = _context(db, device, turn.context_id)
        # A purpose is advisory context for interpreting the spoken audio. The
        # explicit conversation context remains authoritative for corrections.
        context["capture_intent"] = turn.capture_intent
        context["reviewed_vocabulary"] = {"version": vocabulary.version, "terms": [
            {"canonical": term.canonical, "aliases": term.aliases, "category": term.category}
            for term in vocabulary.terms]}
        db.commit()
        raw = await provider.interpret_turn(turn.transcript, context)
        require_active_device()
        interpretation = Interpretation.model_validate(raw)
        if interpretation.intent not in {"proposal", "confirm", "correct", "clarify", "explain", "support_status", "followup_status", "chat"}:
            raise ValueError("Provider returned an unsupported intent")

        proposal = None
        record_type = None
        record_id = None
        status = "completed"
        spoken = interpretation.spoken_text.strip() or "Please try that again."
        current = context.get("current_proposal")
        action = None
        status_guard = None
        kind = interpretation.kind
        if interpretation.intent == "proposal" or (interpretation.intent == "correct" and current):
            if current:
                kind = current["kind"]
            if not kind:
                raise ValueError("Proposal intent omitted a kind")
            clean, _ = validate_payload(db, turn.patient_id, kind, interpretation.payload)
            spoken = build_readback(kind, clean)
            status = "awaiting_confirmation"
            action = "proposal"
        elif interpretation.intent == "correct":
            status = "clarification_required"
            spoken = "I do not have a current item to correct. Please state the full item again."
        elif interpretation.intent == "confirm":
            if not current or not explicit_confirmation(turn.transcript):
                status = "clarification_required"
                spoken = "Please clearly confirm the current read-back, or state the correction."
            else:
                spoken, action = "Saved.", "confirm"
        elif interpretation.intent == "explain":
            spoken = _grounded_explanation(context, interpretation)
        elif interpretation.intent in {"support_status", "followup_status"}:
            spoken, status_guard = status_reply(db, turn.patient_id, interpretation.intent, interpretation.payload.get("record_id"))
            if not status_guard:
                status = "clarification_required"
        elif interpretation.intent == "clarify":
            status = "clarification_required"

        # Prepare audio without persisting a proposal/record or holding write locks.
        # Revalidate and commit care effects, assets and the result atomically below.
        db.commit()
        clips = await _synthesise_sequence(provider, spoken)
        from .routing import current_attempt, lock_patient
        lock_patient(db, turn.patient_id)
        require_active_device()
        try:
            if turn.context_id:
                for model in (m.ReminderCommand, m.CheckInDelivery):
                    reminder = db.scalar(select(model).where(model.device_id == device.id, model.context_id == turn.context_id))
                    if reminder and not current_attempt(db, device, reminder, for_playback=False):
                        raise HTTPException(409, "The reminder changed. Please identify the item again.")
            if action == "proposal":
                previous = db.get(m.ConfirmationProposal, current["id"], populate_existing=True) if interpretation.intent == "correct" else None
                proposal = create_proposal(db, turn.patient_id, kind, interpretation.payload,
                                           source_turn_id=turn.id, replaces=previous)
                if proposal.readback != spoken:
                    raise HTTPException(409, "The care details changed. Please state the item again.")
            elif action == "confirm":
                committed = commit_proposal(db, current["id"], patient_id=turn.patient_id)
                status = "committed"
                record_type, record_id = committed.record_type, committed.record_id
            elif interpretation.intent == "explain":
                fresh_context = _context(db, device, turn.context_id)
                if _grounded_explanation(fresh_context, interpretation) != spoken:
                    raise HTTPException(409, "The medication plan changed. Please ask for the explanation again.")
            elif interpretation.intent in {"support_status", "followup_status"}:
                fresh_spoken, fresh_guard = status_reply(db, turn.patient_id, interpretation.intent, interpretation.payload.get("record_id"))
                if (fresh_spoken, fresh_guard) != (spoken, status_guard):
                    raise HTTPException(409, "The recorded status changed. Please ask again for the current update.")
        except HTTPException as exc:
            db.rollback()
            proposal, record_type, record_id = None, None, None
            status, spoken = "clarification_required", str(exc.detail)
            clips = await _synthesise_sequence(provider, spoken)
            lock_patient(db, turn.patient_id)
            require_active_device()
        guard = None
        if status_guard and status == "completed":
            guard = {"status_record": status_guard}
        elif proposal:
            guard = {"proposal_id":proposal.id,"status":"pending"}
        elif status=="committed" and current:
            guard = {"proposal_id":current["id"],"status":"committed"}
        elif status=="completed" and interpretation.intent=="explain" and context.get("active_medication_plan"):
            guard = {"plan_id":context["active_medication_plan"]["id"]}
        audio_paths = []
        for wav, duration_ms in clips:
            asset = m.AudioAsset(device_id=device.id, context_guard=guard, wav_bytes=wav, content_sha256=sha_bytes(wav), duration_ms=duration_ms, expires_at=utcnow() + timedelta(minutes=5))
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
            "vocabulary": {"version": vocabulary.version, "asr_applied": False},
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


def command_envelope(command):
    from .routing import envelope
    return envelope(command)


def checkin_envelope(checkin):
    from .routing import envelope
    return envelope(checkin)


async def scheduler_tick(app) -> None:
    db = app.state.db.SessionLocal()
    now = utcnow()
    try:
        from .routing import expire_attempts
        expire_attempts(db, now)
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

        from .reminders import schedule_reminders
        await schedule_reminders(app, now, lambda: _provider(app), _synthesise_sequence)
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
