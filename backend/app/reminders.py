"""Reminder preparation releases database locks during speech generation."""
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from . import models as m
from .routing import envelope, lock_patient, may_deliver, target
from .security import aware, utcnow
from .services import sha_bytes, validate_wav


async def schedule_reminders(app, now, provider_factory, synthesise_sequence):
    with app.state.db.SessionLocal() as db:
        due_doses = db.scalars(select(m.DoseInstance).join(m.MedicationPlanVersion, m.DoseInstance.plan_id == m.MedicationPlanVersion.id)
            .where(m.MedicationPlanVersion.active.is_(True), m.DoseInstance.report_state == 'unconfirmed',
                   m.DoseInstance.scheduled_at <= now, m.DoseInstance.scheduled_at > now - timedelta(minutes=2))).all()
        occurrence_ids = []
        for dose in due_doses:
            lock_patient(db, dose.patient_id)
            occurrence = db.scalar(select(m.ReminderOccurrence).where(m.ReminderOccurrence.dose_instance_id == dose.id))
            if not occurrence:
                occurrence = m.ReminderOccurrence(patient_id=dose.patient_id, kind='medication', dose_instance_id=dose.id,
                    expires_at=aware(dose.scheduled_at) + timedelta(minutes=2))
                db.add(occurrence); db.flush()
            occurrence_ids.append(occurrence.id)
            db.commit()
        patients = db.scalars(select(m.Patient).where(m.Patient.daily_check_in_enabled.is_(True), m.Patient.daily_check_in_local_time.is_not(None))).all()
        for patient in patients:
            try:
                tz = ZoneInfo(patient.timezone)
                local_date = now.astimezone(tz).date()
                hour, minute = map(int, patient.daily_check_in_local_time.split(':'))
                due_at = datetime.combine(local_date, time(hour, minute), tzinfo=tz).astimezone(timezone.utc)
            except (ZoneInfoNotFoundError, ValueError):
                continue
            if not due_at <= now < due_at + timedelta(minutes=30):
                continue
            lock_patient(db, patient.id)
            occurrence = db.scalar(select(m.ReminderOccurrence).where(m.ReminderOccurrence.patient_id == patient.id,
                m.ReminderOccurrence.kind == 'checkin', m.ReminderOccurrence.local_date == local_date))
            if not occurrence:
                occurrence = m.ReminderOccurrence(patient_id=patient.id, kind='checkin', local_date=local_date,
                    expires_at=due_at + timedelta(minutes=30))
                db.add(occurrence); db.flush()
            occurrence_ids.append(occurrence.id)
            db.commit()
    for occurrence_id in occurrence_ids:
        await deliver(app, occurrence_id, provider_factory, synthesise_sequence)


async def deliver(app, occurrence_id, provider_factory, synthesise_sequence):
    with app.state.db.SessionLocal() as db:
        occurrence = db.get(m.ReminderOccurrence, occurrence_id)
        current, device = target(db, occurrence.patient_id)
        if not device or aware(occurrence.expires_at) <= utcnow() or not may_deliver(db, occurrence, current.generation):
            return
        generation, device_id, patient_id = current.generation, device.id, device.patient_id
        if occurrence.kind == 'medication':
            dose = db.get(m.DoseInstance, occurrence.dose_instance_id)
            spoken = 'Reminder for %s scheduled now. Playback does not record whether it was taken. Please report your status separately.' % dose.medicine_name
        else:
            patient = db.get(m.Patient, patient_id)
            spoken = 'Hello %s. This is your daily check-in. How are you today?' % (patient.preferred_name or patient.name)
        db.commit()  # no locks held across provider calls
        try:
            if occurrence.kind == 'medication':
                wav = await provider_factory().synthesise_speech(spoken)
                clips = [(wav, validate_wav(wav))]
            else:
                clips = await synthesise_sequence(provider_factory(), spoken)
        except Exception:
            db.add(m.AuditEvent(actor_type='system', patient_id=patient_id, action='reminder.audio_failed',
                object_type='reminder_occurrence', object_id=occurrence_id, details={'retryable': True}))
            db.commit()
            return
        lock_patient(db, patient_id)
        current, device = target(db, patient_id)
        db.refresh(occurrence)
        if (not device or device.id != device_id or current.generation != generation
                or aware(occurrence.expires_at) <= utcnow() or not may_deliver(db, occurrence, generation)):
            db.rollback()
            return
        if occurrence.kind == 'medication':
            dose = db.get(m.DoseInstance, occurrence.dose_instance_id, populate_existing=True)
            plan = db.get(m.MedicationPlanVersion, dose.plan_id, populate_existing=True)
            if not plan.active or dose.report_state != 'unconfirmed':
                db.rollback(); return
        else:
            patient = db.get(m.Patient, patient_id, populate_existing=True)
            if not patient.daily_check_in_enabled:
                db.rollback(); return
        asset_ids = []
        for wav, duration in clips:
            asset = m.AudioAsset(device_id=device_id, wav_bytes=wav, content_sha256=sha_bytes(wav), duration_ms=duration, expires_at=occurrence.expires_at)
            db.add(asset); db.flush(); asset_ids.append(asset.id)
        common = {'device_id': device_id, 'occurrence_id': occurrence.id, 'route_generation': generation,
                  'expires_at': occurrence.expires_at, 'delivery_state': 'queued'}
        if occurrence.kind == 'medication':
            attempt = m.ReminderCommand(**common, dose_instance_id=dose.id, plan_version=dose.plan_version, audio_asset_id=asset_ids[0])
        else:
            attempt = m.CheckInDelivery(**common, patient_id=patient_id, local_date=occurrence.local_date,
                greeting_text=spoken, audio_asset_ids=asset_ids, due_at=aware(occurrence.expires_at) - timedelta(minutes=30))
        db.add(attempt)
        try:
            db.flush()
            event = envelope(attempt)
            db.add(m.DeviceEvent(id=attempt.event_id, device_id=device_id, event_type=event['type'], payload=event['payload'], expires_at=attempt.expires_at))
            db.commit()
        except IntegrityError:
            # The route lock serializes normal writers; keep uniqueness as the last guard.
            db.rollback()
