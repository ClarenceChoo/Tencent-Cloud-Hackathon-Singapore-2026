"""One explicit reminder target and immutable per-target delivery history."""
from fastapi import HTTPException
from sqlalchemy import select, update

from . import models as m
from .security import aware, iso, utcnow

PENDING = {'preparing', 'queued', 'received'}
PLAYABLE = {'queued', 'received', 'playback_started'}


def lock_patient(db, patient_id):
    # A no-op UPDATE is a row lock on PostgreSQL and a write lock on SQLite.
    # Every route change, enqueue, asset fetch and playback ACK takes this lock.
    # No provider/network await may occur while this lock is held.
    result = db.execute(update(m.Patient).where(m.Patient.id == patient_id)
                        .values(language=m.Patient.language).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        raise HTTPException(404, 'Patient not found')


def route(db, patient_id):
    return db.scalar(select(m.CompanionRoute).where(m.CompanionRoute.patient_id == patient_id)
                     .execution_options(populate_existing=True))


def route_view(db, patient_id):
    current = route(db, patient_id)
    return {'device_id': current.active_device_id if current else None,
            'generation': current.generation if current else 0,
            'changed_at': iso(current.changed_at) if current else None}


def target(db, patient_id):
    current = route(db, patient_id)
    device = db.get(m.Device, current.active_device_id, populate_existing=True) if current and current.active_device_id else None
    if not device or device.revoked_at or device.patient_id != patient_id:
        return current, None
    return current, device


def current_attempt(db, device, attempt, *, for_playback=True):
    db.refresh(attempt)
    allowed_states = PLAYABLE if for_playback else PLAYABLE | {"playback_completed", "interrupted", "playback_unknown"}
    current = route(db, device.patient_id)
    if (not current or device.revoked_at or current.active_device_id != device.id
            or current.generation != attempt.route_generation or attempt.device_id != device.id
            or aware(attempt.expires_at) <= utcnow() or attempt.delivery_state not in allowed_states):
        return False
    if isinstance(attempt, m.ReminderCommand):
        dose = db.get(m.DoseInstance, attempt.dose_instance_id, populate_existing=True)
        plan = db.get(m.MedicationPlanVersion, dose.plan_id, populate_existing=True) if dose else None
        return bool(not attempt.cancelled_at and dose and dose.patient_id == device.patient_id
                    and dose.report_state == 'unconfirmed' and plan and plan.active
                    and plan.version == attempt.plan_version)
    patient = db.get(m.Patient, device.patient_id, populate_existing=True)
    return bool(patient and patient.daily_check_in_enabled)


def cancel_route(db, patient_id, reason):
    for model in (m.ReminderCommand, m.CheckInDelivery):
        attempts = db.scalars(select(model).join(m.ReminderOccurrence, model.occurrence_id == m.ReminderOccurrence.id)
                              .where(m.ReminderOccurrence.patient_id == patient_id,
                                     model.delivery_state.in_(PENDING | {'playback_started'}))
                              .execution_options(populate_existing=True)).all()
        for item in attempts:
            item.delivery_state = 'playback_unknown' if item.delivery_state == 'playback_started' else 'cancelled'
            item.cancel_reason = reason
            if isinstance(item, m.ReminderCommand):
                item.cancelled_at = utcnow()


def choose_target(db, patient_id, device_id, expected_generation, powered_off, actor_id):
    lock_patient(db, patient_id)
    current = route(db, patient_id)
    generation = current.generation if current else 0
    if expected_generation != generation:
        raise HTTPException(409, 'Companion selection changed. Refresh and choose again.')
    old = db.get(m.Device, current.active_device_id, populate_existing=True) if current and current.active_device_id else None
    selected = db.get(m.Device, device_id, populate_existing=True) if device_id else None
    if device_id and (not selected or selected.revoked_at or selected.patient_id != patient_id):
        raise HTTPException(422, 'Choose an available companion in this care space')
    if current and current.active_device_id == device_id:
        return route_view(db, patient_id)
    if old and old.device_type == 'phone':
        raise HTTPException(409, 'Open Parse on the currently selected phone and choose Pause reminders before switching. This stops speech and clears its local alerts.')
    other_pendants = db.scalar(select(m.Device.id).where(m.Device.patient_id == patient_id,
                               m.Device.device_type == 'pendant', m.Device.id != (device_id or '')))
    if (old and old.device_type == 'pendant' or (not current or not current.active_device_id) and other_pendants) and not powered_off:
        raise HTTPException(409, 'Power off the previous/other cardholders and confirm this before switching. Downloaded speech cannot be stopped remotely.')
    cancel_route(db, patient_id, 'route_changed')
    if not current:
        current = m.CompanionRoute(patient_id=patient_id, active_device_id=device_id, generation=1, changed_at=utcnow())
        db.add(current)
    else:
        current.active_device_id = device_id
        current.generation += 1
        current.changed_at = utcnow()
    db.add(m.AuditEvent(actor_type='user', actor_id=actor_id, patient_id=patient_id,
        action='companion.selected', object_type='device', object_id=device_id,
        details={'previous_device_id': old.id if old else None, 'generation': generation + 1,
                 'other_pendants_powered_off': powered_off}))
    db.flush()
    return route_view(db, patient_id)


def pause_phone(db, device):
    lock_patient(db, device.patient_id)
    current = route(db, device.patient_id)
    if current and current.active_device_id == device.id:
        cancel_route(db, device.patient_id, 'route_changed')
        current.active_device_id = None
        current.generation += 1
        current.changed_at = utcnow()
        db.add(m.AuditEvent(actor_type='device', actor_id=device.id, patient_id=device.patient_id,
            action='phone.quiesced', object_type='device', object_id=device.id,
            details={'generation': current.generation, 'playback_stopped': True, 'local_alerts_cleared': True}))
    db.flush()


def may_deliver(db, occurrence, generation):
    model = m.ReminderCommand if occurrence.kind == 'medication' else m.CheckInDelivery
    attempts = db.scalars(select(model).where(model.occurrence_id == occurrence.id)
                          .execution_options(populate_existing=True)).all()
    # A download means speech could have played even when its ACK was lost.
    # Keep that uncertainty; do not silently announce the occurrence again.
    if any(a.audio_accessed_at or a.delivery_state not in {'cancelled'} or a.cancel_reason != 'route_changed'
           for a in attempts):
        return False
    return not any(a.route_generation == generation for a in attempts)


def expire_attempts(db, now):
    for model in (m.ReminderCommand, m.CheckInDelivery):
        db.execute(update(model).where(model.expires_at <= now, model.delivery_state.in_(PENDING))
                   .values(delivery_state='expired').execution_options(synchronize_session=False))


def envelope(attempt):
    medication = isinstance(attempt, m.ReminderCommand)
    assets = [attempt.audio_asset_id] if medication else attempt.audio_asset_ids
    paths = ['/v1/device/audio/' + asset for asset in assets]
    payload = {'command_id': attempt.id, 'context_id': attempt.context_id, 'audio_path': paths[0],
               'audio_paths': paths, 'occurrence_id': attempt.occurrence_id,
               'route_generation': attempt.route_generation}
    if medication:
        payload.update(dose_instance_id=attempt.dose_instance_id, plan_version=attempt.plan_version)
    else:
        payload['greeting_text'] = attempt.greeting_text
    return {'protocol_version': 1, 'event_id': attempt.event_id,
            'type': 'reminder.play' if medication else 'checkin.play', 'device_id': attempt.device_id,
            'server_time': iso(utcnow()), 'expires_at': iso(attempt.expires_at), 'payload': payload}
