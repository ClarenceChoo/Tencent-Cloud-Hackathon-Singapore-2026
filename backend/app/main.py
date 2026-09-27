import asyncio
import json
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Dict, Optional, Set
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models as m
from .config import Settings, get_settings
from .database import Database
from .device_setup import device_status, service_readiness, PROTOCOL
from .phone import EnrollmentLimiter, router as phone_router
from .routing import choose_target, current_attempt, lock_patient, route_view
from .schemas import (
    ActiveCompanionSelect,
    DeviceAck,
    DeviceClaim,
    GrantCreate,
    Heartbeat,
    LoginRequest,
    MedicationPlanCreate,
    NoteSharingUpdate,
    PatientProfileUpdate,
    ProposalConfirm,
    ProposalCreate,
    ProposalRevise,
    ResolveRequest,
    SummaryCreate,
    SummaryShareCreate,
    SummaryUpdate,
)
from .security import (
    authenticate_device_header,
    authenticate_device_websocket,
    aware,
    get_browser_session,
    grant_scopes,
    iso,
    new_secret,
    require_allowed_origin,
    require_csrf,
    require_scope,
    sha256,
    utcnow,
    verify_password,
)
from .services import (
    commit_proposal,
    create_plan,
    create_proposal,
    invalidate_summaries,
    make_summary,
    plan_dict,
    proposal_dict,
    sha_bytes,
    summary_dict,
    summary_sources_current,
    validate_wav,
)
from .worker import checkin_envelope, command_envelope, event_envelope, process_turn, scheduler_loop


DEVICE_JSON_MAX_BYTES = 16 * 1024
MISSING_CALLING_ROUTE = "No calling route is configured. Use your usual local support or emergency contact method."


class SocketRegistry:
    def __init__(self):
        self.connections: Dict[str, Set[WebSocket]] = {}
        self.heartbeats: Dict[WebSocket, datetime] = {}

    def add(self, device_id: str, websocket: WebSocket) -> None:
        self.connections.setdefault(device_id, set()).add(websocket)

    def remove(self, device_id: str, websocket: WebSocket) -> None:
        self.connections.get(device_id, set()).discard(websocket)
        self.heartbeats.pop(websocket, None)

    def heartbeat(self, websocket: WebSocket) -> None:
        self.heartbeats[websocket] = utcnow()

    def active_ids(self) -> set[str]:
        cutoff = utcnow() - timedelta(seconds=PROTOCOL['offline_after_seconds'])
        connections = [(key, tuple(value)) for key, value in list(self.connections.items())]
        return {key for key, sockets in connections if any(
            (seen := self.heartbeats.get(socket)) is not None and seen >= cutoff
            for socket in sockets)}

    async def close_device(self, device_id: str) -> None:
        sockets = list(self.connections.pop(device_id, set()))
        for websocket in sockets:
            self.heartbeats.pop(websocket, None)
            try:
                await websocket.close(code=4403, reason="Device revoked")
            except Exception:
                pass


def get_db(request: Request):
    db = request.app.state.db.SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _human(request: Request, db: Session):
    return get_browser_session(request, db)


def _patient_access(request: Request, db: Session, patient_id: str, *scopes: str):
    user, browser_session = _human(request, db)
    grant, available = grant_scopes(db, user.id, patient_id)
    if scopes:
        require_scope(available, *scopes)
    return user, browser_session, grant, available


def _session_body(db: Session, user: m.User, browser_session: m.BrowserSession) -> dict:
    grants = db.scalars(select(m.AccessGrant).where(m.AccessGrant.user_id == user.id, m.AccessGrant.revoked_at.is_(None))).all()
    patients = []
    for grant in grants:
        if grant.expires_at and aware(grant.expires_at) <= utcnow():
            continue
        patient = db.get(m.Patient, grant.patient_id)
        if patient:
            patients.append({"id": patient.id, "name": patient.name, "timezone": patient.timezone})
    return {"user": {"id": user.id, "name": user.name, "email": user.email, "role": user.role}, "patients": patients, "csrf_token": browser_session.csrf_token}


def _proposal_visible(proposal: m.ConfirmationProposal, user_id: str, scopes: list) -> bool:
    if "*" in scopes or proposal.created_by_user_id == user_id:
        return True
    payload = proposal.payload or {}
    if proposal.kind == "health_note":
        return user_id in payload.get("share_with_user_ids", [])
    if proposal.kind == "support_request":
        return payload.get("recipient_user_id") == user_id
    if proposal.kind == "followup":
        return user_id in payload.get("permitted_user_ids", [])
    return False


def _dashboard(db: Session, patient: m.Patient, scopes: list, viewer_user_id: str, connected_ids: set[str]) -> dict:
    all_access = "*" in scopes or "read:dashboard" in scopes

    def allowed(name: str) -> bool:
        return all_access or ("read:%s" % name) in scopes

    now = utcnow()
    devices = db.scalars(select(m.Device).where(m.Device.patient_id == patient.id)).all() if allowed("devices") else []
    plans = db.scalars(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.patient_id == patient.id).order_by(m.MedicationPlanVersion.version.desc())).all() if allowed("medications") else []
    doses = db.scalars(select(m.DoseInstance).where(m.DoseInstance.patient_id == patient.id).order_by(m.DoseInstance.scheduled_at.desc()).limit(100)).all() if allowed("medications") else []
    dose_ids = [item.id for item in doses]
    commands = db.scalars(select(m.ReminderCommand).where(m.ReminderCommand.dose_instance_id.in_(dose_ids)).order_by(m.ReminderCommand.created_at)).all() if dose_ids else []
    command_by_dose = {item.dose_instance_id: item for item in commands}
    notes = db.scalars(select(m.HealthNote).where(m.HealthNote.patient_id == patient.id, m.HealthNote.deleted_at.is_(None)).order_by(m.HealthNote.created_at.desc())).all() if allowed("notes") else []
    if "*" not in scopes:
        notes = [item for item in notes if viewer_user_id in (item.shared_with_user_ids or [])]
    measurements = db.scalars(select(m.Measurement).where(m.Measurement.patient_id == patient.id, m.Measurement.superseded_at.is_(None)).order_by(m.Measurement.created_at.desc())).all() if allowed("measurements") else []
    tasks = db.scalars(select(m.PreventiveTask).where(m.PreventiveTask.patient_id == patient.id).order_by(m.PreventiveTask.due_date)).all() if allowed("preventive_tasks") else []
    supports = db.scalars(select(m.SupportRequest).where(m.SupportRequest.patient_id == patient.id).order_by(m.SupportRequest.created_at.desc())).all() if allowed("support") else []
    followups = db.scalars(select(m.FollowUp).where(m.FollowUp.patient_id == patient.id).order_by(m.FollowUp.check_at)).all() if allowed("followups") else []
    checkin_occurrences = db.scalars(select(m.ReminderOccurrence).where(m.ReminderOccurrence.patient_id == patient.id,
        m.ReminderOccurrence.kind == "checkin").order_by(m.ReminderOccurrence.local_date.desc()).limit(31)).all() if allowed("devices") else []
    checkin_attempts = db.scalars(select(m.CheckInDelivery).where(m.CheckInDelivery.occurrence_id.in_(
        [o.id for o in checkin_occurrences])).order_by(m.CheckInDelivery.created_at)).all() if checkin_occurrences else []

    def attempt_view(item):
        return {"id": item.id, "device_id": item.device_id, "occurrence_id": item.occurrence_id,
                "route_generation": item.route_generation, "delivery_state": item.delivery_state,
                "audio_accessed_at": iso(item.audio_accessed_at), "cancel_reason": item.cancel_reason,
                "created_at": iso(item.created_at)}

    checkins = []
    for occurrence in checkin_occurrences:
        attempts = [item for item in checkin_attempts if item.occurrence_id == occurrence.id]
        checkins.append({"id": occurrence.id, "local_date": iso(occurrence.local_date),
                         "due_at": iso(aware(occurrence.expires_at) - timedelta(minutes=30)),
                         "delivery_state": attempts[-1].delivery_state if attempts else "not_queued",
                         "created_at": iso(occurrence.created_at), "delivery_attempts": [attempt_view(a) for a in attempts]})
    if "*" not in scopes:
        supports = [item for item in supports if item.recipient_user_id == viewer_user_id]
        followups = [item for item in followups if viewer_user_id in (item.permitted_user_ids or [])]
    proposals = db.scalars(select(m.ConfirmationProposal).where(m.ConfirmationProposal.patient_id == patient.id, m.ConfirmationProposal.status == "pending").order_by(m.ConfirmationProposal.created_at.desc())).all() if ("*" in scopes or "read:proposals" in scopes) else []
    if "*" not in scopes:
        proposals = [item for item in proposals if _proposal_visible(item, viewer_user_id, scopes)]
    summaries = db.scalars(select(m.VisitSummary).where(m.VisitSummary.patient_id == patient.id).order_by(m.VisitSummary.created_at.desc())).all() if ("*" in scopes or "manage:sharing" in scopes) else []
    summary_rows = []
    for summary in summaries:
        value = summary_dict(summary)
        active_share = None
        if summary.status == "reviewed" and not summary.invalidated_at and summary_sources_current(db, summary):
            active_share = db.scalar(select(m.SummaryShare).where(m.SummaryShare.summary_id == summary.id, m.SummaryShare.revoked_at.is_(None), m.SummaryShare.expires_at > now).order_by(m.SummaryShare.expires_at.desc()))
        value["share_active"] = bool(active_share)
        value["share_expires_at"] = iso(active_share.expires_at) if active_share else None
        summary_rows.append(value)
    grants = []
    if "*" in scopes or "manage:sharing" in scopes:
        rows = db.execute(select(m.AccessGrant, m.User).join(m.User, m.User.id == m.AccessGrant.user_id).where(m.AccessGrant.patient_id == patient.id, m.AccessGrant.revoked_at.is_(None))).all()
        grants = [{"id": grant.id, "user": {"id": user.id, "name": user.name, "email": user.email}, "relationship": grant.relationship, "scopes": grant.scopes, "expires_at": iso(grant.expires_at)} for grant, user in rows]
    allowed_recipients = []
    if "*" in scopes or "write:care" in scopes:
        recipient_rows = db.execute(select(m.AccessGrant, m.User).join(m.User, m.User.id == m.AccessGrant.user_id).where(m.AccessGrant.patient_id == patient.id, m.AccessGrant.revoked_at.is_(None), m.User.active.is_(True))).all()
        allowed_recipients = [{"id": recipient.id, "name": recipient.name, "relationship": access.relationship} for access, recipient in recipient_rows if not access.expires_at or aware(access.expires_at) > now]

    from .provenance import CareEvidence
    # Visibility has already been filtered; metadata never widens record access.
    evidence = CareEvidence(db, patient.id, doses=doses, notes=notes, measurements=measurements,
                            tasks=tasks, supports=supports, followups=followups)

    return {
        "patient": {"id": patient.id, "name": patient.name, "preferred_name": patient.preferred_name, "timezone": patient.timezone, "language": patient.language, "daily_check_in_enabled": patient.daily_check_in_enabled, "daily_check_in_local_time": patient.daily_check_in_local_time, "calling_route": patient.calling_route},
        "devices": [device_status(item, connected_ids, db.get(m.PhoneState,item.id), route_view(db,patient.id)["device_id"]==item.id) for item in devices],
        "active_companion": route_view(db, patient.id) if allowed("devices") else None,
        "medication_plans": [plan_dict(item) for item in plans],
        "doses": [{"id": item.id, "plan_version": item.plan_version, "medicine_id": item.medicine_id, "medicine_name": item.medicine_name, "scheduled_at": iso(item.scheduled_at), "delivery_state": command_by_dose[item.id].delivery_state if item.id in command_by_dose else "not_queued", "delivery_attempts": [attempt_view(a) for a in commands if a.dose_instance_id == item.id], "report_state": item.report_state, "report_time": iso(item.report_time), "taken_time_text": item.taken_time_text, "provenance": evidence.source(item.confirmation_proposal_id), "report_history": evidence.reports[item.id]} for item in doses],
        "notes": [{"id": item.id, "wording": item.wording, "symptom": item.symptom, "occurrence_text": item.occurrence_text, "occurred_at": iso(item.occurred_at), "timezone": item.timezone, "created_at": iso(item.created_at), "shared_with_user_ids": item.shared_with_user_ids if "*" in scopes or "manage:sharing" in scopes else [viewer_user_id], "version": item.version, "provenance": evidence.source(item.proposal_id)} for item in notes],
        "measurements": [{"id": item.id, "measurement_type": item.measurement_type, "systolic": item.systolic, "diastolic": item.diastolic, "unit": item.unit, "occurred_at": iso(item.occurred_at), "occurrence_text": item.occurrence_text, "timezone": item.timezone, "source_description": item.source_description, "reporting_actor": item.reporting_actor, "created_at": iso(item.created_at), "supersedes_id": item.supersedes_id, "version": item.version, "provenance": evidence.source(item.proposal_id)} for item in measurements],
        "preventive_tasks": [{"id": item.id, "task_type": item.task_type, "description": item.description, "source": item.source, "due_date": iso(item.due_date), "timezone": item.timezone, "state": item.state, "appointment_date": iso(item.appointment_date), "completion_date": iso(item.completion_date), "version": item.version, "created_at": iso(item.created_at), "updated_at": iso(item.updated_at), "provenance": evidence.source(item.last_proposal_id), "transitions": evidence.transitions[item.id]} for item in tasks],
        "support_requests": [{"id": item.id, "request_text": item.request_text, "recipient_user_id": item.recipient_user_id, "urgency": item.urgency, "barrier_text": item.barrier_text, "calling_route": item.calling_route_snapshot or (MISSING_CALLING_ROUTE if item.urgency == "urgent" else None), "calling_route_configured": bool(item.calling_route_snapshot), "status": item.status, "created_at": iso(item.created_at), "acknowledged_at": iso(item.acknowledged_at), "resolved_at": iso(item.resolved_at), "outcome": item.outcome, "provenance": evidence.source(item.proposal_id)} for item in supports],
        "followups": [{"id": item.id, "related_type": item.related_type, "related_id": item.related_id, "check_at": iso(item.check_at), "permission_scope": item.permission_scope, "permitted_user_ids": item.permitted_user_ids if "*" in scopes else [viewer_user_id], "reported_outcome": item.reported_outcome, "resolution_state": item.resolution_state, "created_at": iso(item.created_at), "provenance": evidence.source(item.proposal_id), "resolutions": evidence.resolutions[item.id]} for item in followups],
        "check_ins": checkins,
        "proposals": [proposal_dict(item) for item in proposals],
        "summaries": summary_rows,
        "access_grants": grants,
        "allowed_recipients": allowed_recipients,
        "permissions": scopes,
    }


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.db.create_all()
        task = None
        notification_task = None
        if app.state.settings.scheduler_enabled:
            task = asyncio.create_task(scheduler_loop(app))
            from .notifications import notification_loop
            notification_task = asyncio.create_task(notification_loop(app))
        yield
        if notification_task:
            notification_task.cancel()
            try: await notification_task
            except asyncio.CancelledError: pass
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    app = FastAPI(title="CareLoop API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.db = Database(settings.database_url)
    app.state.sockets = SocketRegistry()
    app.state.phone_limiter = EnrollmentLimiter()
    app.include_router(phone_router)
    from .notification_api import router as notification_router
    app.include_router(notification_router)
    app.state.fixture_transcripts = {} if settings.testing else None
    app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_credentials=True, allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type", "X-CSRF-Token", "Idempotency-Key", "X-Context-Id", "Authorization"])

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.post("/v1/auth/login")
    def login(data: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
        require_allowed_origin(request)
        user = db.scalar(select(m.User).where(func.lower(m.User.email) == data.email.strip().lower()))
        if not user or not user.active or not verify_password(data.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Email or password is incorrect")
        token, csrf = new_secret(), new_secret()
        row = m.BrowserSession(token_hash=sha256(token), csrf_token=csrf, csrf_hash=sha256(csrf), user_id=user.id, expires_at=utcnow() + timedelta(hours=settings.session_ttl_hours))
        db.add(row)
        db.commit()
        response.set_cookie("careloop_session", token, httponly=True, secure=settings.cookie_secure, samesite="lax", max_age=settings.session_ttl_hours * 3600, path="/")
        return _session_body(db, user, row)

    @app.get("/v1/auth/session")
    def session(request: Request, db: Session = Depends(get_db)):
        user, row = _human(request, db)
        return _session_body(db, user, row)

    @app.post("/v1/auth/logout", status_code=204)
    def logout(request: Request, response: Response, db: Session = Depends(get_db)):
        user, row = _human(request, db)
        require_csrf(request, row)
        row.revoked_at = utcnow()
        db.commit()
        response.delete_cookie("careloop_session", path="/")

    @app.get("/v1/app/patients/{patient_id}/dashboard")
    def dashboard(patient_id: str, request: Request, db: Session = Depends(get_db)):
        user, row, grant, scopes = _patient_access(request, db, patient_id)
        patient = db.get(m.Patient, patient_id)
        if not patient:
            raise HTTPException(status_code=403, detail="Patient access is not permitted")
        connected = request.app.state.sockets.active_ids()
        result = _dashboard(db, patient, scopes, user.id, connected)
        if any(scope in scopes for scope in ('*', 'manage:devices', 'read:devices', 'read:dashboard')):
            result['device_setup'] = service_readiness(request.app)
        return result

    @app.post("/v1/app/patients/{patient_id}/proposals", status_code=201)
    def proposal_create(patient_id: str, data: ProposalCreate, request: Request, db: Session = Depends(get_db)):
        user, row, grant, scopes = _patient_access(request, db, patient_id, "write:care", "write:%s" % data.kind)
        require_csrf(request, row)
        proposal = create_proposal(db, patient_id, data.kind, data.payload, user_id=user.id)
        db.commit()
        return proposal_dict(proposal)

    @app.put("/v1/app/patients/{patient_id}/profile")
    def patient_profile(patient_id: str, data: PatientProfileUpdate, request: Request, db: Session = Depends(get_db)):
        user, row, grant, scopes = _patient_access(request, db, patient_id, "manage:profile")
        require_csrf(request, row)
        try:
            ZoneInfo(data.timezone)
        except ZoneInfoNotFoundError:
            raise HTTPException(status_code=422, detail="Unknown patient timezone")
        lock_patient(db, patient_id)
        patient = db.get(m.Patient, patient_id, populate_existing=True)
        patient.preferred_name = data.preferred_name
        patient.language = data.language
        patient.timezone = data.timezone
        patient.daily_check_in_enabled = data.daily_check_in_enabled
        patient.daily_check_in_local_time = data.daily_check_in_local_time if data.daily_check_in_enabled else None
        patient.calling_route = data.calling_route
        if not data.daily_check_in_enabled:
            pending_checkins = db.scalars(select(m.CheckInDelivery).where(m.CheckInDelivery.patient_id == patient_id, m.CheckInDelivery.delivery_state.in_(["preparing", "queued", "received"]))).all()
            for checkin in pending_checkins:
                checkin.delivery_state = "cancelled"
                checkin.cancel_reason = "checkin_disabled"
        db.add(m.AuditEvent(actor_type="user", actor_id=user.id, patient_id=patient_id, action="patient.profile_updated", object_type="patient", object_id=patient_id, details={"language": patient.language, "timezone": patient.timezone, "daily_check_in_enabled": patient.daily_check_in_enabled, "calling_route_configured": bool(patient.calling_route)}))
        db.commit()
        return {"id": patient.id, "preferred_name": patient.preferred_name, "language": patient.language, "timezone": patient.timezone, "daily_check_in_enabled": patient.daily_check_in_enabled, "daily_check_in_local_time": patient.daily_check_in_local_time, "calling_route": patient.calling_route}

    @app.post("/v1/app/proposals/{proposal_id}/revise", status_code=201)
    def proposal_revise(proposal_id: str, data: ProposalRevise, request: Request, db: Session = Depends(get_db)):
        previous = db.get(m.ConfirmationProposal, proposal_id)
        if not previous:
            raise HTTPException(status_code=404, detail="Proposal not found")
        user, row, grant, scopes = _patient_access(request, db, previous.patient_id, "write:care", "write:%s" % previous.kind)
        require_csrf(request, row)
        if not _proposal_visible(previous, user.id, scopes):
            raise HTTPException(status_code=403, detail="Proposal access is not permitted")
        proposal = create_proposal(db, previous.patient_id, previous.kind, data.payload, user_id=user.id, replaces=previous)
        db.commit()
        return proposal_dict(proposal)

    @app.post("/v1/app/proposals/{proposal_id}/confirm")
    def proposal_confirm(proposal_id: str, data: ProposalConfirm, request: Request, db: Session = Depends(get_db)):
        proposal = db.get(m.ConfirmationProposal, proposal_id)
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")
        user, row, grant, scopes = _patient_access(request, db, proposal.patient_id, "write:care", "write:%s" % proposal.kind)
        require_csrf(request, row)
        if not _proposal_visible(proposal, user.id, scopes):
            raise HTTPException(status_code=403, detail="Proposal access is not permitted")
        try:
            proposal = commit_proposal(db, proposal_id, proposal.patient_id)
            db.commit()
        except HTTPException:
            db.commit()
            raise
        return {"status": "committed", "record_type": proposal.record_type, "record_id": proposal.record_id}

    @app.post("/v1/app/patients/{patient_id}/medication-plans", status_code=201)
    def medication_plan(patient_id: str, data: MedicationPlanCreate, request: Request, db: Session = Depends(get_db)):
        user, row, grant, scopes = _patient_access(request, db, patient_id, "manage:medications", "write:care")
        require_csrf(request, row)
        plan = create_plan(db, patient_id, user, data)
        db.commit()
        return plan_dict(plan)

    @app.post("/v1/app/support-requests/{support_id}/acknowledge")
    def support_acknowledge(support_id: str, request: Request, db: Session = Depends(get_db)):
        item = db.get(m.SupportRequest, support_id)
        if not item:
            raise HTTPException(status_code=404, detail="Support request not found")
        user, row, grant, scopes = _patient_access(request, db, item.patient_id, "ack:support")
        require_csrf(request, row)
        if item.recipient_user_id != user.id:
            raise HTTPException(status_code=403, detail="Support request is assigned to another recipient")
        if not item.acknowledged_at:
            item.acknowledged_at = utcnow()
            item.status = "acknowledged"
            invalidate_summaries(db, item.patient_id, item.id)
            db.commit()
        return {"id": item.id, "status": item.status, "acknowledged_at": iso(item.acknowledged_at)}

    @app.post("/v1/app/support-requests/{support_id}/resolve")
    def support_resolve(support_id: str, data: ResolveRequest, request: Request, db: Session = Depends(get_db)):
        item = db.get(m.SupportRequest, support_id)
        if not item:
            raise HTTPException(status_code=404, detail="Support request not found")
        user, row, grant, scopes = _patient_access(request, db, item.patient_id, "resolve:support", "write:care")
        require_csrf(request, row)
        if "*" not in scopes and item.recipient_user_id != user.id:
            raise HTTPException(status_code=403, detail="Support request is assigned to another recipient")
        item.status, item.outcome, item.resolved_at = "resolved", data.outcome, utcnow()
        invalidate_summaries(db, item.patient_id, item.id)
        db.commit()
        return {"id": item.id, "status": item.status, "resolved_at": iso(item.resolved_at), "outcome": item.outcome}

    @app.post("/v1/app/phone-enrollments/approve")
    @app.post("/v1/app/devices/claim")
    def device_claim(data: DeviceClaim, request: Request, db: Session = Depends(get_db)):
        user, row, grant, scopes = _patient_access(request, db, data.patient_id, "manage:devices")
        require_csrf(request, row)
        recent = utcnow() - timedelta(minutes=1)
        attempts = db.scalar(select(func.count(m.AuditEvent.id)).where(m.AuditEvent.actor_id == user.id, m.AuditEvent.action == "device.claim_failed", m.AuditEvent.created_at >= recent)) or 0
        if attempts >= 5:
            raise HTTPException(status_code=429, detail="Too many claim attempts; try again later")
        device = db.scalar(select(m.Device).where(m.Device.claim_code_hash == sha256(data.code.strip().upper())))
        expected_type = "phone" if request.url.path.endswith("/phone-enrollments/approve") else "pendant"
        if not device or device.device_type != expected_type or device.patient_id or device.claimed_at or device.revoked_at or not device.claim_expires_at or aware(device.claim_expires_at) <= utcnow():
            db.add(m.AuditEvent(actor_type="user", actor_id=user.id, patient_id=data.patient_id, action="device.claim_failed", details={}))
            db.commit()
            raise HTTPException(status_code=400, detail="Claim code is invalid, expired, or already used")
        # Compare-and-set prevents the same code binding two patients concurrently.
        claimed = db.execute(update(m.Device).where(
            m.Device.id == device.id,
            m.Device.claim_code_hash == sha256(data.code.strip().upper()),
            m.Device.patient_id.is_(None), m.Device.claimed_at.is_(None),
            m.Device.revoked_at.is_(None), m.Device.claim_expires_at > utcnow(),
        ).values(patient_id=data.patient_id, claimed_at=utcnow(), claim_code_hash=None,
                 claim_expires_at=None).execution_options(synchronize_session=False))
        if claimed.rowcount != 1:
            db.rollback()
            raise HTTPException(status_code=409, detail='This device code has already been used. Refresh device settings.')
        db.add(m.AuditEvent(actor_type="user", actor_id=user.id, patient_id=data.patient_id, action="device.claimed", object_type="device", object_id=device.id, details={}))
        db.commit()
        return {"device_id": device.id, "status": "claimed"}

    @app.post("/v1/app/devices/{device_id}/revoke")
    async def device_revoke(device_id: str, request: Request, db: Session = Depends(get_db)):
        device = db.get(m.Device, device_id)
        if not device or not device.patient_id:
            raise HTTPException(status_code=404, detail="Device not found")
        user, row, grant, scopes = _patient_access(request, db, device.patient_id, "manage:devices")
        require_csrf(request, row)
        lock_patient(db, device.patient_id)
        db.refresh(device)
        from .notification_api import invalidate_notifications
        invalidate_notifications(db,device.id)
        device.revoked_at = device.revoked_at or utcnow()
        db.commit()
        await request.app.state.sockets.close_device(device.id)
        return {"device_id": device.id, "status": "revoked"}

    @app.put("/v1/app/patients/{patient_id}/active-companion")
    def active_companion(patient_id: str, data: ActiveCompanionSelect, request: Request, db: Session = Depends(get_db)):
        user, session, _, _ = _patient_access(request, db, patient_id, "manage:devices")
        require_csrf(request, session)
        result = choose_target(db, patient_id, data.device_id, data.expected_generation,
                               data.other_pendants_powered_off, user.id)
        db.commit()
        return result

    @app.delete("/v1/app/notes/{note_id}", status_code=204)
    def delete_note(note_id: str, request: Request, db: Session = Depends(get_db)):
        note = db.get(m.HealthNote, note_id)
        if not note or note.deleted_at:
            raise HTTPException(status_code=404, detail="Health note not found")
        user, row, grant, scopes = _patient_access(request, db, note.patient_id, "delete:notes", "write:care")
        require_csrf(request, row)
        note.deleted_at = utcnow()
        related_followups = db.scalars(select(m.FollowUp).where(m.FollowUp.patient_id == note.patient_id, m.FollowUp.related_type == "health_note", m.FollowUp.related_id == note.id)).all()
        for followup in related_followups:
            followup.permitted_user_ids = []
        invalidate_summaries(db, note.patient_id, note.id)
        db.commit()

    @app.put("/v1/app/notes/{note_id}/sharing")
    def update_note_sharing(note_id: str, data: NoteSharingUpdate, request: Request, db: Session = Depends(get_db)):
        note = db.get(m.HealthNote, note_id)
        if not note or note.deleted_at:
            raise HTTPException(status_code=404, detail="Health note not found")
        user, row, grant, scopes = _patient_access(request, db, note.patient_id, "manage:sharing")
        require_csrf(request, row)
        if len(set(data.user_ids)) != len(data.user_ids):
            raise HTTPException(status_code=422, detail="Sharing recipients must be unique")
        for target_user_id in data.user_ids:
            recipient = db.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == note.patient_id, m.AccessGrant.user_id == target_user_id, m.AccessGrant.revoked_at.is_(None)))
            if not recipient or (recipient.expires_at and aware(recipient.expires_at) <= utcnow()):
                raise HTTPException(status_code=422, detail="A sharing recipient is not currently permitted")
        if set(note.shared_with_user_ids or []) != set(data.user_ids):
            note.shared_with_user_ids = data.user_ids
            note.version += 1
            related_followups = db.scalars(select(m.FollowUp).where(m.FollowUp.patient_id == note.patient_id, m.FollowUp.related_type == "health_note", m.FollowUp.related_id == note.id, m.FollowUp.permission_scope == "related_recipients")).all()
            for followup in related_followups:
                followup.permitted_user_ids = list(data.user_ids)
            invalidate_summaries(db, note.patient_id, note.id)
        db.commit()
        return {"id": note.id, "shared_with_user_ids": note.shared_with_user_ids, "version": note.version}

    @app.post("/v1/app/patients/{patient_id}/grants", status_code=201)
    def grant_create(patient_id: str, data: GrantCreate, request: Request, db: Session = Depends(get_db)):
        user, row, owner_grant, scopes = _patient_access(request, db, patient_id, "manage:sharing")
        require_csrf(request, row)
        target = db.get(m.User, data.user_id)
        if not target or not target.active:
            raise HTTPException(status_code=422, detail="Target user is unavailable")
        forbidden = {"*", "manage:sharing", "manage:devices"}
        if forbidden.intersection(data.scopes):
            raise HTTPException(status_code=422, detail="Delegated scopes cannot grant owner privileges")
        grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == patient_id, m.AccessGrant.user_id == data.user_id))
        if grant:
            grant.scopes, grant.expires_at, grant.revoked_at = data.scopes, data.expires_at, None
        else:
            grant = m.AccessGrant(patient_id=patient_id, user_id=data.user_id, relationship="caregiver", scopes=data.scopes, expires_at=data.expires_at)
            db.add(grant)
        db.commit()
        return {"id": grant.id, "user_id": grant.user_id, "scopes": grant.scopes, "expires_at": iso(grant.expires_at)}

    @app.delete("/v1/app/grants/{grant_id}", status_code=204)
    def grant_delete(grant_id: str, request: Request, db: Session = Depends(get_db)):
        target = db.get(m.AccessGrant, grant_id)
        if not target:
            raise HTTPException(status_code=404, detail="Grant not found")
        user, row, owner_grant, scopes = _patient_access(request, db, target.patient_id, "manage:sharing")
        require_csrf(request, row)
        if target.user_id == user.id:
            raise HTTPException(status_code=409, detail="Owner cannot revoke their current access grant")
        target.revoked_at = utcnow()
        shared_notes = db.scalars(select(m.HealthNote).where(m.HealthNote.patient_id == target.patient_id, m.HealthNote.deleted_at.is_(None))).all()
        for note in shared_notes:
            if target.user_id in (note.shared_with_user_ids or []):
                note.shared_with_user_ids = [user_id for user_id in note.shared_with_user_ids if user_id != target.user_id]
                note.version += 1
        shared_followups = db.scalars(select(m.FollowUp).where(m.FollowUp.patient_id == target.patient_id)).all()
        for followup in shared_followups:
            if target.user_id in (followup.permitted_user_ids or []):
                followup.permitted_user_ids = [user_id for user_id in followup.permitted_user_ids if user_id != target.user_id]
        invalidate_summaries(db, target.patient_id)
        db.commit()

    @app.post("/v1/app/patients/{patient_id}/summaries", status_code=201)
    def summary_create(patient_id: str, data: SummaryCreate, request: Request, db: Session = Depends(get_db)):
        user, row, grant, scopes = _patient_access(request, db, patient_id, "manage:sharing")
        require_csrf(request, row)
        summary = make_summary(db, patient_id, data.start_date, data.end_date, user.id)
        db.commit()
        return summary_dict(summary)

    @app.put("/v1/app/summaries/{summary_id}")
    def summary_update(summary_id: str, data: SummaryUpdate, request: Request, db: Session = Depends(get_db)):
        summary = db.get(m.VisitSummary, summary_id)
        if not summary:
            raise HTTPException(status_code=404, detail="Summary not found")
        user, row, grant, scopes = _patient_access(request, db, summary.patient_id, "manage:sharing")
        require_csrf(request, row)
        if summary.invalidated_at:
            raise HTTPException(status_code=409, detail="Summary sources changed; regenerate the summary")
        if not summary_sources_current(db, summary):
            summary.invalidated_at = utcnow()
            summary.status = "invalidated"
            db.commit()
            raise HTTPException(status_code=409, detail="Summary sources changed; regenerate the summary")
        source_ids = {ref["id"] for ref in summary.source_refs}
        if not set(data.omitted_source_ids).issubset(source_ids):
            raise HTTPException(status_code=422, detail="Omitted source is not part of this summary")
        sanitised_sections = []
        for section in data.sections:
            if set(section) != {"title", "items"} or not isinstance(section["title"], str) or not isinstance(section["items"], list):
                raise HTTPException(status_code=422, detail="Each summary section must contain only title and items")
            items = []
            for item in section["items"]:
                if not isinstance(item, dict) or not set(item).issubset({"text", "source_id"}) or not isinstance(item.get("text"), str) or not item["text"].strip():
                    raise HTTPException(status_code=422, detail="Summary items require text and an optional source_id")
                source_id = item.get("source_id")
                if source_id and source_id not in source_ids:
                    raise HTTPException(status_code=422, detail="Summary contains an unknown source link")
                if source_id not in data.omitted_source_ids:
                    items.append({"text": item["text"].strip(), **({"source_id": source_id} if source_id else {})})
            sanitised_sections.append({"title": section["title"].strip(), "items": items})
        summary.sections, summary.omitted_source_ids = sanitised_sections, data.omitted_source_ids
        summary.status, summary.reviewed_at = "reviewed", utcnow()
        active_shares = db.scalars(select(m.SummaryShare).where(m.SummaryShare.summary_id == summary.id, m.SummaryShare.revoked_at.is_(None))).all()
        for share in active_shares:
            share.revoked_at = utcnow()
        db.commit()
        return summary_dict(summary)

    @app.post("/v1/app/summaries/{summary_id}/share", status_code=201)
    def summary_share(summary_id: str, data: SummaryShareCreate, request: Request, db: Session = Depends(get_db)):
        summary = db.get(m.VisitSummary, summary_id)
        if not summary:
            raise HTTPException(status_code=404, detail="Summary not found")
        user, row, grant, scopes = _patient_access(request, db, summary.patient_id, "manage:sharing")
        require_csrf(request, row)
        if summary.status != "reviewed" or summary.invalidated_at:
            raise HTTPException(status_code=409, detail="Only a current reviewed summary can be shared")
        if not summary_sources_current(db, summary):
            summary.invalidated_at = utcnow()
            summary.status = "invalidated"
            db.commit()
            raise HTTPException(status_code=409, detail="Summary sources changed; regenerate the summary")
        token = secrets.token_urlsafe(32)
        expires = utcnow() + timedelta(seconds=data.expires_in_seconds)
        share = m.SummaryShare(summary_id=summary.id, token_hash=sha256(token), expires_at=expires)
        db.add(share)
        db.commit()
        return {"share_token": token, "expires_at": iso(expires), "url": "/v1/shared/summaries/%s" % token}

    @app.post("/v1/app/summaries/{summary_id}/revoke")
    def summary_revoke(summary_id: str, request: Request, db: Session = Depends(get_db)):
        summary = db.get(m.VisitSummary, summary_id)
        if not summary:
            raise HTTPException(status_code=404, detail="Summary not found")
        user, row, grant, scopes = _patient_access(request, db, summary.patient_id, "manage:sharing")
        require_csrf(request, row)
        shares = db.scalars(select(m.SummaryShare).where(m.SummaryShare.summary_id == summary.id, m.SummaryShare.revoked_at.is_(None))).all()
        for share in shares:
            share.revoked_at = utcnow()
        db.commit()
        return {"id": summary.id, "status": "revoked", "revoked_links": len(shares)}

    @app.get("/v1/shared/summaries/{token}")
    def shared_summary(token: str, db: Session = Depends(get_db)):
        share = db.scalar(select(m.SummaryShare).where(m.SummaryShare.token_hash == sha256(token)))
        if not share:
            raise HTTPException(status_code=404, detail="Shared summary not found")
        summary = db.get(m.VisitSummary, share.summary_id)
        if share.revoked_at or aware(share.expires_at) <= utcnow() or not summary or summary.invalidated_at or summary.status != "reviewed" or not summary_sources_current(db, summary):
            raise HTTPException(status_code=410, detail="Shared summary is no longer available")
        patient = db.get(m.Patient, summary.patient_id)
        return {"patient": {"name": patient.name}, "summary": summary_dict(summary, public=True), "read_only": True}

    @app.get('/v1/device/info')
    def device_info(request: Request, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)):
        device = authenticate_device_header(db, authorization)
        return {'device_id': device.id, 'pairing_state': 'paired', 'server_time': iso(utcnow()),
                **service_readiness(request.app)}

    @app.post("/v1/device/turns", status_code=202)
    async def device_turn(request: Request, background: BackgroundTasks, authorization: Optional[str] = Header(default=None), idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"), context_id: Optional[str] = Header(default=None, alias="X-Context-Id"), db: Session = Depends(get_db)):
        device = authenticate_device_header(db, authorization)
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "audio/wav":
            raise HTTPException(status_code=400, detail="Content-Type must be audio/wav")
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            UUID(idempotency_key)
        except ValueError:
            raise HTTPException(status_code=400, detail="Idempotency-Key must be a UUID")
        length = request.headers.get("content-length")
        if length:
            try:
                if int(length) > 768 * 1024:
                    raise HTTPException(status_code=413, detail="Audio upload exceeds 768 KiB")
            except ValueError:
                raise HTTPException(status_code=400, detail="Content-Length is invalid")
        collected = bytearray()
        async for chunk in request.stream():
            collected.extend(chunk)
            if len(collected) > 768 * 1024:
                raise HTTPException(status_code=413, detail="Audio upload exceeds 768 KiB")
        body = bytes(collected)
        try:
            validate_wav(body)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        from .turns import accept_turn
        return accept_turn(request.app, db, device, body, sha_bytes(body), idempotency_key, context_id, background)

    @app.get("/v1/device/turns/{turn_id}")
    def device_turn_status(turn_id: str, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)):
        device = authenticate_device_header(db, authorization)
        turn = db.get(m.VoiceTurn, turn_id)
        if not turn or turn.device_id != device.id:
            raise HTTPException(status_code=404, detail="Turn not found")
        event_row = None
        for candidate in db.scalars(select(m.DeviceEvent).where(m.DeviceEvent.device_id == device.id, m.DeviceEvent.event_type == "turn.result").order_by(m.DeviceEvent.created_at.desc())).all():
            if candidate.payload.get("turn_id") == turn.id:
                event_row = candidate
                break
        payload = {"turn_id": turn.id, "status": turn.status, "received_at": iso(turn.received_at), "event": event_envelope(event_row, device.id) if event_row else None, "error": turn.processing_error}
        if len(json.dumps(payload, separators=(",", ":")).encode()) > DEVICE_JSON_MAX_BYTES:
            raise HTTPException(status_code=503, detail="Turn result exceeds device transport limit")
        return payload

    @app.get("/v1/device/audio/{asset_id}")
    def device_audio(asset_id: str, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)):
        device = authenticate_device_header(db, authorization)
        lock_patient(db, device.patient_id)
        db.refresh(device)
        if device.revoked_at:
            raise HTTPException(403, detail="Device is revoked")
        asset = db.get(m.AudioAsset, asset_id)
        if not asset or asset.device_id != device.id:
            raise HTTPException(status_code=404, detail="Audio asset not found")
        if aware(asset.expires_at) <= utcnow():
            raise HTTPException(status_code=410, detail="Audio asset expired")
        guard=asset.context_guard or {}
        if guard.get("status_record"):
            from .care_status import status_reply
            expected = guard["status_record"]
            _, current = status_reply(db, device.patient_id, expected["kind"], expected["record_id"])
            if current != expected:
                raise HTTPException(410, "This spoken status is no longer current")
        if guard.get("proposal_id"):
            proposal=db.get(m.ConfirmationProposal,guard["proposal_id"],populate_existing=True)
            if not proposal or proposal.patient_id!=device.patient_id or proposal.status!=guard.get("status") or (proposal.status=="pending" and aware(proposal.expires_at)<=utcnow()):
                raise HTTPException(410,"This read-back is no longer current")
        if guard.get("plan_id"):
            plan=db.get(m.MedicationPlanVersion,guard["plan_id"],populate_existing=True)
            if not plan or not plan.active or plan.patient_id!=device.patient_id:
                raise HTTPException(410,"This medication explanation is no longer current")
        commands = db.scalars(select(m.ReminderCommand).where(m.ReminderCommand.audio_asset_id == asset.id)).all()
        checkins = db.scalars(select(m.CheckInDelivery).where(m.CheckInDelivery.device_id == device.id)).all()
        related = commands + [item for item in checkins if asset.id in (item.audio_asset_ids or [])]
        if related and not any(current_attempt(db, device, item) for item in related):
            raise HTTPException(410, detail="Reminder audio is no longer current")
        for item in related:
            item.audio_accessed_at = item.audio_accessed_at or utcnow()
        db.commit()
        return Response(content=asset.wav_bytes, media_type="audio/wav", headers={"Cache-Control": "private, no-store", "Content-Length": str(len(asset.wav_bytes))})

    @app.post("/v1/device/acks")
    def device_ack(data: DeviceAck, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)):
        device = authenticate_device_header(db, authorization)
        lock_patient(db, device.patient_id)
        db.refresh(device)
        if device.revoked_at:
            raise HTTPException(403, detail="Device is revoked")
        command = db.get(m.ReminderCommand, data.command_id)
        checkin = db.get(m.CheckInDelivery, data.command_id) if not command else None
        item = command or checkin
        if not item or item.device_id != device.id:
            raise HTTPException(status_code=404, detail="Playback command not found")
        existing = db.scalar(select(m.ReminderAck).where(m.ReminderAck.device_id == device.id, m.ReminderAck.ack_id == data.ack_id))
        if existing:
            if existing.command_id != item.id or existing.stage != data.stage:
                raise HTTPException(status_code=409, detail="Acknowledgement ID was reused with different content")
            return {"ack_id": existing.ack_id, "status": "recorded", "stage": existing.stage}
        selected = route_view(db, device.patient_id)
        # A phone's durable ledger may outlive the playable command. Reconcile
        # historical terminal evidence only after this device obtained start
        # authorization; this never authorizes new audio or confirms a dose.
        late_phone_terminal = (
            device.device_type == "phone"
            and data.stage in {"playback_completed", "interrupted"}
            and item.delivery_state in {"playback_started", "playback_unknown"}
            and db.scalar(select(m.ReminderAck.id).where(
                m.ReminderAck.device_id == device.id,
                m.ReminderAck.command_id == item.id,
                m.ReminderAck.stage == "playback_started")) is not None
        )
        if not late_phone_terminal and (selected['device_id'] != device.id or selected['generation'] != item.route_generation):
            raise HTTPException(409, detail="Reminder belongs to a previous companion selection")
        if data.stage in {'received', 'playback_started'} and not current_attempt(db, device, item):
            raise HTTPException(409, detail="Playback command is no longer current")
        order = {"queued": 0, "received": 1, "playback_started": 2, "playback_completed": 3, "interrupted": 3, "failed": 3, "expired": 3}
        if not late_phone_terminal and data.stage != "expired" and (item.delivery_state in {"expired", "cancelled"} or aware(item.expires_at) <= utcnow()):
            raise HTTPException(status_code=409, detail="Playback command is no longer playable")
        if item.delivery_state in {"playback_completed", "interrupted", "failed"} and data.stage != item.delivery_state:
            raise HTTPException(status_code=409, detail="Acknowledgement cannot replace a terminal playback state")
        if command and data.stage == "playback_started":
            active_plan = db.scalar(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.patient_id == device.patient_id, m.MedicationPlanVersion.active.is_(True)))
            if command.cancelled_at or not active_plan or command.plan_version != active_plan.version:
                raise HTTPException(status_code=409, detail="Reminder command belongs to an inactive plan")
        if data.stage != "expired" and order.get(data.stage, 0) < order.get(item.delivery_state, 0):
            raise HTTPException(status_code=409, detail="Acknowledgement stage cannot move backwards")
        ack = m.ReminderAck(ack_id=data.ack_id, device_id=device.id, command_id=item.id, stage=data.stage, device_time=data.device_time)
        db.add(ack)
        if item.delivery_state != "cancelled":
            item.delivery_state = data.stage
        device.last_seen = utcnow()
        db.commit()
        return {"ack_id": ack.ack_id, "status": "recorded", "stage": ack.stage}

    @app.get("/v1/device/pending-commands")
    def pending_commands(authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)):
        device = authenticate_device_header(db, authorization)
        plan = db.scalar(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.patient_id == device.patient_id, m.MedicationPlanVersion.active.is_(True)))
        version = plan.version if plan else None
        commands = db.scalars(select(m.ReminderCommand).where(m.ReminderCommand.device_id == device.id, m.ReminderCommand.cancelled_at.is_(None), m.ReminderCommand.expires_at > utcnow(), m.ReminderCommand.delivery_state.in_(["queued", "received"])).limit(12)).all()
        current = [item for item in commands if current_attempt(db, device, item)]
        checkins = db.scalars(select(m.CheckInDelivery).where(m.CheckInDelivery.device_id == device.id, m.CheckInDelivery.expires_at > utcnow(), m.CheckInDelivery.delivery_state.in_(["queued", "received"])).order_by(m.CheckInDelivery.due_at).limit(2)).all()
        checkins = [item for item in checkins if current_attempt(db, device, item)]
        payload = {"active_companion": route_view(db, device.patient_id), "current_plan_version": version, "commands": [command_envelope(item) for item in current], "checkins": [checkin_envelope(item) for item in checkins]}
        if len(json.dumps(payload, separators=(",", ":")).encode()) > DEVICE_JSON_MAX_BYTES:
            raise HTTPException(status_code=503, detail="Pending command response exceeds device transport limit")
        return payload

    @app.websocket("/v1/device/events")
    async def device_events(websocket: WebSocket):
        db = websocket.app.state.db.SessionLocal()
        device = None
        try:
            device = authenticate_device_websocket(db, websocket)
            await websocket.accept()
            websocket.app.state.sockets.add(device.id, websocket)
            seen = set()
            while True:
                fresh = db.get(m.Device, device.id)
                db.refresh(fresh)
                if fresh.revoked_at:
                    await websocket.close(code=4403, reason="Device revoked")
                    break
                events = db.scalars(select(m.DeviceEvent).where(m.DeviceEvent.device_id == device.id, m.DeviceEvent.expires_at > utcnow()).order_by(m.DeviceEvent.created_at)).all()
                for event in events:
                    if event.event_type == "reminder.play":
                        command = db.get(m.ReminderCommand, event.payload.get("command_id"), populate_existing=True)
                        active_plan = db.scalar(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.patient_id == device.patient_id, m.MedicationPlanVersion.active.is_(True)))
                        if not command or not current_attempt(db, fresh, command) or command.delivery_state not in {"queued", "received"}:
                            continue
                    if event.event_type == "checkin.play":
                        checkin = db.get(m.CheckInDelivery, event.payload.get("command_id"), populate_existing=True)
                        if not checkin or not current_attempt(db, fresh, checkin) or checkin.delivery_state not in {"queued", "received"}:
                            continue
                    if event.id not in seen:
                        envelope = event_envelope(event, device.id)
                        if len(json.dumps(envelope, separators=(",", ":")).encode()) > DEVICE_JSON_MAX_BYTES:
                            await websocket.close(code=4400, reason="Event exceeds 16 KiB")
                            return
                        await websocket.send_json(envelope)
                        seen.add(event.id)
                db.rollback()  # Release read snapshots before waiting on the network.
                try:
                    raw = await asyncio.wait_for(websocket.receive_json(), timeout=1)
                except asyncio.TimeoutError:
                    continue
                heartbeat = Heartbeat.model_validate(raw)
                fresh.last_seen = utcnow()
                if heartbeat.battery_mv is not None:
                    fresh.battery_mv = heartbeat.battery_mv
                if heartbeat.rssi is not None:
                    fresh.rssi = heartbeat.rssi
                if heartbeat.firmware_version is not None:
                    fresh.firmware_version = heartbeat.firmware_version
                db.commit()
                websocket.app.state.sockets.heartbeat(websocket)
                await websocket.send_json({'protocol_version': PROTOCOL['version'], 'type': 'heartbeat.ack',
                                           'device_id': device.id, 'server_time': iso(fresh.last_seen)})
        except HTTPException as exc:
            await websocket.close(code=4401 if exc.status_code == 401 else 4403, reason=exc.detail)
        except WebSocketDisconnect:
            pass
        except Exception:
            try:
                await websocket.close(code=4400, reason="Invalid device message")
            except Exception:
                pass
        finally:
            if device:
                try:
                    lock_patient(db, device.patient_id)
                    started = db.scalars(select(m.ReminderCommand).where(m.ReminderCommand.device_id == device.id, m.ReminderCommand.delivery_state == "playback_started")).all()
                    for command in started:
                        command.delivery_state = "playback_unknown"
                    checkins = db.scalars(select(m.CheckInDelivery).where(m.CheckInDelivery.device_id == device.id, m.CheckInDelivery.delivery_state == "playback_started")).all()
                    for checkin in checkins:
                        checkin.delivery_state = "playback_unknown"
                    db.commit()
                except Exception:
                    db.rollback()
                websocket.app.state.sockets.remove(device.id, websocket)
            db.close()

    return app


app = create_app()
