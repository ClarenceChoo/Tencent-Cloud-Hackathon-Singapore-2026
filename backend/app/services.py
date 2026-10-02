import hashlib
import io
import re
import wave
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, Optional, Tuple, Type
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from . import models as m
from .security import aware, grant_scopes, iso, utcnow
from .summary_templates import SUMMARY_TEMPLATE_VERSION, present_summary


PROPOSAL_TTL = timedelta(seconds=120)
ALLOWED_REPORT_STATES = {
    "reported_taken",
    "reported_skipped",
    "reported_not_yet",
    "reported_uncertain",
}
UPDATABLE_REPORT_STATES = {"unconfirmed", "reported_not_yet", "reported_uncertain"}
PREVENTIVE_STATES = {"planned", "due", "arranged", "completed", "declined", "needs_discussion"}
EXPLICIT_CONFIRMATIONS = {
    "yes",
    "yes that is right",
    "yes that's right",
    "that is right",
    "that's right",
    "correct",
    "that is correct",
    "confirm",
    "i confirm",
    "yes save that",
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class HealthNotePayload(StrictModel):
    wording: str = Field(min_length=1, max_length=4000)
    symptom: Optional[str] = Field(default=None, max_length=200)
    occurrence_text: Optional[str] = Field(default=None, max_length=1000)
    occurred_at: Optional[datetime] = None
    timezone: Optional[str] = Field(default=None, max_length=80)
    share_with_user_ids: list[str] = Field(default_factory=list)
    share_with_names: list[str] = Field(default_factory=list, exclude=True)


class MedicationReportPayload(StrictModel):
    dose_instance_id: str
    report_state: str
    taken_time_text: Optional[str] = Field(default=None, max_length=500)
    plan_version: Optional[int] = None

    @model_validator(mode="after")
    def state_valid(self):
        if self.report_state not in ALLOWED_REPORT_STATES:
            raise ValueError("unsupported medication report state")
        if self.report_state != "reported_taken" and self.taken_time_text:
            raise ValueError("taken_time_text is only valid for a reported taken dose")
        return self


class MeasurementPayload(StrictModel):
    measurement_type: str
    systolic: int = Field(ge=40, le=300)
    diastolic: int = Field(ge=20, le=200)
    unit: str
    occurred_at: Optional[datetime] = None
    occurrence_text: Optional[str] = Field(default=None, max_length=500)
    timezone: str = Field(min_length=1, max_length=80)
    source_description: str = Field(min_length=1, max_length=1000)
    reporting_actor: str = Field(min_length=1, max_length=100)
    supersedes_id: Optional[str] = None

    @model_validator(mode="after")
    def measurement_rules(self):
        if self.measurement_type != "blood_pressure" or self.unit != "mmHg":
            raise ValueError("MVP measurements must be external blood pressure in mmHg")
        if bool(self.occurred_at) == bool(self.occurrence_text):
            raise ValueError("provide exactly one of occurred_at or occurrence_text")
        return self


class PreventivePayload(StrictModel):
    task_id: Optional[str] = None
    task_type: Optional[str] = Field(default=None, max_length=80)
    description: Optional[str] = Field(default=None, max_length=2000)
    source: Optional[str] = Field(default=None, max_length=1000)
    due_date: Optional[date] = None
    timezone: Optional[str] = Field(default=None, max_length=80)
    state: str
    appointment_date: Optional[date] = None
    completion_date: Optional[date] = None

    @model_validator(mode="after")
    def task_rules(self):
        if self.state not in PREVENTIVE_STATES:
            raise ValueError("unsupported preventive task state")
        if self.task_id:
            forbidden = [self.task_type, self.description, self.source, self.due_date, self.timezone]
            if any(item is not None for item in forbidden):
                raise ValueError("task transitions cannot replace source care-plan fields")
        elif not all([self.task_type, self.description, self.source, self.due_date, self.timezone]):
            raise ValueError("new tasks require type, description, source, due_date and timezone")
        return self


class SupportPayload(StrictModel):
    request_text: str = Field(min_length=1, max_length=2000)
    recipient_user_id: str
    urgency: str = "routine"
    barrier_text: Optional[str] = Field(default=None, max_length=2000)
    recipient_name: Optional[str] = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def urgency_valid(self):
        if self.urgency not in {"routine", "urgent"}:
            raise ValueError("urgency must be routine or urgent")
        return self


class FollowUpPayload(StrictModel):
    followup_id: Optional[str] = None
    related_type: Optional[str] = None
    related_id: Optional[str] = None
    check_at: Optional[datetime] = None
    permission_scope: Optional[str] = Field(default=None, min_length=1, max_length=100)
    permitted_user_ids: list[str] = Field(default_factory=list, exclude=True)
    reported_outcome: Optional[str] = Field(default=None, max_length=2000)
    resolution_state: str = "open"

    @model_validator(mode="after")
    def followup_valid(self):
        if self.resolution_state not in {"open", "resolved"}:
            raise ValueError("unsupported follow-up resolution state")
        if self.followup_id:
            if self.resolution_state != "resolved" or not self.reported_outcome:
                raise ValueError("resolving a follow-up requires a human-reported outcome")
            if any([self.related_type, self.related_id, self.check_at, self.permission_scope]):
                raise ValueError("follow-up resolution cannot replace the original follow-up fields")
        else:
            if self.related_type not in {"support_request", "health_note", "medication_report"}:
                raise ValueError("unsupported follow-up relation")
            if not all([self.related_id, self.check_at, self.permission_scope]):
                raise ValueError("new follow-ups require relation, check time and permission scope")
            if self.resolution_state != "open" or self.reported_outcome:
                raise ValueError("a new follow-up starts open without an outcome")
            if self.permission_scope not in {"private", "related_recipients"}:
                raise ValueError("permission_scope must be private or related_recipients")
        return self


PAYLOAD_MODELS: Dict[str, Type[StrictModel]] = {
    "health_note": HealthNotePayload,
    "medication_report": MedicationReportPayload,
    "measurement": MeasurementPayload,
    "preventive_task": PreventivePayload,
    "support_request": SupportPayload,
    "followup": FollowUpPayload,
}


def _browser_record_access(db: Session, patient_id: str, user_id: Optional[str], permitted_user_ids: list[str], proposal_id: Optional[str] = None) -> bool:
    if user_id is None:
        return True
    grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == patient_id, m.AccessGrant.user_id == user_id, m.AccessGrant.revoked_at.is_(None)).execution_options(populate_existing=True))
    if not grant or (grant.expires_at and aware(grant.expires_at) <= utcnow()):
        return False
    if "*" in (grant.scopes or []) or user_id in (permitted_user_ids or []):
        return True
    proposal = db.get(m.ConfirmationProposal, proposal_id) if proposal_id else None
    return bool(proposal and proposal.created_by_user_id == user_id)


def _followup_source_recipients(db: Session, patient_id: str, related_type: str, related_id: str, user_id: Optional[str]) -> list[str]:
    """Resolve current source access for both new follow-ups and their outcomes."""
    if related_type == "health_note":
        related = db.get(m.HealthNote, related_id, populate_existing=True)
        if not related or related.patient_id != patient_id or related.deleted_at:
            raise HTTPException(status_code=422, detail="Related health note is unavailable")
        recipients = list(related.shared_with_user_ids or [])
        # Authorship does not retain access after the owner makes a note private.
        if not _browser_record_access(db, patient_id, user_id, recipients):
            raise HTTPException(status_code=403, detail="Related health note access is not permitted")
        return recipients
    if related_type == "support_request":
        related = db.get(m.SupportRequest, related_id, populate_existing=True)
        if not related or related.patient_id != patient_id:
            raise HTTPException(status_code=422, detail="Related support request is unavailable")
        if not _browser_record_access(db, patient_id, user_id, [related.recipient_user_id], related.proposal_id):
            raise HTTPException(status_code=403, detail="Related support request access is not permitted")
        return [related.recipient_user_id]
    related = db.get(m.DoseInstance, related_id, populate_existing=True)
    if not related or related.patient_id != patient_id:
        raise HTTPException(status_code=422, detail="Related medication report is unavailable")
    return [user_id] if user_id else []


def validate_payload(db: Session, patient_id: str, kind: str, payload: dict, acting_user_id: Optional[str] = None) -> Tuple[dict, Optional[int]]:
    model = PAYLOAD_MODELS.get(kind)
    if not model:
        raise HTTPException(status_code=422, detail="Unsupported proposal kind")
    payload = dict(payload)
    derived_fields = {
        "health_note": {"share_with_names"},
        "medication_report": {"plan_version", "medicine_name", "scheduled_at", "previous_report_state", "previous_confirmation_proposal_id"},
        "preventive_task": {"previous_state"},
        "support_request": {"recipient_name", "calling_route", "calling_route_message"},
        "followup": {"previous_resolution_state"},
    }
    for field in derived_fields.get(kind, set()):
        payload.pop(field, None)
    if kind == "followup" and payload.get("followup_id"):
        for field in {"related_type", "related_id", "check_at", "permission_scope"}:
            payload.pop(field, None)
    try:
        parsed = model.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False, include_context=False))
    clean = parsed.model_dump(mode="json", exclude_none=True)
    plan_version = None
    if kind == "medication_report":
        dose = db.get(m.DoseInstance, parsed.dose_instance_id, populate_existing=True)
        if not dose or dose.patient_id != patient_id:
            raise HTTPException(status_code=422, detail="Dose instance is not available for this patient")
        candidates = db.scalars(
            select(m.DoseInstance).where(
                m.DoseInstance.patient_id == patient_id,
                m.DoseInstance.scheduled_at == dose.scheduled_at,
                m.DoseInstance.report_state == "unconfirmed",
            )
        ).all()
        if len(candidates) > 1 and not parsed.dose_instance_id:
            raise HTTPException(status_code=422, detail="Medication reference is ambiguous")
        if dose.report_state not in UPDATABLE_REPORT_STATES:
            raise HTTPException(status_code=409, detail="Dose already has a final confirmed report")
        clean["previous_report_state"] = dose.report_state
        clean["previous_confirmation_proposal_id"] = dose.confirmation_proposal_id
        plan_version = dose.plan_version
        clean["plan_version"] = plan_version
        clean["medicine_name"] = dose.medicine_name
        clean["scheduled_at"] = iso(dose.scheduled_at)
    elif kind == "health_note" and parsed.share_with_user_ids:
        if len(set(parsed.share_with_user_ids)) != len(parsed.share_with_user_ids):
            raise HTTPException(status_code=422, detail="Sharing recipients must be unique")
        names = []
        for user_id in parsed.share_with_user_ids:
            row = db.execute(
                select(m.AccessGrant, m.User)
                .join(m.User, m.User.id == m.AccessGrant.user_id)
                .where(
                    m.AccessGrant.patient_id == patient_id,
                    m.AccessGrant.user_id == user_id,
                    m.AccessGrant.revoked_at.is_(None),
                )
            ).first()
            if not row or (row[0].expires_at and aware(row[0].expires_at) <= utcnow()):
                raise HTTPException(status_code=422, detail="A sharing recipient is not currently permitted")
            names.append(row[1].name)
        clean["share_with_names"] = names
    elif kind == "measurement" and parsed.supersedes_id:
        existing = db.get(m.Measurement, parsed.supersedes_id)
        if not existing or existing.patient_id != patient_id or existing.superseded_at:
            raise HTTPException(status_code=422, detail="Measurement to correct is unavailable")
    elif kind == "preventive_task" and parsed.task_id:
        task = db.get(m.PreventiveTask, parsed.task_id)
        if not task or task.patient_id != patient_id:
            raise HTTPException(status_code=422, detail="Preventive task is unavailable")
        allowed = {
            "planned": {"due", "arranged", "declined", "needs_discussion"},
            "due": {"arranged", "declined", "needs_discussion"},
            "arranged": {"completed", "declined", "needs_discussion"},
            "completed": {"needs_discussion"},
            "declined": {"needs_discussion", "arranged"},
            "needs_discussion": {"planned", "due", "arranged", "declined"},
        }
        if parsed.state not in allowed.get(task.state, set()):
            raise HTTPException(status_code=409, detail="Preventive task transition is not allowed")
        clean["previous_state"] = task.state
    elif kind == "support_request":
        recipient_grant = db.scalar(
            select(m.AccessGrant).where(
                m.AccessGrant.patient_id == patient_id,
                m.AccessGrant.user_id == parsed.recipient_user_id,
                m.AccessGrant.revoked_at.is_(None),
            )
        )
        if not recipient_grant or (recipient_grant.expires_at and aware(recipient_grant.expires_at) <= utcnow()):
            raise HTTPException(status_code=422, detail="Recipient is not permitted for this patient")
        recipient = db.get(m.User, parsed.recipient_user_id)
        clean["recipient_name"] = recipient.name
        patient = db.get(m.Patient, patient_id)
        if parsed.urgency == "urgent":
            clean["calling_route"] = patient.calling_route
            clean["calling_route_message"] = patient.calling_route or "No calling route is configured. Use your usual local support or emergency contact method."
    elif kind == "followup":
        if parsed.followup_id:
            existing = db.get(m.FollowUp, parsed.followup_id, populate_existing=True)
            if not existing or existing.patient_id != patient_id or existing.resolution_state != "open":
                raise HTTPException(status_code=422, detail="Open follow-up is unavailable")
            if not _browser_record_access(db, patient_id, acting_user_id, existing.permitted_user_ids, existing.proposal_id):
                raise HTTPException(status_code=403, detail="Follow-up access is not permitted")
            recipients = _followup_source_recipients(db, patient_id, existing.related_type, existing.related_id, acting_user_id)
            # Medication follow-ups are private to their original creator;
            # an owner/device resolving one must not replace that audience.
            if (existing.permission_scope == "related_recipients"
                    and existing.related_type != "medication_report"
                    and set(existing.permitted_user_ids or []) != set(recipients)):
                raise HTTPException(status_code=409, detail="Related follow-up access changed")
            clean.update({"related_type": existing.related_type, "related_id": existing.related_id, "check_at": iso(existing.check_at), "permission_scope": existing.permission_scope, "permitted_user_ids": existing.permitted_user_ids, "previous_resolution_state": existing.resolution_state})
        else:
            recipients = _followup_source_recipients(db, patient_id, parsed.related_type, parsed.related_id, acting_user_id)
            clean["permitted_user_ids"] = recipients if parsed.permission_scope == "related_recipients" else ([acting_user_id] if acting_user_id else [])
        if parsed.permission_scope == "related_recipients" and not clean.get("permitted_user_ids"):
            raise HTTPException(status_code=422, detail="Related item has no permitted follow-up recipients")
        for user_id in clean.get("permitted_user_ids", []):
            grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == patient_id, m.AccessGrant.user_id == user_id, m.AccessGrant.revoked_at.is_(None)).execution_options(populate_existing=True))
            if not grant or (grant.expires_at and aware(grant.expires_at) <= utcnow()):
                raise HTTPException(status_code=422, detail="A follow-up recipient is no longer permitted")
    return clean, plan_version


def build_readback(kind: str, payload: dict) -> str:
    if kind == "health_note":
        when = payload.get("occurrence_text") or payload.get("occurred_at") or "with no exact time stated"
        symptom = " Symptom: %s." % payload["symptom"] if payload.get("symptom") else ""
        sharing = " It will remain private." if not payload.get("share_with_names") else " It will be shared with %s." % ", ".join(payload["share_with_names"])
        return "I will record: %s, %s.%s%s Is that right?" % (payload["wording"], when, symptom, sharing)
    if kind == "medication_report":
        wording = payload["report_state"].replace("reported_", "").replace("_", " ")
        taken = (", with the time described as %s" % payload["taken_time_text"]) if payload.get("taken_time_text") else ""
        previous = payload.get("previous_report_state", "unconfirmed")
        action = "record" if previous == "unconfirmed" else "update the previous %s report to" % previous.replace("reported_", "").replace("_", " ")
        return "I will %s %s for %s scheduled at %s%s. Is that right?" % (
            action, wording,
            payload["medicine_name"],
            payload["scheduled_at"],
            taken,
        )
    if kind == "measurement":
        when = payload.get("occurrence_text") or payload.get("occurred_at")
        return "I will record an external blood pressure reading of %s over %s %s, %s in %s, reported by %s from %s. Is that right?" % (
            payload["systolic"], payload["diastolic"], payload["unit"], when, payload["timezone"], payload["reporting_actor"], payload["source_description"]
        )
    if kind == "preventive_task":
        if payload.get("task_id"):
            detail = ""
            if payload["state"] == "arranged":
                detail = ", appointment %s" % payload["appointment_date"] if payload.get("appointment_date") else ", appointment date unknown"
            elif payload["state"] == "completed":
                detail = ", completed %s" % payload["completion_date"] if payload.get("completion_date") else ", completion date unknown"
            return "I will change this preventive task from %s to %s%s. Is that right?" % (
                payload["previous_state"], payload["state"], detail
            )
        return "I will add the %s task, %s, from %s, due %s in %s, as %s. Is that right?" % (
            payload["task_type"], payload["description"], payload["source"], payload["due_date"], payload["timezone"], payload["state"]
        )
    if kind == "support_request":
        barrier = " The reported difficulty is: %s." % payload["barrier_text"] if payload.get("barrier_text") else ""
        route = " Calling route: %s This does not dispatch help." % payload["calling_route_message"] if payload["urgency"] == "urgent" else ""
        return "I will send this %s support request to %s: %s.%s%s Is that right?" % (
            payload["urgency"], payload["recipient_name"], payload["request_text"], barrier, route
        )
    if kind == "followup":
        outcome = " with the reported outcome: %s" % payload["reported_outcome"] if payload.get("reported_outcome") else ""
        return "I will record a follow-up for %s %s at %s, shared within %s, as %s%s. Is that right?" % (
            payload["related_type"], payload["related_id"], payload["check_at"], payload["permission_scope"], payload["resolution_state"], outcome
        )
    raise HTTPException(status_code=422, detail="Unsupported proposal kind")


def create_proposal(
    db: Session,
    patient_id: str,
    kind: str,
    payload: dict,
    user_id: Optional[str] = None,
    source_turn_id: Optional[str] = None,
    replaces: Optional[m.ConfirmationProposal] = None,
) -> m.ConfirmationProposal:
    from .routing import lock_patient
    lock_patient(db, patient_id)
    if replaces:
        db.refresh(replaces)
        if replaces.status != "pending" or aware(replaces.expires_at) <= utcnow():
            raise HTTPException(409, "Only a current pending proposal can be revised")
        if replaces.kind == "medication_report":
            prior_dose = db.get(m.DoseInstance, replaces.payload.get("dose_instance_id"), populate_existing=True)
            prior_plan = db.get(m.MedicationPlanVersion, prior_dose.plan_id, populate_existing=True) if prior_dose else None
            if (not prior_dose or not prior_plan or not prior_plan.active
                    or prior_dose.plan_version != replaces.plan_version
                    or prior_dose.report_state != replaces.payload.get("previous_report_state", "unconfirmed")
                    or prior_dose.confirmation_proposal_id != replaces.payload.get("previous_confirmation_proposal_id")):
                raise HTTPException(409, "Medication plan or dose report changed; start a fresh review")
        if replaces.kind in {"health_note", "support_request"}:
            prior_recipients = (replaces.payload.get("share_with_user_ids", []) if replaces.kind == "health_note"
                                else [replaces.payload.get("recipient_user_id")])
            for user_id in prior_recipients:
                grant = db.scalar(select(m.AccessGrant).where(
                    m.AccessGrant.patient_id == patient_id, m.AccessGrant.user_id == user_id,
                    m.AccessGrant.revoked_at.is_(None)).execution_options(populate_existing=True))
                if not grant or (grant.expires_at and aware(grant.expires_at) <= utcnow()):
                    raise HTTPException(409, "Recipient access changed; start a fresh review")
    source = db.get(m.VoiceTurn, source_turn_id) if source_turn_id else None
    device = db.get(m.Device, source.device_id, populate_existing=True) if source else None
    if device and device.device_type == "phone":
        if device.revoked_at or device.patient_id != patient_id:
            raise HTTPException(403, "Phone access changed")
        # Slow completion of an older utterance must not replace a newer read-back.
        newer = db.scalar(select(m.VoiceTurn.id).where(m.VoiceTurn.device_id == device.id,
                          m.VoiceTurn.received_at > source.received_at,
                          m.VoiceTurn.status == "awaiting_confirmation"))
        if newer:
            raise HTTPException(409, "A newer phone response is current")
    clean, plan_version = validate_payload(db, patient_id, kind, payload, acting_user_id=user_id)
    if replaces:
        changed = db.execute(update(m.ConfirmationProposal).where(
            m.ConfirmationProposal.id == replaces.id,
            m.ConfirmationProposal.status == "pending",
            m.ConfirmationProposal.expires_at > utcnow(),
        ).values(status="invalidated", invalidated_reason="revised").execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise HTTPException(status_code=409, detail="Only a current pending proposal can be revised")
        replaces.status = "invalidated"
        replaces.invalidated_reason = "revised"
    if device and device.device_type == "phone":
        previous_ids = select(m.VoiceTurn.id).where(m.VoiceTurn.device_id == device.id)
        db.execute(update(m.ConfirmationProposal).where(
            m.ConfirmationProposal.source_turn_id.in_(previous_ids),
            m.ConfirmationProposal.status == "pending",
        ).values(status="invalidated", invalidated_reason="new_phone_readback")
                   .execution_options(synchronize_session=False))
    proposal = m.ConfirmationProposal(
        patient_id=patient_id,
        kind=kind,
        payload=clean,
        readback=build_readback(kind, clean),
        expires_at=utcnow() + PROPOSAL_TTL,
        created_by_user_id=user_id,
        source_turn_id=source_turn_id,
        replaces_proposal_id=replaces.id if replaces else None,
        plan_version=plan_version,
    )
    db.add(proposal)
    db.flush()
    db.add(m.AuditEvent(actor_type="user" if user_id else "device", actor_id=user_id, patient_id=patient_id, action="proposal.created", object_type="proposal", object_id=proposal.id, details={"kind": kind}))
    return proposal


def proposal_dict(p: m.ConfirmationProposal) -> dict:
    return {
        "id": p.id,
        "kind": p.kind,
        "payload": p.payload,
        "readback": p.readback,
        "status": p.status,
        "created_at": iso(p.created_at),
        "expires_at": iso(p.expires_at),
        "context_id": p.context_id,
        "replaces_proposal_id": p.replaces_proposal_id,
        "record_type": p.record_type,
        "record_id": p.record_id,
    }


def invalidate_summaries(db: Session, patient_id: str, source_id: Optional[str] = None) -> None:
    summaries = db.scalars(select(m.VisitSummary).where(m.VisitSummary.patient_id == patient_id, m.VisitSummary.invalidated_at.is_(None))).all()
    now = utcnow()
    for summary in summaries:
        if source_id is None or any(ref.get("id") == source_id for ref in (summary.source_refs or [])):
            summary.invalidated_at = now
            summary.status = "invalidated"


def summary_sources_current(db: Session, summary: m.VisitSummary, viewer_user_id: Optional[str] = None) -> bool:
    viewer_user_id = viewer_user_id or summary.created_by_user_id
    try:
        grant, scopes = grant_scopes(db, viewer_user_id, summary.patient_id)
    except HTTPException:
        return False
    if "*" not in scopes and "manage:sharing" not in scopes:
        return False
    all_access = "*" in scopes
    def collection_allowed(name: str) -> bool:
        return all_access or "read:dashboard" in scopes or ("read:%s" % name) in scopes
    allowed = {"health_note", "measurement", "medication_report", "preventive_task", "support_request", "followup"}
    for ref in summary.source_refs or []:
        if set(ref) != {"type", "id", "version"} or ref["type"] not in allowed or not isinstance(ref["version"], int):
            return False
        if ref["type"] == "health_note":
            row = db.get(m.HealthNote, ref["id"])
            valid = row and row.patient_id == summary.patient_id and not row.deleted_at and row.version == ref["version"] and collection_allowed("notes") and (all_access or viewer_user_id in (row.shared_with_user_ids or []))
        elif ref["type"] == "measurement":
            row = db.get(m.Measurement, ref["id"])
            valid = row and row.patient_id == summary.patient_id and not row.superseded_at and row.version == ref["version"] and collection_allowed("measurements")
        elif ref["type"] == "medication_report":
            row = db.get(m.DoseInstance, ref["id"])
            valid = row and row.patient_id == summary.patient_id and row.plan_version == ref["version"] and collection_allowed("medications")
        elif ref["type"] == "preventive_task":
            row = db.get(m.PreventiveTask, ref["id"])
            valid = row and row.patient_id == summary.patient_id and row.version == ref["version"] and collection_allowed("preventive_tasks")
        elif ref["type"] == "support_request":
            row = db.get(m.SupportRequest, ref["id"])
            valid = row and row.patient_id == summary.patient_id and ref["version"] == 1 and collection_allowed("support") and (all_access or row.recipient_user_id == viewer_user_id)
        else:
            row = db.get(m.FollowUp, ref["id"])
            valid = row and row.patient_id == summary.patient_id and ref["version"] == 1 and collection_allowed("followups") and (all_access or viewer_user_id in (row.permitted_user_ids or []))
        if not valid:
            return False
    return True


def commit_proposal(db: Session, proposal_id: str, patient_id: Optional[str] = None) -> m.ConfirmationProposal:
    from .routing import lock_patient
    identity = db.get(m.ConfirmationProposal, proposal_id)
    if not identity or (patient_id and identity.patient_id != patient_id):
        raise HTTPException(404, "Proposal not found")
    lock_patient(db, identity.patient_id)
    proposal = db.scalar(select(m.ConfirmationProposal).where(m.ConfirmationProposal.id == proposal_id).with_for_update().execution_options(populate_existing=True))
    if not proposal or (patient_id and proposal.patient_id != patient_id):
        raise HTTPException(status_code=404, detail="Proposal not found")
    if proposal.status == "committed":
        return proposal
    if proposal.status != "pending":
        raise HTTPException(status_code=409, detail="Proposal is no longer current")
    if aware(proposal.expires_at) <= utcnow():
        proposal.status = "expired"
        db.flush()
        raise HTTPException(status_code=409, detail="Proposal has expired; review it again")

    # SQLite ignores FOR UPDATE. A compare-and-set takes its write lock and also
    # serializes confirmation against cancellation/correction on both databases.
    claimed = db.execute(update(m.ConfirmationProposal).where(
        m.ConfirmationProposal.id == proposal.id, m.ConfirmationProposal.status == "pending"
    ).values(status="committing").execution_options(synchronize_session=False))
    if claimed.rowcount != 1:
        db.refresh(proposal)
        if proposal.status == "committed":
            return proposal
        raise HTTPException(status_code=409, detail="Proposal is no longer current")
    proposal.status = "committing"

    payload = proposal.payload
    record = None
    if proposal.kind == "health_note":
        for recipient_user_id in payload.get("share_with_user_ids", []):
            recipient_grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == proposal.patient_id, m.AccessGrant.user_id == recipient_user_id, m.AccessGrant.revoked_at.is_(None)))
            if not recipient_grant or (recipient_grant.expires_at and aware(recipient_grant.expires_at) <= utcnow()):
                proposal.status = "invalidated"
                proposal.invalidated_reason = "recipient_access_changed"
                db.flush()
                raise HTTPException(status_code=409, detail="Sharing access changed; review the note recipients again")
        record = m.HealthNote(
            patient_id=proposal.patient_id,
            wording=payload["wording"],
            symptom=payload.get("symptom"),
            occurrence_text=payload.get("occurrence_text"),
            occurred_at=_dt(payload.get("occurred_at")),
            timezone=payload.get("timezone"),
            proposal_id=proposal.id,
            shared_with_user_ids=payload.get("share_with_user_ids", []),
        )
        record_type = "health_note"
    elif proposal.kind == "medication_report":
        dose = db.scalar(select(m.DoseInstance).where(m.DoseInstance.id == payload["dose_instance_id"]).with_for_update().execution_options(populate_existing=True))
        plan = db.get(m.MedicationPlanVersion, dose.plan_id, populate_existing=True) if dose else None
        if not dose or dose.patient_id != proposal.patient_id or not plan or not plan.active or dose.plan_version != proposal.plan_version:
            proposal.status = "invalidated"
            proposal.invalidated_reason = "medication_plan_changed"
            db.flush()
            raise HTTPException(status_code=409, detail="Medication plan changed; identify the dose again")
        if (dose.report_state not in UPDATABLE_REPORT_STATES
                or dose.report_state != payload.get("previous_report_state", "unconfirmed")
                or dose.confirmation_proposal_id != payload.get("previous_confirmation_proposal_id")):
            proposal.status = "invalidated"
            proposal.invalidated_reason = "dose_report_changed"
            db.flush()
            raise HTTPException(status_code=409, detail="Dose report changed; review its current status again")
        dose.report_state = payload["report_state"]
        dose.report_time = utcnow()
        dose.taken_time_text = payload.get("taken_time_text")
        dose.confirmation_proposal_id = proposal.id
        for command in db.scalars(select(m.ReminderCommand).where(
                m.ReminderCommand.dose_instance_id == dose.id,
                m.ReminderCommand.delivery_state.in_(["queued", "received", "playback_started"]))):
            command.delivery_state = "playback_unknown" if command.delivery_state == "playback_started" else "cancelled"
            command.cancelled_at = utcnow()
            command.cancel_reason = "dose_reported"
        record = dose
        record_type = "medication_report"
    elif proposal.kind == "measurement":
        supersedes = None
        version = 1
        if payload.get("supersedes_id"):
            supersedes = db.scalar(select(m.Measurement).where(m.Measurement.id == payload["supersedes_id"]).with_for_update())
            if not supersedes or supersedes.patient_id != proposal.patient_id or supersedes.superseded_at:
                proposal.status = "invalidated"
                proposal.invalidated_reason = "measurement_changed"
                db.flush()
                raise HTTPException(status_code=409, detail="Measurement changed; review the correction again")
            supersedes.superseded_at = utcnow()
            version = supersedes.version + 1
            invalidate_summaries(db, proposal.patient_id, supersedes.id)
        record = m.Measurement(
            patient_id=proposal.patient_id,
            measurement_type=payload["measurement_type"],
            systolic=payload["systolic"],
            diastolic=payload["diastolic"],
            unit=payload["unit"],
            occurred_at=_dt(payload.get("occurred_at")),
            occurrence_text=payload.get("occurrence_text"),
            timezone=payload["timezone"],
            source_description=payload["source_description"],
            reporting_actor=payload["reporting_actor"],
            proposal_id=proposal.id,
            supersedes_id=supersedes.id if supersedes else None,
            version=version,
        )
        record_type = "measurement"
    elif proposal.kind == "preventive_task":
        if payload.get("task_id"):
            task = db.scalar(select(m.PreventiveTask).where(m.PreventiveTask.id == payload["task_id"]).with_for_update())
            if not task or task.patient_id != proposal.patient_id or task.state != payload["previous_state"]:
                proposal.status = "invalidated"
                proposal.invalidated_reason = "preventive_task_changed"
                db.flush()
                raise HTTPException(status_code=409, detail="Preventive task changed; review it again")
            transition = m.PreventiveTransition(
                task_id=task.id,
                from_state=task.state,
                to_state=payload["state"],
                appointment_date=_date(payload.get("appointment_date")),
                completion_date=_date(payload.get("completion_date")),
                proposal_id=proposal.id,
            )
            db.add(transition)
            task.state = payload["state"]
            if payload.get("appointment_date"):
                task.appointment_date = _date(payload["appointment_date"])
            if payload.get("completion_date"):
                task.completion_date = _date(payload["completion_date"])
            task.updated_at = utcnow()
            task.last_proposal_id = proposal.id
            task.version += 1
            invalidate_summaries(db, proposal.patient_id, task.id)
            record = task
        else:
            record = m.PreventiveTask(
                patient_id=proposal.patient_id,
                task_type=payload["task_type"],
                description=payload["description"],
                source=payload["source"],
                due_date=_date(payload["due_date"]),
                timezone=payload["timezone"],
                state=payload["state"],
                appointment_date=_date(payload.get("appointment_date")),
                completion_date=_date(payload.get("completion_date")),
                last_proposal_id=proposal.id,
            )
            db.add(record)
            db.flush()
            db.add(m.PreventiveTransition(task_id=record.id, from_state=None, to_state=record.state, appointment_date=record.appointment_date, completion_date=record.completion_date, proposal_id=proposal.id))
        record_type = "preventive_task"
    elif proposal.kind == "support_request":
        grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == proposal.patient_id, m.AccessGrant.user_id == payload["recipient_user_id"], m.AccessGrant.revoked_at.is_(None)))
        if not grant or (grant.expires_at and aware(grant.expires_at) <= utcnow()):
            proposal.status = "invalidated"
            proposal.invalidated_reason = "recipient_access_changed"
            db.flush()
            raise HTTPException(status_code=409, detail="Recipient access changed; choose a recipient again")
        record = m.SupportRequest(
            patient_id=proposal.patient_id,
            request_text=payload["request_text"],
            recipient_user_id=payload["recipient_user_id"],
            urgency=payload.get("urgency", "routine"),
            barrier_text=payload.get("barrier_text"),
            calling_route_snapshot=payload.get("calling_route"),
            proposal_id=proposal.id,
        )
        record_type = "support_request"
    elif proposal.kind == "followup":
        # The read-back is immutable. If access changed, require a new review
        # instead of silently committing its old recipients or changing them.
        try:
            current, _ = validate_payload(db, proposal.patient_id, "followup", payload, proposal.created_by_user_id)
            if current != payload:
                raise HTTPException(status_code=409, detail="Follow-up changed")
        except HTTPException as exc:
            proposal.status = "invalidated"
            proposal.invalidated_reason = "followup_access_changed"
            db.flush()
            raise HTTPException(status_code=409, detail="Follow-up access or source changed; review it again") from exc
        if payload.get("followup_id"):
            record = db.scalar(select(m.FollowUp).where(m.FollowUp.id == payload["followup_id"]).with_for_update())
            if not record or record.patient_id != proposal.patient_id or record.resolution_state != "open":
                proposal.status = "invalidated"
                proposal.invalidated_reason = "followup_changed"
                db.flush()
                raise HTTPException(status_code=409, detail="Follow-up changed; review the outcome again")
            record.reported_outcome = payload["reported_outcome"]
            record.resolution_state = "resolved"
            db.add(m.FollowUpResolution(followup_id=record.id, proposal_id=proposal.id, reported_outcome=payload["reported_outcome"]))
            invalidate_summaries(db, proposal.patient_id, record.id)
        else:
            record = m.FollowUp(
                patient_id=proposal.patient_id,
                related_type=payload["related_type"],
                related_id=payload["related_id"],
                check_at=_dt(payload["check_at"]),
                permission_scope=payload["permission_scope"],
                permitted_user_ids=payload.get("permitted_user_ids", []),
                resolution_state="open",
                proposal_id=proposal.id,
            )
        record_type = "followup"
    else:
        raise HTTPException(status_code=422, detail="Unsupported proposal kind")

    if proposal.kind != "medication_report":
        db.add(record)
    db.flush()
    proposal.status = "committed"
    proposal.confirmed_at = utcnow()
    proposal.record_type = record_type
    proposal.record_id = record.id
    invalidate_summaries(db, proposal.patient_id)
    db.add(m.AuditEvent(actor_type="system", patient_id=proposal.patient_id, action="proposal.committed", object_type=record_type, object_id=record.id, details={"proposal_id": proposal.id}))
    db.flush()
    return proposal


def explicit_confirmation(transcript: str) -> bool:
    normal = re.sub(r"[^a-z' ]", "", transcript.lower()).strip()
    normal = re.sub(r"\s+", " ", normal)
    return normal in EXPLICIT_CONFIRMATIONS


def validate_wav(data: bytes) -> int:
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000 or wav.getcomptype() != "NONE":
                raise ValueError("WAV must be mono 16-bit PCM at 16 kHz")
            frames = wav.getnframes()
            duration = frames / 16000
            if duration < 0.3 or duration > 20:
                raise ValueError("WAV duration must be between 0.3 and 20 seconds")
            if frames * 2 > 640000:
                raise ValueError("WAV PCM payload exceeds 20 seconds")
            if len(wav.readframes(frames)) != frames * 2:
                raise ValueError("WAV audio payload is truncated")
            return round(duration * 1000)
    except (wave.Error, EOFError) as exc:
        raise ValueError("Body is not a supported WAV file") from exc


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def materialize_plan_doses(db: Session, plan: m.MedicationPlanVersion, now: Optional[datetime] = None, days: int = 3) -> int:
    now = now or utcnow()
    try:
        tz = ZoneInfo(plan.timezone)
    except ZoneInfoNotFoundError:
        return 0
    medicine_map = {med["id"]: med for med in plan.medicines}
    local_now = now.astimezone(tz)
    created = 0
    for day_offset in range(0, days):
        local_day = local_now.date() + timedelta(days=day_offset)
        for schedule in plan.schedule:
            hour, minute = [int(part) for part in schedule["local_time"].split(":")]
            due = datetime.combine(local_day, time(hour, minute), tzinfo=tz).astimezone(timezone.utc)
            if due < now - timedelta(minutes=2):
                continue
            exists = db.scalar(select(m.DoseInstance.id).where(m.DoseInstance.plan_id == plan.id, m.DoseInstance.medicine_id == schedule["medicine_id"], m.DoseInstance.scheduled_at == due))
            if exists:
                continue
            med = medicine_map[schedule["medicine_id"]]
            db.add(m.DoseInstance(patient_id=plan.patient_id, plan_id=plan.id, plan_version=plan.version, medicine_id=med["id"], medicine_name=med["name"], scheduled_at=due))
            created += 1
    return created


def create_plan(db: Session, patient_id: str, user: m.User, data) -> m.MedicationPlanVersion:
    from .routing import lock_patient
    lock_patient(db, patient_id)
    try:
        tz = ZoneInfo(data.timezone)
    except ZoneInfoNotFoundError:
        raise HTTPException(status_code=422, detail="Unknown medication plan timezone")
    active = db.scalars(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.patient_id == patient_id, m.MedicationPlanVersion.active.is_(True))).all()
    latest = db.scalar(select(func.max(m.MedicationPlanVersion.version)).where(m.MedicationPlanVersion.patient_id == patient_id)) or 0
    now = utcnow()
    for old in active:
        old.active = False
        commands = db.scalars(
            select(m.ReminderCommand)
            .join(m.DoseInstance, m.ReminderCommand.dose_instance_id == m.DoseInstance.id)
            .where(m.DoseInstance.plan_id == old.id, m.ReminderCommand.delivery_state.in_(["queued", "received"]))
        ).all()
        for command in commands:
            command.cancelled_at = now
            command.delivery_state = "cancelled"
            command.cancel_reason = "plan_changed"
    plan = m.MedicationPlanVersion(
        patient_id=patient_id,
        version=latest + 1,
        timezone=data.timezone,
        source=data.source,
        checked_by_user_id=user.id,
        checked_by_name=user.name,
        medicines=[item.model_dump() for item in data.medicines],
        schedule=[item.model_dump() for item in data.schedule],
    )
    db.add(plan)
    db.flush()
    materialize_plan_doses(db, plan, now=now)
    db.add(m.AuditEvent(actor_type="user", actor_id=user.id, patient_id=patient_id, action="medication_plan.activated", object_type="medication_plan", object_id=plan.id, details={"version": plan.version}))
    return plan


def plan_dict(plan: m.MedicationPlanVersion) -> dict:
    return {"id": plan.id, "version": plan.version, "timezone": plan.timezone, "source": plan.source, "checked_by": plan.checked_by_name, "checked_at": iso(plan.checked_at), "active": plan.active, "medicines": plan.medicines, "schedule": plan.schedule}


def make_summary(db: Session, patient_id: str, start_date: date, end_date: date, user_id: str,
                 purpose: str = "doctor_visit", questions: Optional[list[str]] = None) -> m.VisitSummary:
    patient = db.get(m.Patient, patient_id)
    grant, scopes = grant_scopes(db, user_id, patient_id)
    all_access = "*" in scopes
    def collection_allowed(name: str) -> bool:
        return all_access or "read:dashboard" in scopes or ("read:%s" % name) in scopes
    try:
        patient_tz = ZoneInfo(patient.timezone)
    except ZoneInfoNotFoundError:
        raise HTTPException(status_code=422, detail="Patient timezone is invalid")
    start_dt = datetime.combine(start_date, time.min, tzinfo=patient_tz).astimezone(timezone.utc)
    end_dt = datetime.combine(end_date, time.max, tzinfo=patient_tz).astimezone(timezone.utc)
    sections = []
    refs = []

    all_notes = db.scalars(select(m.HealthNote).where(m.HealthNote.patient_id == patient_id, m.HealthNote.deleted_at.is_(None))).all()
    notes = [item for item in all_notes if collection_allowed("notes") and (all_access or user_id in (item.shared_with_user_ids or [])) and start_dt <= aware(item.occurred_at or item.created_at) <= end_dt]
    if notes:
        items = []
        for item in notes:
            occurred = iso(item.occurred_at) or item.occurrence_text or "occurrence time unknown"
            items.append({"text": "Patient reported: %s (occurrence: %s; recorded: %s)." % (item.wording, occurred, iso(item.created_at)), "source_id": item.id})
            refs.append({"type": "health_note", "id": item.id, "version": item.version})
        sections.append({"title": "Reported health notes", "items": items})

    all_measurements = db.scalars(select(m.Measurement).where(m.Measurement.patient_id == patient_id, m.Measurement.superseded_at.is_(None))).all()
    measurements = [item for item in all_measurements if collection_allowed("measurements") and start_dt <= aware(item.occurred_at or item.created_at) <= end_dt]
    if measurements:
        items = []
        for item in measurements:
            when = iso(item.occurred_at) or item.occurrence_text
            items.append({"text": "Patient reported an external blood pressure reading of %d/%d %s (%s), source: %s; recorded: %s." % (item.systolic, item.diastolic, item.unit, when, item.source_description, iso(item.created_at)), "source_id": item.id})
            refs.append({"type": "measurement", "id": item.id, "version": item.version})
        sections.append({"title": "Reported measurements", "items": items})

    doses = db.scalars(select(m.DoseInstance).where(m.DoseInstance.patient_id == patient_id, m.DoseInstance.scheduled_at.between(start_dt, end_dt))).all() if collection_allowed("medications") else []
    if doses:
        items = []
        for item in doses:
            items.append({"text": "%s scheduled %s: %s; report recorded %s." % (item.medicine_name, iso(item.scheduled_at), item.report_state.replace("_", " "), iso(item.report_time) or "not reported"), "source_id": item.id})
            refs.append({"type": "medication_report", "id": item.id, "version": item.plan_version})
        sections.append({"title": "Medication reports", "items": items})

    tasks = db.scalars(select(m.PreventiveTask).where(m.PreventiveTask.patient_id == patient_id)).all() if collection_allowed("preventive_tasks") else []
    if tasks:
        items = []
        for item in tasks:
            items.append({"text": "%s is currently %s (care-plan source: %s; due: %s; appointment: %s; completion: %s)." % (item.description, item.state, item.source, iso(item.due_date), iso(item.appointment_date) or "unknown", iso(item.completion_date) or "unknown"), "source_id": item.id})
            refs.append({"type": "preventive_task", "id": item.id, "version": item.version})
        sections.append({"title": "Current preventive care context at summary generation", "items": items})

    supports = db.scalars(select(m.SupportRequest).where(m.SupportRequest.patient_id == patient_id, m.SupportRequest.status != "resolved", m.SupportRequest.created_at.between(start_dt, end_dt))).all() if collection_allowed("support") else []
    followups = db.scalars(select(m.FollowUp).where(m.FollowUp.patient_id == patient_id, m.FollowUp.resolution_state == "open")).all() if collection_allowed("followups") else []
    if not all_access:
        supports = [item for item in supports if item.recipient_user_id == user_id]
        followups = [item for item in followups if user_id in (item.permitted_user_ids or [])]
    if supports or followups:
        items = []
        for item in supports:
            wording = "Unresolved support request recorded %s: %s." % (iso(item.created_at), item.request_text)
            if item.barrier_text:
                wording += " Reported difficulty: %s." % item.barrier_text
            items.append({"text": wording, "source_id": item.id})
            refs.append({"type": "support_request", "id": item.id, "version": 1})
        for item in followups:
            items.append({"text": "Follow-up remains open for %s, with a check recorded for %s." % (item.related_type, iso(item.check_at)), "source_id": item.id})
            refs.append({"type": "followup", "id": item.id, "version": 1})
        sections.append({"title": "Unresolved support and follow-up", "items": items})

    user = db.get(m.User, user_id)
    authored_at = utcnow()
    authored = [{"text": text, "author_id": user_id, "author_display_name": user.name,
                 "authored_at": authored_at} for text in (questions or [])]
    summary = m.VisitSummary(
        patient_id=patient_id, start_date=start_date, end_date=end_date,
        purpose=purpose, template_version=SUMMARY_TEMPLATE_VERSION,
        sections=present_summary(purpose, sections, authored), source_refs=refs,
        questions=[{**question, "authored_at": iso(authored_at)} for question in authored],
        created_by_user_id=user_id,
    )
    db.add(summary)
    db.flush()
    return summary


def summary_dict(summary: m.VisitSummary, public: bool = False) -> dict:
    omitted = set(summary.omitted_source_ids or [])
    questions = summary.questions or []
    def public_name(value: str) -> str:
        if not value or "@" in value or re.search(r"(?:usr_[0-9a-f]{32}|\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b)", value, re.I):
            return "Author"
        return value
    if public:
        visible_questions = [{"text": question.get("text", ""),
                              "author_display_name": public_name(question.get("author_display_name", "")),
                              "authored_at": question.get("authored_at")} for question in questions]
        visible_sections = []
        for section in summary.sections or []:
            if section.get("kind") == "authored_questions":
                visible_sections.append({"kind": "authored_questions", "title": section.get("title", "Authored questions"),
                                         "items": [{"text": item.get("text", ""),
                                                    "author_display_name": public_name(item.get("author_display_name", "")),
                                                    "authored_at": item.get("authored_at")} for item in section.get("items", [])]})
            else:
                visible_sections.append({"title": section.get("title", "Care reports"),
                                         "items": [{"text": item.get("text", ""),
                                                    **({"source_id": item["source_id"]} if item.get("source_id") else {})}
                                                   for item in section.get("items", [])]})
    else:
        visible_questions = questions
        visible_sections = summary.sections
    result = {"id": summary.id, "start_date": iso(summary.start_date), "end_date": iso(summary.end_date),
              "purpose": summary.purpose or "doctor_visit", "template_version": summary.template_version or 1,
              "questions": visible_questions,
              "sections": visible_sections,
              "sources": [ref for ref in (summary.source_refs or []) if ref["id"] not in omitted],
              "status": summary.status, "created_at": iso(summary.created_at),
              "reviewed_at": iso(summary.reviewed_at), "invalidated_at": iso(summary.invalidated_at)}
    if not public:
        result["patient_id"] = summary.patient_id
        result["omitted_source_ids"] = summary.omitted_source_ids
    return result


def _dt(value):
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _date(value):
    if value is None or isinstance(value, date):
        return value
    return date.fromisoformat(value)
