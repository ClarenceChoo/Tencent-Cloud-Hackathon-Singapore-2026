"""Shared turn acceptance for pendant WAV and native phone audio."""
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from . import models as m
from .security import aware, iso, utcnow
from .worker import process_turn

def accept_turn(app, db, device, body, digest, idempotency_key, context_id, background):
    existing = db.scalar(select(m.VoiceTurn).where(m.VoiceTurn.device_id == device.id, m.VoiceTurn.idempotency_key == idempotency_key))
    if existing:
        if existing.content_sha256 != digest or existing.context_id != context_id:
            raise HTTPException(status_code=409, detail="Idempotency key was already used for different turn content")
        return {"turn_id": existing.id, "status": existing.status, "received_at": iso(existing.received_at)}
    if context_id:
        proposal = db.scalar(select(m.ConfirmationProposal).where(m.ConfirmationProposal.context_id == context_id, m.ConfirmationProposal.patient_id == device.patient_id))
        command = db.scalar(select(m.ReminderCommand).where(m.ReminderCommand.context_id == context_id, m.ReminderCommand.device_id == device.id))
        checkin = db.scalar(select(m.CheckInDelivery).where(m.CheckInDelivery.context_id == context_id, m.CheckInDelivery.device_id == device.id))
        if not proposal and not command and not checkin:
            raise HTTPException(status_code=400, detail="Conversation context is unknown")
        if proposal and device.device_type == "phone":
            source = db.get(m.VoiceTurn, proposal.source_turn_id) if proposal.source_turn_id else None
            if not source or source.device_id != device.id:
                raise HTTPException(status_code=404, detail="Phone proposal not found")
        if proposal and (proposal.status != "pending" or aware(proposal.expires_at) <= utcnow()):
            raise HTTPException(status_code=409, detail="Conversation context is no longer current")
        if command:
            active_plan = db.scalar(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.patient_id == device.patient_id, m.MedicationPlanVersion.active.is_(True)))
            if command.cancelled_at or aware(command.expires_at) <= utcnow() or not active_plan or command.plan_version != active_plan.version:
                raise HTTPException(status_code=409, detail="Reminder context is no longer current")
        if checkin and (checkin.delivery_state in {"expired", "failed", "cancelled"} or aware(checkin.expires_at) <= utcnow()):
            raise HTTPException(status_code=409, detail="Check-in context is no longer current")
    try:
        from .providers import UnconfiguredProvider, get_provider
        provider = get_provider(fixture_transcripts=getattr(app.state, "fixture_transcripts", None))
        if isinstance(provider, UnconfiguredProvider):
            raise RuntimeError("unconfigured")
    except Exception:
        raise HTTPException(status_code=503, detail="Speech provider is not configured or unavailable")
    turn = m.VoiceTurn(device_id=device.id, patient_id=device.patient_id, idempotency_key=idempotency_key, content_sha256=digest, context_id=context_id, raw_audio=body)
    db.add(turn)
    device.last_seen = utcnow()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(m.VoiceTurn).where(m.VoiceTurn.device_id == device.id, m.VoiceTurn.idempotency_key == idempotency_key))
        if not existing or existing.content_sha256 != digest or existing.context_id != context_id:
            raise HTTPException(status_code=409, detail="Idempotency key was already used for different turn content")
        return {"turn_id": existing.id, "status": existing.status, "received_at": iso(existing.received_at)}
    background.add_task(process_turn, app, turn.id)
    return {"turn_id": turn.id, "status": "accepted", "received_at": iso(turn.received_at)}
