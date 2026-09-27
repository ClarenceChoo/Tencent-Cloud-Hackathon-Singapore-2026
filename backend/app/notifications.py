"""Durable generic Expo hints. Provider acceptance never means OS delivery."""

from datetime import timedelta
import httpx
from sqlalchemy import select
from . import models as m
from .notification_api import (
    digest,
    GENERIC_TITLE,
    GENERIC_BODY,
    invalidate_notifications,
)
from .routing import lock_patient, route_view
from .security import aware, iso, utcnow

SEND = "https://exp.host/--/api/v2/push/send"
RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts"


def snapshot(db, device, now):
    patient = db.get(m.Patient, device.patient_id)
    plan = db.scalar(
        select(m.MedicationPlanVersion).where(
            m.MedicationPlanVersion.patient_id == patient.id,
            m.MedicationPlanVersion.active.is_(True),
        )
    )
    supports = db.scalars(
        select(m.SupportRequest)
        .where(m.SupportRequest.patient_id == patient.id)
        .order_by(m.SupportRequest.created_at.desc())
        .limit(50)
    ).all()
    followups = db.scalars(
        select(m.FollowUp)
        .where(m.FollowUp.patient_id == patient.id)
        .order_by(m.FollowUp.created_at.desc())
        .limit(100)
    ).all()
    return {
        "route": route_view(db, patient.id),
        "plan": plan.version if plan else None,
        "profile": [
            patient.timezone,
            patient.daily_check_in_enabled,
            patient.daily_check_in_local_time,
        ],
        "support": [
            [s.id, s.status, iso(s.acknowledged_at), iso(s.resolved_at)]
            for s in supports
        ],
        "followups": [
            [
                f.id,
                f.resolution_state,
                iso(f.check_at),
                bool(f.check_at and aware(f.check_at) <= now),
            ]
            for f in followups
        ],
    }


def collect_hints(app, now):
    with app.state.db.SessionLocal() as db:
        devices = db.scalars(
            select(m.Device)
            .join(m.PhoneState, m.PhoneState.device_id == m.Device.id)
            .where(m.Device.device_type == "phone", m.Device.patient_id.is_not(None))
        ).all()
        for device in devices:
            lock_patient(db, device.patient_id)
            db.refresh(device)
            state = db.get(m.PhoneState, device.id, populate_existing=True)
            if device.revoked_at:
                invalidate_notifications(db, device.id)
                db.commit()
                continue
            current = snapshot(db, device, now)
            previous = state.push_snapshot
            state.push_snapshot = current
            if (
                previous is not None
                and current != previous
                and state.push_token
                and not state.push_disabled_at
                and current["route"]["device_id"] == device.id
                and state.notification_permission in {"granted", "provisional"}
            ):
                fingerprint = digest([current, state.push_version])
                exists = db.scalar(
                    select(m.PushHint.id).where(
                        m.PushHint.device_id == device.id,
                        m.PushHint.fingerprint == fingerprint,
                    )
                )
                if not exists:
                    db.add(
                        m.PushHint(
                            device_id=device.id,
                            fingerprint=fingerprint,
                            route_generation=current["route"]["generation"],
                            push_version=state.push_version,
                            next_attempt_at=now,
                            expires_at=now + timedelta(hours=1),
                        )
                    )
            db.commit()


def valid(db, hint):
    device = db.get(m.Device, hint.device_id, populate_existing=True)
    state = db.get(m.PhoneState, hint.device_id, populate_existing=True)
    selected = route_view(db, device.patient_id)
    return bool(
        not device.revoked_at
        and state
        and state.push_token
        and not state.push_disabled_at
        and state.push_version == hint.push_version
        and state.notification_permission in {"granted", "provisional"}
        and selected["device_id"] == device.id
        and selected["generation"] == hint.route_generation
    )


async def expo_request(app, url, body):
    headers = {"Accept": "application/json"}
    token = app.state.settings.expo_push_access_token.get_secret_value()
    if token:
        headers["Authorization"] = "Bearer " + token
    async with httpx.AsyncClient(
        timeout=10,
        follow_redirects=False,
        transport=getattr(app.state, "push_transport", None),
    ) as client:
        async with client.stream("POST", url, json=body, headers=headers) as response:
            if response.status_code == 429 or response.status_code >= 500:
                return "retry", None
            if response.status_code != 200:
                return "error", None
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 65536:
                    raise ValueError("Oversize push response")
    import json

    return "ok", json.loads(bytes(data))


def retry(hint, now, code):
    hint.error_code = code
    if hint.attempts >= 5 or aware(hint.expires_at) <= now:
        hint.status = "unknown" if code == "transport_unknown" else "failed"
    else:
        hint.status = "pending"
        hint.next_attempt_at = now + timedelta(seconds=min(300, 5 * 2**hint.attempts))


async def send_hint(app, hint_id, now):
    with app.state.db.SessionLocal() as db:
        hint = db.get(m.PushHint, hint_id)
        device = db.get(m.Device, hint.device_id)
        lock_patient(db, device.patient_id)
        db.refresh(hint)
        if hint.status != "pending" or aware(hint.next_attempt_at) > now:
            return
        if not valid(db, hint) or aware(hint.expires_at) <= now:
            hint.status = "cancelled"
            db.commit()
            return
        token = db.get(m.PhoneState, device.id).push_token
        hint.status = "sending"
        hint.attempts += 1
        hint.next_attempt_at = now + timedelta(seconds=30)
        identity = hint.id
        ttl = max(1, int((aware(hint.expires_at) - now).total_seconds()))
        db.commit()
        payload = {
            "to": token,
            "title": GENERIC_TITLE,
            "body": GENERIC_BODY,
            "sound": "default",
            "data": {"parse": True, "identity": identity},
            "ttl": ttl,
            "channelId": "parse-care",
            "collapseId": identity,
            "tag": identity,
        }
        try:
            outcome, result = await expo_request(app, SEND, payload)
        except Exception:
            outcome, result = "retry", None
        lock_patient(db, device.patient_id)
        db.refresh(hint)
        if hint.status != "sending" or not valid(db, hint):
            hint.status = "cancelled"
            db.commit()
            return
        if outcome == "retry":
            retry(hint, now, "transport_unknown")
        elif outcome == "error":
            hint.status = "failed"
            hint.error_code = "provider_http_error"
        else:
            ticket = result.get("data", {}) if isinstance(result, dict) else {}
            if isinstance(ticket, list):
                ticket = ticket[0] if len(ticket) == 1 else {}
            code = ticket.get("details", {}).get("error", "provider_error")
            if (
                ticket.get("status") == "ok"
                and isinstance(ticket.get("id"), str)
                and len(ticket["id"]) <= 100
            ):
                hint.ticket_id = ticket["id"]
                hint.status = "ticketed"
                hint.next_attempt_at = now + timedelta(minutes=15)
            elif code == "DeviceNotRegistered":
                invalidate_notifications(db, device.id)
                hint.status = "failed"
                hint.error_code = code
            elif code == "MessageRateExceeded":
                retry(hint, now, code)
            else:
                hint.status = "failed"
                hint.error_code = "provider_rejected"
        db.commit()


async def receipt(app, hint_id, now):
    with app.state.db.SessionLocal() as db:
        hint = db.get(m.PushHint, hint_id)
        if hint.status != "ticketed" or not hint.ticket_id:
            return
        ticket = hint.ticket_id
        device = db.get(m.Device, hint.device_id)
        db.commit()
        try:
            outcome, result = await expo_request(app, RECEIPTS, {"ids": [ticket]})
        except Exception:
            outcome, result = "retry", None
        lock_patient(db, device.patient_id)
        db.refresh(hint)
        if hint.status != "ticketed":
            return
        if not valid(db, hint):
            hint.status = "cancelled"
            db.commit()
            return
        item = (
            result.get("data", {}).get(ticket)
            if outcome == "ok" and isinstance(result, dict)
            else None
        )
        if item and item.get("status") == "ok":
            hint.status = "provider_accepted"
        elif item and item.get("details", {}).get("error") == "DeviceNotRegistered":
            invalidate_notifications(db, device.id)
            hint.status = "failed"
            hint.error_code = "DeviceNotRegistered"
        elif item and item.get("status") == "error":
            hint.status = "failed"
            hint.error_code = "receipt_rejected"
        elif aware(hint.created_at) < now - timedelta(hours=23):
            hint.status = "unknown"
            hint.error_code = "receipt_missing"
        else:
            hint.next_attempt_at = now + timedelta(minutes=15)
        db.commit()


async def push_tick(app):
    now = utcnow()
    collect_hints(app, now)
    if not app.state.settings.expo_push_enabled:
        return
    with app.state.db.SessionLocal() as db:
        # Retries after an uncertain network result retain one collapse identity.
        stale = db.scalars(
            select(m.PushHint).where(
                m.PushHint.status == "sending", m.PushHint.next_attempt_at <= now
            )
        ).all()
        for hint in stale:
            retry(hint, now, "transport_unknown")
        db.commit()
        pending = db.scalars(
            select(m.PushHint.id)
            .where(m.PushHint.status == "pending", m.PushHint.next_attempt_at <= now)
            .limit(20)
        ).all()
        receipts = db.scalars(
            select(m.PushHint.id)
            .where(m.PushHint.status == "ticketed", m.PushHint.next_attempt_at <= now)
            .limit(20)
        ).all()
    for identity in pending:
        await send_hint(app, identity, now)
    for identity in receipts:
        await receipt(app, identity, now)


async def notification_loop(app):
    import asyncio

    while True:
        try:
            await push_tick(app)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass  # Durable rows retain retry state; no sensitive provider text is logged.
        await asyncio.sleep(5)
