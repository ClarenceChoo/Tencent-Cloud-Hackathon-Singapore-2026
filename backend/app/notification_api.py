"""Phone schedules contain generic alert identities; never lock-screen care text."""

from datetime import datetime, time, timedelta, timezone
import hashlib
import json
import re
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from . import models as m
from .phone import authenticate_phone, phone_db
from .routing import lock_patient, route_view
from .security import aware, iso, utcnow
from .services import materialize_plan_doses

router = APIRouter(prefix="/v1/phone", tags=["phone"])
GENERIC_TITLE = "Parse"
GENERIC_BODY = "Open Parse to check your care schedule."


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def state_for(db, device):
    state = db.get(m.PhoneState, device.id)
    if not state:
        state = m.PhoneState(device_id=device.id)
        db.add(state)
        db.flush()
    return state


def invalidate_notifications(db, device_id):
    state = db.get(m.PhoneState, device_id)
    if state:
        state.push_token = None
        state.push_version += 1
        state.push_disabled_at = utcnow()
        state.scheduled_until = None
        state.schedule_revision = None
        state.lifecycle = "unknown"
    db.execute(
        update(m.PushHint)
        .where(
            m.PushHint.device_id == device_id,
            m.PushHint.status.in_(["pending", "sending", "ticketed"]),
        )
        .values(status="cancelled")
    )


def checkin_due(patient, day):
    hour, minute = map(int, patient.daily_check_in_local_time.split(":"))
    return datetime.combine(
        day, time(hour, minute), tzinfo=ZoneInfo(patient.timezone)
    ).astimezone(timezone.utc)


def schedule_view(db, device, now=None):
    now = now or utcnow()
    horizon = now + timedelta(hours=24)
    selected = route_view(db, device.patient_id)
    patient = db.get(m.Patient, device.patient_id, populate_existing=True)
    plan = db.scalar(
        select(m.MedicationPlanVersion).where(
            m.MedicationPlanVersion.patient_id == patient.id,
            m.MedicationPlanVersion.active.is_(True),
        )
    )
    items = []
    if selected["device_id"] == device.id and not device.revoked_at:
        if plan:
            materialize_plan_doses(db, plan, now=now, days=3)
            db.flush()
            doses = db.scalars(
                select(m.DoseInstance)
                .where(
                    m.DoseInstance.plan_id == plan.id,
                    m.DoseInstance.report_state == "unconfirmed",
                    m.DoseInstance.scheduled_at > now,
                    m.DoseInstance.scheduled_at <= horizon,
                )
                .order_by(m.DoseInstance.scheduled_at)
                .limit(61)
            ).all()
            for dose in doses:
                occurrence = db.scalar(
                    select(m.ReminderOccurrence).where(
                        m.ReminderOccurrence.dose_instance_id == dose.id
                    )
                )
                if not occurrence:
                    occurrence = m.ReminderOccurrence(
                        patient_id=patient.id,
                        kind="medication",
                        dose_instance_id=dose.id,
                        expires_at=aware(dose.scheduled_at) + timedelta(minutes=2),
                    )
                    db.add(occurrence)
                    db.flush()
                items.append((occurrence, aware(dose.scheduled_at)))
        if patient.daily_check_in_enabled and patient.daily_check_in_local_time:
            day = now.astimezone(ZoneInfo(patient.timezone)).date()
            for offset in range(2):
                local_date = day + timedelta(days=offset)
                due = checkin_due(patient, local_date)
                if not now < due <= horizon:
                    continue
                occurrence = db.scalar(
                    select(m.ReminderOccurrence).where(
                        m.ReminderOccurrence.patient_id == patient.id,
                        m.ReminderOccurrence.kind == "checkin",
                        m.ReminderOccurrence.local_date == local_date,
                    )
                )
                if not occurrence:
                    occurrence = m.ReminderOccurrence(
                        patient_id=patient.id,
                        kind="checkin",
                        local_date=local_date,
                        expires_at=due + timedelta(minutes=30),
                    )
                    db.add(occurrence)
                    db.flush()
                attempts = db.scalar(
                    select(m.CheckInDelivery.id).where(
                        m.CheckInDelivery.occurrence_id == occurrence.id
                    )
                )
                if not attempts:
                    occurrence.expires_at = due + timedelta(minutes=30)
                    items.append((occurrence, due))
        # Follow-up changes use server push hints; local alerts cover medication
        # and check-ins. Their opaque identities are separate from playback commands.
    items.sort(key=lambda pair: pair[1])
    truncated = len(items) > 60
    covered_until = items[60][1] if truncated else horizon
    alerts = [
        {
            "identity": f"parse.{device.id}.{o.id}.g{selected['generation']}",
            "occurrence_id": o.id,
            "route_generation": selected["generation"],
            "due_at": iso(due),
            "expires_at": iso(o.expires_at),
        }
        for o, due in items[:60]
    ]
    revision = digest(
        {
            "route": selected,
            "plan": plan.version if plan else None,
            "timezone": patient.timezone,
            "checkin": [
                patient.daily_check_in_enabled,
                patient.daily_check_in_local_time,
            ],
            "alerts": alerts,
        }
    )
    return {
        "device_id": device.id,
        "server_time": iso(now),
        "active_companion": selected,
        "revision": revision,
        "valid_until": iso(horizon),
        "covered_until": iso(covered_until),
        "truncated": truncated,
        "title": GENERIC_TITLE,
        "body": GENERIC_BODY,
        "alerts": alerts,
    }


@router.get("/reminder-schedule")
def schedule(
    response: Response,
    authorization: str | None = Header(default=None),
    db=Depends(phone_db),
):
    device = authenticate_phone(db, authorization)
    lock_patient(db, device.patient_id)
    db.refresh(device)
    if device.revoked_at:
        raise HTTPException(403, "Phone access revoked")
    result = schedule_view(db, device)
    db.commit()
    response.headers["Cache-Control"] = "private, no-store"
    return result


class Registration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str | None = Field(default=None, max_length=240)
    expected_version: int = Field(ge=0)
    expected_route_generation: int = Field(ge=0)


def registration_view(db, device, settings):
    state = db.get(m.PhoneState, device.id)
    return {
        "device_id": device.id,
        "registered": bool(state and state.push_token and not state.push_disabled_at),
        "push_configured": settings.expo_push_enabled,
        "version": state.push_version if state else 0,
        "disabled": bool(state and state.push_disabled_at),
        "notification_permission": state.notification_permission if state else "unknown",
        "active_companion": route_view(db, device.patient_id),
    }


@router.get("/notification-registration")
def registration_status(
    request: Request,
    response: Response,
    authorization: str | None = Header(default=None),
    db=Depends(phone_db),
):
    device = authenticate_phone(db, authorization)
    response.headers["Cache-Control"] = "private, no-store"
    return registration_view(db, device, request.app.state.settings)


@router.put("/notification-registration")
def register(
    data: Registration,
    request: Request,
    authorization: str | None = Header(default=None),
    db=Depends(phone_db),
):
    device = authenticate_phone(db, authorization)
    lock_patient(db, device.patient_id)
    db.refresh(device)
    if device.revoked_at:
        raise HTTPException(403, "Phone access revoked")
    if data.token and not re.fullmatch(
        r"(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]", data.token
    ):
        raise HTTPException(422, "Invalid Expo push token")
    state = state_for(db, device)
    route = route_view(db, device.patient_id)
    if state.push_version != data.expected_version or route["generation"] != data.expected_route_generation:
        raise HTTPException(409, "Notification registration changed; refresh before retrying")
    if data.token and (
        route["device_id"] != device.id
        or state.notification_permission not in {"granted", "provisional"}
    ):
        raise HTTPException(409, "Select this phone and enable notification permission before registering push")
    if state.push_token != data.token or state.push_disabled_at:
        invalidate_notifications(db, device.id)
        state.push_token = data.token
        state.push_disabled_at = None
        from .notifications import snapshot

        state.push_snapshot = snapshot(db, device, utcnow())
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            409, "This notification token is registered to another installation"
        )
    return registration_view(db, device, request.app.state.settings)


class Presence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lifecycle: Literal["foreground", "background"]
    microphone_permission: Literal["granted", "denied", "undetermined", "unknown"]
    notification_permission: Literal[
        "granted", "provisional", "denied", "undetermined", "unknown"
    ]
    schedule_revision: str | None = Field(default=None, max_length=64)
    scheduled_until: datetime | None = None


@router.put("/presence")
def presence(
    data: Presence,
    authorization: str | None = Header(default=None),
    db=Depends(phone_db),
):
    device = authenticate_phone(db, authorization)
    lock_patient(db, device.patient_id)
    db.refresh(device)
    if device.revoked_at:
        raise HTTPException(403, "Phone access revoked")
    state = state_for(db, device)
    now = utcnow()
    state.lifecycle = data.lifecycle
    state.microphone_permission = data.microphone_permission
    state.notification_permission = data.notification_permission
    state.reported_at = now
    device.last_seen = now
    state.schedule_revision = data.schedule_revision
    state.scheduled_until = (
        min(aware(data.scheduled_until), now + timedelta(hours=24))
        if data.scheduled_until
        and data.notification_permission in {"granted", "provisional"}
        else None
    )
    if data.notification_permission in {"denied", "undetermined"}:
        invalidate_notifications(db, device.id)
        state.lifecycle = data.lifecycle
    if route_view(db, device.patient_id)["device_id"] != device.id:
        state.scheduled_until = None
        state.schedule_revision = None
    db.commit()
    return {"server_time": iso(now)}


class Evidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: UUID
    identity: str = Field(max_length=160)
    stage: Literal["scheduled", "opened", "suppressed", "cancelled"]


@router.post("/notification-events")
def evidence(
    data: Evidence,
    authorization: str | None = Header(default=None),
    db=Depends(phone_db),
):
    device = authenticate_phone(db, authorization)
    lock_patient(db, device.patient_id)
    db.refresh(device)
    if device.revoked_at:
        raise HTTPException(403, "Phone access revoked")
    match = re.fullmatch(
        r"parse\." + re.escape(device.id) + r"\.(occ_[a-zA-Z0-9_]+)\.g([0-9]+)",
        data.identity,
    )
    push = (
        db.get(m.PushHint, data.identity) if data.identity.startswith("push_") else None
    )
    occurrence = db.get(m.ReminderOccurrence, match[1]) if match else None
    if not (
        occurrence
        and occurrence.patient_id == device.patient_id
        or push
        and push.device_id == device.id
    ):
        raise HTTPException(404, "Notification identity not found")
    if data.stage == "scheduled":
        selected = route_view(db, device.patient_id)
        if (
            not match
            or selected["device_id"] != device.id
            or int(match[2]) != selected["generation"]
        ):
            raise HTTPException(
                409, "Notification belongs to an old companion selection"
            )
    prior = db.scalar(
        select(m.NotificationEvidence).where(
            m.NotificationEvidence.device_id == device.id,
            m.NotificationEvidence.event_id == str(data.event_id),
        )
    )
    if prior:
        if prior.identity != data.identity or prior.stage != data.stage:
            raise HTTPException(409, "Notification event ID reused")
    else:
        db.add(
            m.NotificationEvidence(
                device_id=device.id,
                event_id=str(data.event_id),
                identity=data.identity,
                stage=data.stage,
            )
        )
    db.commit()
    return {"status": "recorded", "stage": data.stage}


@router.get("/reminders/{command_id}")
def current_reminder(
    command_id: str,
    response: Response,
    authorization: str | None = Header(default=None),
    db=Depends(phone_db),
):
    from .routing import current_attempt, envelope

    device = authenticate_phone(db, authorization)
    item = db.get(m.ReminderCommand, command_id) or db.get(
        m.CheckInDelivery, command_id
    )
    if not item or item.device_id != device.id:
        raise HTTPException(404, "Reminder not found")
    if not current_attempt(db, device, item):
        raise HTTPException(409, "Reminder is no longer current")
    response.headers["Cache-Control"] = "private, no-store"
    return envelope(item)
