from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy import JSON
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return "%s_%s" % (prefix, uuid4().hex)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("usr"))
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(40), default="caregiver")
    password_hash: Mapped[str] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Patient(Base):
    __tablename__ = "patients"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("pat"))
    name: Mapped[str] = mapped_column(String(200))
    preferred_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    timezone: Mapped[str] = mapped_column(String(80))
    language: Mapped[str] = mapped_column(String(20), default="en")
    daily_check_in_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    daily_check_in_local_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)
    calling_route: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)


class AccessGrant(Base):
    __tablename__ = "access_grants"
    __table_args__ = (UniqueConstraint("user_id", "patient_id", name="uq_user_patient_grant"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("grant"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    relationship: Mapped[str] = mapped_column(String(40), default="caregiver")
    scopes: Mapped[list] = mapped_column(JSON, default=list)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class BrowserSession(Base):
    __tablename__ = "browser_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("sess"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    csrf_token: Mapped[str] = mapped_column(String(80))
    csrf_hash: Mapped[str] = mapped_column(String(64))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("dev"))
    credential_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    credential_version: Mapped[int] = mapped_column(Integer, default=1)
    patient_id: Mapped[Optional[str]] = mapped_column(ForeignKey("patients.id"), nullable=True, index=True)
    claim_code_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    claim_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    claimed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    battery_mv: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    rssi: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    firmware_version: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    capabilities: Mapped[list] = mapped_column(JSON, default=list)
    device_type: Mapped[str] = mapped_column(String(20), default="pendant", server_default="pendant")
    platform: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    display_name: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)


class PhoneEnrollment(Base):
    __tablename__ = "phone_enrollments"
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(36), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CompanionRoute(Base):
    __tablename__ = "companion_routes"
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), primary_key=True)
    active_device_id: Mapped[Optional[str]] = mapped_column(ForeignKey("devices.id"), nullable=True)
    generation: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MedicationPlanVersion(Base):
    __tablename__ = "medication_plan_versions"
    __table_args__ = (UniqueConstraint("patient_id", "version", name="uq_patient_plan_version"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("plan"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    timezone: Mapped[str] = mapped_column(String(80))
    source: Mapped[str] = mapped_column(Text)
    checked_by_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    checked_by_name: Mapped[str] = mapped_column(String(200))
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    medicines: Mapped[list] = mapped_column(JSON)
    schedule: Mapped[list] = mapped_column(JSON)


class DoseInstance(Base):
    __tablename__ = "dose_instances"
    __table_args__ = (UniqueConstraint("plan_id", "medicine_id", "scheduled_at", name="uq_plan_medicine_due"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("dose"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("medication_plan_versions.id"), index=True)
    plan_version: Mapped[int] = mapped_column(Integer)
    medicine_id: Mapped[str] = mapped_column(String(100))
    medicine_name: Mapped[str] = mapped_column(String(200))
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    report_state: Mapped[str] = mapped_column(String(40), default="unconfirmed")
    report_time: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    taken_time_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    confirmation_proposal_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)


class AudioAsset(Base):
    __tablename__ = "audio_assets"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("audio"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    wav_bytes: Mapped[bytes] = mapped_column(LargeBinary)
    context_guard: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    content_sha256: Mapped[str] = mapped_column(String(64))
    duration_ms: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class VoiceTurn(Base):
    __tablename__ = "voice_turns"
    __table_args__ = (UniqueConstraint("device_id", "idempotency_key", name="uq_device_turn_key"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("turn"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(36))
    content_sha256: Mapped[str] = mapped_column(String(64))
    context_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    capture_intent: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    status: Mapped[str] = mapped_column(String(40), default="accepted")
    transcript: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    raw_audio: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    processing_error: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    processing_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class ConfirmationProposal(Base):
    __tablename__ = "confirmation_proposals"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("prop"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON)
    readback: Mapped[str] = mapped_column(Text)
    context_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=lambda: new_id("ctx"))
    status: Mapped[str] = mapped_column(String(40), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_by_user_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id"), nullable=True)
    source_turn_id: Mapped[Optional[str]] = mapped_column(ForeignKey("voice_turns.id"), nullable=True)
    replaces_proposal_id: Mapped[Optional[str]] = mapped_column(ForeignKey("confirmation_proposals.id"), nullable=True)
    invalidated_reason: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    plan_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    record_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    record_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)


class HealthNote(Base):
    __tablename__ = "health_notes"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("note"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    wording: Mapped[str] = mapped_column(Text)
    symptom: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    occurrence_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    timezone: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("confirmation_proposals.id"), unique=True)
    shared_with_user_ids: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)


class Measurement(Base):
    __tablename__ = "measurements"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("measurement"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    measurement_type: Mapped[str] = mapped_column(String(50))
    systolic: Mapped[int] = mapped_column(Integer)
    diastolic: Mapped[int] = mapped_column(Integer)
    unit: Mapped[str] = mapped_column(String(20))
    occurred_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    occurrence_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    timezone: Mapped[str] = mapped_column(String(80))
    source_description: Mapped[str] = mapped_column(Text)
    reporting_actor: Mapped[str] = mapped_column(String(100))
    proposal_id: Mapped[str] = mapped_column(ForeignKey("confirmation_proposals.id"), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    supersedes_id: Mapped[Optional[str]] = mapped_column(ForeignKey("measurements.id"), nullable=True)
    superseded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)


class PreventiveTask(Base):
    __tablename__ = "preventive_tasks"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("task"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    task_type: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)
    due_date: Mapped[datetime] = mapped_column(Date)
    timezone: Mapped[str] = mapped_column(String(80))
    state: Mapped[str] = mapped_column(String(40))
    appointment_date: Mapped[Optional[datetime]] = mapped_column(Date, nullable=True)
    completion_date: Mapped[Optional[datetime]] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_proposal_id: Mapped[str] = mapped_column(ForeignKey("confirmation_proposals.id"))
    version: Mapped[int] = mapped_column(Integer, default=1)


class PreventiveTransition(Base):
    __tablename__ = "preventive_transitions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("transition"))
    task_id: Mapped[str] = mapped_column(ForeignKey("preventive_tasks.id"), index=True)
    from_state: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    to_state: Mapped[str] = mapped_column(String(40))
    appointment_date: Mapped[Optional[datetime]] = mapped_column(Date, nullable=True)
    completion_date: Mapped[Optional[datetime]] = mapped_column(Date, nullable=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("confirmation_proposals.id"), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SupportRequest(Base):
    __tablename__ = "support_requests"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("support"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    request_text: Mapped[str] = mapped_column(Text)
    recipient_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    urgency: Mapped[str] = mapped_column(String(20), default="routine")
    barrier_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    calling_route_snapshot: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="sent")
    proposal_id: Mapped[str] = mapped_column(ForeignKey("confirmation_proposals.id"), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    outcome: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class FollowUp(Base):
    __tablename__ = "followups"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("followup"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    related_type: Mapped[str] = mapped_column(String(50))
    related_id: Mapped[str] = mapped_column(String(64))
    check_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    permission_scope: Mapped[str] = mapped_column(String(100))
    permitted_user_ids: Mapped[list] = mapped_column(JSON, default=list)
    reported_outcome: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    resolution_state: Mapped[str] = mapped_column(String(30), default="open")
    proposal_id: Mapped[str] = mapped_column(ForeignKey("confirmation_proposals.id"), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FollowUpResolution(Base):
    __tablename__ = "followup_resolutions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("followup_resolution"))
    followup_id: Mapped[str] = mapped_column(ForeignKey("followups.id"), index=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("confirmation_proposals.id"), unique=True)
    reported_outcome: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ReminderOccurrence(Base):
    __tablename__ = "reminder_occurrences"
    __table_args__ = (UniqueConstraint("patient_id", "kind", "local_date", name="uq_checkin_occurrence"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("occ"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    dose_instance_id: Mapped[Optional[str]] = mapped_column(ForeignKey("dose_instances.id"), unique=True, nullable=True)
    local_date: Mapped[Optional[datetime]] = mapped_column(Date, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ReminderCommand(Base):
    __tablename__ = "reminder_commands"
    __table_args__ = (UniqueConstraint("occurrence_id", "route_generation", name="uq_reminder_route_attempt"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("cmd"))
    event_id: Mapped[str] = mapped_column(String(64), unique=True, default=lambda: new_id("evt"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    dose_instance_id: Mapped[str] = mapped_column(ForeignKey("dose_instances.id"), index=True)
    occurrence_id: Mapped[str] = mapped_column(ForeignKey("reminder_occurrences.id"), index=True)
    route_generation: Mapped[int] = mapped_column(Integer)
    audio_accessed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_reason: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    plan_version: Mapped[int] = mapped_column(Integer)
    context_id: Mapped[str] = mapped_column(String(64), unique=True, default=lambda: new_id("ctx"))
    audio_asset_id: Mapped[str] = mapped_column(ForeignKey("audio_assets.id"))
    delivery_state: Mapped[str] = mapped_column(String(40), default="queued")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class ReminderAck(Base):
    __tablename__ = "reminder_acks"
    __table_args__ = (UniqueConstraint("device_id", "ack_id", name="uq_device_ack"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("ackrow"))
    ack_id: Mapped[str] = mapped_column(String(36))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    # Check-ins and medication reminders share the acknowledgement transport.
    # The referenced command type is resolved and ownership-checked by the API.
    command_id: Mapped[str] = mapped_column(String(64), index=True)
    stage: Mapped[str] = mapped_column(String(40))
    device_time: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CheckInDelivery(Base):
    __tablename__ = "checkin_deliveries"
    __table_args__ = (UniqueConstraint("occurrence_id", "route_generation", name="uq_checkin_route_attempt"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("checkin"))
    event_id: Mapped[str] = mapped_column(String(64), unique=True, default=lambda: new_id("evt"))
    device_id: Mapped[Optional[str]] = mapped_column(ForeignKey("devices.id"), nullable=True, index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    occurrence_id: Mapped[str] = mapped_column(ForeignKey("reminder_occurrences.id"), index=True)
    route_generation: Mapped[int] = mapped_column(Integer)
    audio_accessed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_reason: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    local_date: Mapped[datetime] = mapped_column(Date)
    context_id: Mapped[str] = mapped_column(String(64), unique=True, default=lambda: new_id("ctx"))
    greeting_text: Mapped[str] = mapped_column(Text)
    audio_asset_ids: Mapped[list] = mapped_column(JSON, default=list)
    delivery_state: Mapped[str] = mapped_column(String(40), default="queued")
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class DeviceEvent(Base):
    __tablename__ = "device_events"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("evt"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(50))
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class VisitSummary(Base):
    __tablename__ = "visit_summaries"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("summary"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    start_date: Mapped[datetime] = mapped_column(Date)
    end_date: Mapped[datetime] = mapped_column(Date)
    sections: Mapped[list] = mapped_column(JSON)
    source_refs: Mapped[list] = mapped_column(JSON)
    omitted_source_ids: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(30), default="draft")
    created_by_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    invalidated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class SummaryShare(Base):
    __tablename__ = "summary_shares"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("share"))
    summary_id: Mapped[str] = mapped_column(ForeignKey("visit_summaries.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("audit"))
    actor_type: Mapped[str] = mapped_column(String(30))
    actor_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    patient_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(100), index=True)
    object_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    object_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class PhoneState(Base):
    __tablename__ = 'phone_states'
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'), primary_key=True)
    lifecycle: Mapped[str] = mapped_column(String(20), default='unknown')
    microphone_permission: Mapped[str] = mapped_column(String(20), default='unknown')
    notification_permission: Mapped[str] = mapped_column(String(20), default='unknown')
    reported_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    scheduled_until: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    schedule_revision: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    push_token: Mapped[Optional[str]] = mapped_column(String(240), nullable=True, unique=True)
    push_version: Mapped[int] = mapped_column(Integer, default=0)
    push_disabled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    push_snapshot: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


class NotificationEvidence(Base):
    __tablename__ = 'notification_evidence'
    __table_args__ = (UniqueConstraint('device_id', 'event_id', name='uq_notification_evidence'),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id('notice'))
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'), index=True)
    event_id: Mapped[str] = mapped_column(String(36))
    identity: Mapped[str] = mapped_column(String(160))
    stage: Mapped[str] = mapped_column(String(30))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PushHint(Base):
    __tablename__ = 'push_hints'
    __table_args__ = (UniqueConstraint('device_id', 'fingerprint', name='uq_push_hint'),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id('push'))
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'), index=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    route_generation: Mapped[int] = mapped_column(Integer)
    push_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(30), default='pending', index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    ticket_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    error_code: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
