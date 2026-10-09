"""A paginated activity view of existing evidence, filtered before pagination."""

import base64
import json
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import String, and_, case, cast, exists, func, literal, or_, select, union_all
from sqlalchemy.dialects.postgresql import JSONB

from . import models as m
from .security import iso, utcnow


CATEGORIES = {"all", "notes", "readings", "medications", "care", "support", "recordings", "reminders", "settings", "summaries"}
AUDIT_TITLES = {
    "patient.profile_updated": "Care preferences updated",
    "device.claimed": "Companion paired",
    "device.claim_failed": "Companion pairing unsuccessful",
    "device.revoked": "Companion access revoked",
    "phone.unpaired": "Phone companion disconnected",
    "phone.quiesced": "Phone reminders stopped",
    "phone.removed_installation_released": "Removed phone released",
    "companion.selected": "Reminder companion changed",
    "note.sharing_updated": "Note sharing changed",
    "note.deleted": "Care note deleted",
    "access.updated": "Caregiver permissions updated",
    "access.revoked": "Caregiver access revoked",
    "summary.reviewed": "Summary review saved",
}


def record_audit(db, user_id, patient_id, action, object_type, object_id):
    # Never retain care text, credentials, share tokens or recipient names here.
    db.add(m.AuditEvent(actor_type="user", actor_id=user_id, patient_id=patient_id,
                        action=action, object_type=object_type, object_id=object_id, details={}))


def activity_log(db, patient, user_id, scopes, *, category="all", search="", start=None, end=None, cursor=None, limit=40):
    if category not in CATEGORIES or (start and end and start > end):
        raise HTTPException(422, "Invalid activity filters")
    owner = "*" in scopes
    all_care = owner or "read:dashboard" in scopes
    allowed = lambda name: all_care or f"read:{name}" in scopes
    manage = lambda name: owner or f"manage:{name}" in scopes
    now = utcnow()
    queries = []

    def contains_id(column):
        if db.bind.dialect.name == "postgresql":
            return cast(column, JSONB).contains([user_id])
        elements = func.json_each(column).table_valued("key", "value")
        return exists(select(1).select_from(elements).where(elements.c.value == user_id))

    def event(table, prefix, timestamp, title, group, summary, status, source="Care dashboard", where=(), joins=(), key=None):
        def expr(value):
            return literal(value) if isinstance(value, str) else value
        row_key = key if key is not None else table.id
        query = select(
            (literal(prefix + ":") + row_key).label("id"), timestamp.label("recorded_at"),
            expr(title).label("event"), expr(group).label("category"),
            func.coalesce(expr(summary), "").label("summary"), expr(status).label("status"),
            expr(source).label("source"), row_key.label("record_id"),
        ).select_from(table)
        for target, on in joins:
            query = query.join(target, on)
        queries.append(query.where(timestamp.is_not(None), *where))

    p = m.ConfirmationProposal
    active_draft = and_(p.status == "pending", p.expires_at > now)
    kinds = [("health_note", "notes", "notes", m.HealthNote),
             ("measurement", "readings", "measurements", m.Measurement),
             ("medication_report", "medications", "medications", m.DoseInstance),
             ("preventive_task", "care", "preventive_tasks", m.PreventiveTask),
             ("support_request", "support", "support", m.SupportRequest),
             ("followup", "support", "followups", m.FollowUp)]
    permits = []
    for kind, group, scope, record in kinds:
        if not allowed(scope):
            continue
        current = [record.id == p.record_id, record.patient_id == patient.id]
        draft = p.created_by_user_id == user_id
        if record is m.HealthNote:
            current.append(record.deleted_at.is_(None))
            if not owner:
                current.append(contains_id(record.shared_with_user_ids))
            draft = or_(draft, and_(active_draft, contains_id(p.payload["share_with_user_ids"])))
        elif record is m.SupportRequest:
            if not owner:
                current.append(record.recipient_user_id == user_id)
            draft = or_(draft, and_(active_draft, p.payload["recipient_user_id"].as_string() == user_id))
        elif record is m.FollowUp:
            if not owner:
                current.append(contains_id(record.permitted_user_ids))
            draft = or_(draft, and_(active_draft, contains_id(p.payload["permitted_user_ids"])))
        elif not owner:
            # Other unconfirmed material is visible only to its author.
            draft = p.created_by_user_id == user_id
        if owner:
            draft = literal(True)
        permits.append(and_(p.kind == kind, or_(
            and_(p.record_id.is_not(None), exists(select(1).where(*current))),
            and_(p.record_id.is_(None), draft))))
    kind_category = case(*[(p.kind == kind, group) for kind, group, _, _ in kinds], else_="care")
    kind_name = case(*[(p.kind == kind, name) for kind, name in [
        ("health_note", "Care note"), ("measurement", "Blood-pressure reading"),
        ("medication_report", "Medication report"), ("preventive_task", "Care task"),
        ("support_request", "Support request"), ("followup", "Follow-up")]], else_="Care update")
    text = func.coalesce(p.payload["wording"].as_string(), p.payload["request_text"].as_string(),
                         p.payload["description"].as_string(), p.payload["reported_outcome"].as_string(),
                         p.readback)
    # Superseded/cancelled/expired drafts must not retain an earlier sharing
    # decision or expose deleted wording through a revision's predecessor.
    text = case((or_(p.record_id.is_not(None), active_draft), text),
                else_="Unconfirmed draft; retained as an activity receipt.")
    voice_source = select(case((m.Device.platform == "web", "Browser companion"),
                              (m.Device.device_type == "phone", "Phone companion"), else_="Cardholder")).join(
        m.VoiceTurn, m.VoiceTurn.device_id == m.Device.id).where(
        m.VoiceTurn.id == p.source_turn_id, m.VoiceTurn.patient_id == patient.id,
        m.Device.patient_id == patient.id).scalar_subquery()
    source = case((p.source_turn_id.is_not(None), func.coalesce(voice_source, "Source not recorded")),
                  (p.created_by_user_id.is_not(None), "Care dashboard"), else_="Source not recorded")
    if permits:
        visible = [p.patient_id == patient.id, or_(*permits)]
        state = case((and_(p.status == "pending", p.expires_at <= now), "expired"), else_=p.status)
        event(p, "proposal", p.created_at, kind_name + literal(" proposed"), kind_category,
              text, state, source, visible)
        event(p, "confirmed", p.confirmed_at, kind_name + literal(" confirmed"), kind_category,
              text, "confirmed", source, [*visible, p.status == "committed"])

    # Unreviewed recordings may contain private material: owner/device managers
    # see receipt metadata only. No transcript, raw audio or provider error.
    device_source = case((m.Device.platform == "web", "Browser companion"),
                         (m.Device.device_type == "phone", "Phone companion"), else_="Cardholder")
    if manage("devices"):
        event(m.VoiceTurn, "recording", m.VoiceTurn.received_at, "Recording received", "recordings",
              "Recording receipt; processing state is shown separately from confirmation.",
              m.VoiceTurn.status, device_source, [m.VoiceTurn.patient_id == patient.id,
              m.Device.patient_id == patient.id], [(m.Device, m.Device.id == m.VoiceTurn.device_id)])

    if allowed("medications"):
        event(m.MedicationPlanVersion, "plan", m.MedicationPlanVersion.checked_at,
              "Medication plan checked", "medications", m.MedicationPlanVersion.source, "checked",
              where=[m.MedicationPlanVersion.patient_id == patient.id])
    if allowed("support"):
        support_visible = [m.SupportRequest.patient_id == patient.id]
        if not owner:
            support_visible.append(m.SupportRequest.recipient_user_id == user_id)
        event(m.SupportRequest, "acknowledged", m.SupportRequest.acknowledged_at,
              "Support request acknowledged", "support", m.SupportRequest.request_text, "acknowledged",
              where=support_visible)
        event(m.SupportRequest, "resolved", m.SupportRequest.resolved_at,
              "Support outcome recorded", "support", m.SupportRequest.outcome, "resolved", where=[*support_visible,
              ~exists(select(1).where(m.AuditEvent.action == "support.outcome_recorded", m.AuditEvent.object_id == m.SupportRequest.id,
                                      m.AuditEvent.patient_id == patient.id))])
        event(m.AuditEvent, "support_outcome", m.AuditEvent.created_at, "Support outcome recorded", "support",
              m.AuditEvent.details["outcome"].as_string(), "resolved", where=[*support_visible,
              m.AuditEvent.patient_id == patient.id, m.AuditEvent.action == "support.outcome_recorded"],
              joins=[(m.SupportRequest, m.SupportRequest.id == m.AuditEvent.object_id)])

    if manage("sharing"):
        summary_visible = [m.VisitSummary.patient_id == patient.id]
        if not owner:
            summary_visible.append(m.VisitSummary.created_by_user_id == user_id)
        event(m.VisitSummary, "summary", m.VisitSummary.created_at, "Summary prepared", "summaries",
              m.VisitSummary.purpose, "draft", where=summary_visible)
        for prefix, at, title, status in [
                ("share", m.SummaryShare.created_at, "Summary link created", "shared"),
                ("unshare", m.SummaryShare.revoked_at, "Summary link revoked", "revoked")]:
            event(m.SummaryShare, prefix, at, title, "summaries", "Read-only summary link", status,
                  where=summary_visible, joins=[(m.VisitSummary, m.VisitSummary.id == m.SummaryShare.summary_id)])

    if manage("profile"):
        event(m.CareVocabularyAudit, "vocabulary", m.CareVocabularyAudit.reviewed_at,
              "Reviewed care names saved", "settings", "Names reviewed for this care space", "saved",
              where=[m.CareVocabularyAudit.patient_id == patient.id], key=cast(m.CareVocabularyAudit.version, String))

    titles = {action: title for action, title in AUDIT_TITLES.items() if
              (manage("sharing") if action.startswith(("note.", "access.", "summary.")) else
               manage("profile") if action.startswith("patient.") else manage("devices"))}
    if titles:
        event(m.AuditEvent, "audit", m.AuditEvent.created_at,
              case(*[(m.AuditEvent.action == action, title) for action, title in titles.items()], else_="Activity recorded"),
              case((m.AuditEvent.action == "summary.reviewed", "summaries"), else_="settings"),
              "", "recorded", "Care system", [m.AuditEvent.patient_id == patient.id, m.AuditEvent.action.in_(titles)])

    if allowed("medications"):
        reminder_visible = [m.DoseInstance.patient_id == patient.id]
        event(m.ReminderCommand, "reminder", m.ReminderCommand.created_at, "Medication reminder queued",
              "reminders", m.DoseInstance.medicine_name, m.ReminderCommand.delivery_state, device_source,
              reminder_visible, [(m.DoseInstance, m.DoseInstance.id == m.ReminderCommand.dose_instance_id),
                                 (m.Device, m.Device.id == m.ReminderCommand.device_id)])
        event(m.ReminderAck, "reminder_ack", m.ReminderAck.received_at, "Medication reminder playback update",
              "reminders", m.DoseInstance.medicine_name, m.ReminderAck.stage, device_source,
              reminder_visible, [(m.ReminderCommand, and_(m.ReminderCommand.id == m.ReminderAck.command_id,
                                                        m.ReminderCommand.device_id == m.ReminderAck.device_id)),
                                 (m.DoseInstance, m.DoseInstance.id == m.ReminderCommand.dose_instance_id),
                                 (m.Device, m.Device.id == m.ReminderAck.device_id)])
    if manage("devices"):
        event(m.CheckInDelivery, "checkin", m.CheckInDelivery.created_at, "Daily check-in queued", "reminders",
              "Optional daily check-in", m.CheckInDelivery.delivery_state, "Care system",
              [m.CheckInDelivery.patient_id == patient.id])
        event(m.ReminderAck, "checkin_ack", m.ReminderAck.received_at, "Daily check-in playback update", "reminders",
              "Optional daily check-in", m.ReminderAck.stage, "Patient companion",
              [m.CheckInDelivery.patient_id == patient.id], [(m.CheckInDelivery, and_(
                  m.CheckInDelivery.id == m.ReminderAck.command_id, m.CheckInDelivery.device_id == m.ReminderAck.device_id))])

    if not queries:
        return {"items": [], "next_cursor": None, "timezone": patient.timezone}
    feed = union_all(*queries).subquery()
    query = select(feed)
    if category != "all":
        query = query.where(feed.c.category == category)
    if search.strip():
        query = query.where(or_(feed.c.event.icontains(search.strip(), autoescape=True),
                               feed.c.summary.icontains(search.strip(), autoescape=True),
                               feed.c.source.icontains(search.strip(), autoescape=True),
                               feed.c.status.icontains(search.strip(), autoescape=True)))
    zone = ZoneInfo(patient.timezone)
    try:
        if start:
            query = query.where(feed.c.recorded_at >= datetime.combine(start, time.min, zone).astimezone(timezone.utc))
        if end:
            query = query.where(feed.c.recorded_at < datetime.combine(end + timedelta(days=1), time.min, zone).astimezone(timezone.utc))
    except OverflowError:
        raise HTTPException(422, "Activity dates are outside the supported range") from None
    if cursor:
        try:
            timestamp, key = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
            timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            if timestamp.tzinfo is None or not isinstance(key, str) or len(key) > 160:
                raise ValueError()
        except (ValueError, TypeError, KeyError, json.JSONDecodeError, UnicodeDecodeError):
            raise HTTPException(422, "Invalid activity cursor") from None
        query = query.where(or_(feed.c.recorded_at < timestamp,
                               and_(feed.c.recorded_at == timestamp, feed.c.id < key)))
    rows = db.execute(query.order_by(feed.c.recorded_at.desc(), feed.c.id.desc()).limit(limit + 1)).mappings().all()
    page = rows[:limit]
    next_cursor = None
    if len(rows) > limit:
        last = page[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps([iso(last["recorded_at"]), last["id"]]).encode()).decode().rstrip("=")
    return {"items": [{**dict(row), "recorded_at": iso(row["recorded_at"])} for row in page],
            "next_cursor": next_cursor, "timezone": patient.timezone}
