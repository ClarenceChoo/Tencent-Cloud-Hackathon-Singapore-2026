"""Installation-scoped phone APIs. No browser session or patient ID is trusted here."""
import hashlib
import hmac
import re
import threading
import time
from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from . import models as m
from .security import _bearer, aware, authenticate_device_header, iso, sha256, utcnow

from .routing import lock_patient, pause_phone, route_view

router = APIRouter(prefix="/v1/phone", tags=["phone"])


def phone_db(request: Request):
    with request.app.state.db.SessionLocal() as db:
        yield db


class EnrollmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    platform: Literal["ios", "android"]
    display_name: str = Field(min_length=1, max_length=80)


class EnrollmentLimiter:
    """Bounded per-process limiter; deployment runs one API worker.

    Peer addresses come from ASGI, never client-supplied forwarding headers.
    A multi-worker deployment must supply a shared limiter before scaling.
    """
    def __init__(self):
        self.lock = threading.Lock()
        self.windows = {}

    def check(self, key, limit, seconds):
        now = time.monotonic()
        with self.lock:
            self.windows = {k: v for k, v in self.windows.items() if v[0] > now}
            expiry, count = self.windows.get(key, (now + seconds, 0))
            if count >= limit or (key not in self.windows and len(self.windows) >= 4096):
                raise HTTPException(429, "Too many pairing requests; try again later", headers={"Retry-After": str(max(1, int(expiry - now)))})
            self.windows[key] = (expiry, count + 1)


def installation_token(authorization):
    token = _bearer(authorization)
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        raise HTTPException(401, "A 32-byte installation credential is required")
    return token


def _transport(request, response, action):
    if request.url.scheme != "https" and not request.app.state.settings.testing:
        raise HTTPException(400, "Phone pairing requires HTTPS")
    response.headers["Cache-Control"] = "private, no-store"
    peer = request.client.host if request.client else "unknown"
    request.app.state.phone_limiter.check((action, peer), 8 if action == "create" else 120, 600 if action == "create" else 60)


def possession_code(token: str, key: str) -> str:
    # Retriable without storing a plaintext code or installation secret.
    digest = hmac.new(bytes.fromhex(token), ("parse-pair-v1:" + key).encode(), hashlib.sha256).hexdigest().upper()
    return "P-" + digest[:5] + "-" + digest[5:10]


def enrollment_view(db, device, enrollment, token):
    if device.revoked_at:
        raise HTTPException(403, "This installation has been revoked; pair a new installation")
    if device.patient_id:
        patient = db.get(m.Patient, device.patient_id)
        return {"status": "paired", "device_id": device.id,
                "patient": {"id": patient.id, "name": patient.preferred_name or patient.name},
                "platform": device.platform}
    if aware(enrollment.expires_at) <= utcnow():
        raise HTTPException(410, "Pairing expired; start a new phone enrollment")
    return {"status": "awaiting_approval", "device_id": device.id,
            "code": possession_code(token, enrollment.idempotency_key),
            "expires_at": iso(enrollment.expires_at), "poll_after_seconds": 5}


def authenticate_phone(db, authorization):
    device = authenticate_device_header(db, authorization)
    if device.device_type != "phone":
        raise HTTPException(403, "This operation requires a paired phone")
    return device


@router.post("/enrollments", status_code=201)
def enroll(data: EnrollmentCreate, request: Request, response: Response,
           authorization: str | None = Header(default=None),
           idempotency_key: str | None = Header(default=None), db=Depends(phone_db)):
    _transport(request, response, "create")
    token = installation_token(authorization)
    try:
        key = str(UUID(idempotency_key or ""))
    except ValueError:
        raise HTTPException(400, "Idempotency-Key must be a UUID")
    device = db.scalar(select(m.Device).where(m.Device.credential_hash == sha256(token)))
    if device:
        enrollment = db.get(m.PhoneEnrollment, device.id)
        if (not enrollment or enrollment.idempotency_key != key or device.platform != data.platform
                or device.display_name != data.display_name):
            raise HTTPException(409, "Installation credential or enrollment key was already used")
        response.status_code = 200
        return enrollment_view(db, device, enrollment, token)
    concurrent = db.scalar(select(m.PhoneEnrollment).where(m.PhoneEnrollment.idempotency_key == key))
    if concurrent:
        device = db.get(m.Device, concurrent.device_id)
        if (device.credential_hash != sha256(token) or device.platform != data.platform
                or device.display_name != data.display_name):
            raise HTTPException(409, "Enrollment key was already used")
        response.status_code = 200
        return enrollment_view(db, device, concurrent, token)
    expires = utcnow() + timedelta(minutes=10)
    device = m.Device(credential_hash=sha256(token), device_type="phone", platform=data.platform,
                      display_name=data.display_name, capabilities=["phone-v1", "wav-16k-mono"],
                      claim_code_hash=sha256(possession_code(token, key)), claim_expires_at=expires)
    try:
        db.add(device)
        db.flush()
        enrollment = m.PhoneEnrollment(device_id=device.id, idempotency_key=key, expires_at=expires)
        db.add(enrollment)
        db.commit()
    except IntegrityError:
        db.rollback()
        # A simultaneous retry may have won; only the exact installation may recover it.
        device = db.scalar(select(m.Device).where(m.Device.credential_hash == sha256(token)))
        enrollment = db.get(m.PhoneEnrollment, device.id) if device else None
        if (not enrollment or enrollment.idempotency_key != key or device.platform != data.platform
                or device.display_name != data.display_name):
            raise HTTPException(409, "Installation credential or enrollment key was already used")
        response.status_code = 200
    return enrollment_view(db, device, enrollment, token)


@router.get("/enrollments/current")
def enrollment_status(request: Request, response: Response,
                      authorization: str | None = Header(default=None), db=Depends(phone_db)):
    _transport(request, response, "status")
    token = installation_token(authorization)
    device = db.scalar(select(m.Device).where(m.Device.credential_hash == sha256(token)))
    enrollment = db.get(m.PhoneEnrollment, device.id) if device else None
    if not enrollment:
        raise HTTPException(401, "Phone enrollment not found")
    return enrollment_view(db, device, enrollment, token)


class Quiescence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    playback_stopped: Literal[True]
    local_alerts_cleared: Literal[True]


@router.post("/quiesce")
def quiesce(data: Quiescence, response: Response,
            authorization: str | None = Header(default=None), db=Depends(phone_db)):
    # A revoked installation may attest only its own local cleanup. It cannot
    # read care data, activate another device, or recover normal access here.
    token = installation_token(authorization)
    device = db.scalar(select(m.Device).where(m.Device.credential_hash == sha256(token),
                       m.Device.device_type == "phone", m.Device.patient_id.is_not(None)))
    if not device:
        raise HTTPException(401, "Paired phone installation not found")
    pause_phone(db, device)
    db.commit()
    response.headers["Cache-Control"] = "private, no-store"
    return {"status": "paused"}


@router.delete("/installation")
async def revoke_installation(request: Request, authorization: str | None = Header(default=None), db=Depends(phone_db)):
    device = authenticate_phone(db, authorization)
    lock_patient(db, device.patient_id)
    db.refresh(device)
    if route_view(db, device.patient_id)["device_id"] == device.id:
        raise HTTPException(409, "Stop playback, clear local alerts and pause this phone before unpairing")
    from .notification_api import invalidate_notifications
    invalidate_notifications(db, device.id)
    device.revoked_at = utcnow()
    db.add(m.AuditEvent(actor_type="device", actor_id=device.id, patient_id=device.patient_id,
                        action="phone.unpaired", object_type="device", object_id=device.id, details={}))
    db.commit()
    await request.app.state.sockets.close_device(device.id)
    return {"status": "revoked"}


class ProposalAction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    context_id: str = Field(min_length=1, max_length=64)


class PhoneConfirm(ProposalAction):
    confirmed: Literal[True]


class PhoneRevise(ProposalAction):
    payload: dict


def phone_proposal(db, device, proposal_id, context_id):
    proposal = db.get(m.ConfirmationProposal, proposal_id)
    turn = db.get(m.VoiceTurn, proposal.source_turn_id) if proposal and proposal.source_turn_id else None
    if (not proposal or proposal.patient_id != device.patient_id or not turn or turn.device_id != device.id
            or proposal.context_id != context_id):
        raise HTTPException(404, 'Phone proposal not found')
    return proposal


@router.post('/proposals/{proposal_id}/confirm')
def confirm(proposal_id: str, data: PhoneConfirm, authorization: str | None = Header(default=None), db=Depends(phone_db)):
    from .services import commit_proposal
    device = authenticate_phone(db, authorization)
    phone_proposal(db, device, proposal_id, data.context_id)
    try:
        proposal = commit_proposal(db, proposal_id, device.patient_id)
        db.commit()
    except HTTPException:
        db.commit()  # Preserve expired/invalidated state from the shared service.
        raise
    return {'status': 'committed', 'record_type': proposal.record_type, 'record_id': proposal.record_id}


@router.post('/proposals/{proposal_id}/revise', status_code=201)
def revise(proposal_id: str, data: PhoneRevise, authorization: str | None = Header(default=None), db=Depends(phone_db)):
    from .services import create_proposal, proposal_dict
    device = authenticate_phone(db, authorization)
    previous = phone_proposal(db, device, proposal_id, data.context_id)
    proposal = create_proposal(db, device.patient_id, previous.kind, data.payload,
                               source_turn_id=previous.source_turn_id, replaces=previous)
    db.commit()
    return proposal_dict(proposal)


@router.post('/proposals/{proposal_id}/cancel')
def cancel(proposal_id: str, data: ProposalAction, authorization: str | None = Header(default=None), db=Depends(phone_db)):
    from sqlalchemy import update
    device = authenticate_phone(db, authorization)
    proposal = phone_proposal(db, device, proposal_id, data.context_id)
    if proposal.status == 'invalidated' and proposal.invalidated_reason == 'cancelled_by_phone':
        return {'status': 'cancelled'}
    result = db.execute(update(m.ConfirmationProposal).where(
        m.ConfirmationProposal.id == proposal.id, m.ConfirmationProposal.status == 'pending',
        m.ConfirmationProposal.expires_at > utcnow(),
    ).values(status='invalidated', invalidated_reason='cancelled_by_phone').execution_options(synchronize_session=False))
    if result.rowcount != 1:
        raise HTTPException(409, 'Proposal is no longer current')
    db.add(m.AuditEvent(actor_type='device', actor_id=device.id, patient_id=device.patient_id,
                       action='proposal.cancelled', object_type='proposal', object_id=proposal.id, details={}))
    db.commit()
    return {'status': 'cancelled'}


@router.get('/home')
def home(request: Request, response: Response, authorization: str | None = Header(default=None), db=Depends(phone_db)):
    from .device_setup import service_readiness
    from .services import plan_dict, proposal_dict
    device = authenticate_phone(db, authorization)
    response.headers['Cache-Control'] = 'private, no-store'
    patient = db.get(m.Patient, device.patient_id)
    plan = db.scalar(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.patient_id == patient.id, m.MedicationPlanVersion.active.is_(True)))
    proposal = db.scalar(select(m.ConfirmationProposal).join(m.VoiceTurn, m.VoiceTurn.id == m.ConfirmationProposal.source_turn_id).where(
        m.VoiceTurn.device_id == device.id, m.ConfirmationProposal.status == 'pending',
        m.ConfirmationProposal.expires_at > utcnow()).order_by(m.ConfirmationProposal.created_at.desc()).limit(1))
    doses = db.scalars(select(m.DoseInstance).where(m.DoseInstance.patient_id == patient.id,
                       m.DoseInstance.scheduled_at >= utcnow() - timedelta(days=3))
                       .order_by(m.DoseInstance.scheduled_at).limit(80)).all()
    notes = db.scalars(select(m.HealthNote).where(m.HealthNote.patient_id == patient.id,
                       m.HealthNote.deleted_at.is_(None)).order_by(m.HealthNote.created_at.desc()).limit(20)).all()
    measurements = db.scalars(select(m.Measurement).where(m.Measurement.patient_id == patient.id,
                              m.Measurement.superseded_at.is_(None)).order_by(m.Measurement.created_at.desc()).limit(20)).all()
    tasks = db.scalars(select(m.PreventiveTask).where(m.PreventiveTask.patient_id == patient.id).order_by(m.PreventiveTask.due_date).limit(50)).all()
    supports = db.scalars(select(m.SupportRequest).where(m.SupportRequest.patient_id == patient.id).order_by(m.SupportRequest.created_at.desc()).limit(30)).all()
    followups = db.scalars(select(m.FollowUp).where(m.FollowUp.patient_id == patient.id).order_by(m.FollowUp.check_at.desc()).limit(30)).all()
    recipients = db.execute(select(m.AccessGrant, m.User).join(m.User, m.User.id == m.AccessGrant.user_id).where(
        m.AccessGrant.patient_id == patient.id, m.AccessGrant.revoked_at.is_(None), m.User.active.is_(True))).all()

    from .provenance import CareEvidence
    evidence = CareEvidence(db, patient.id, doses=doses, notes=notes, measurements=measurements,
                            tasks=tasks, supports=supports, followups=followups)
    source = evidence.source

    return {
        'device_id': device.id, 'server_time': iso(utcnow()),
        'patient': {'id': patient.id, 'name': patient.name, 'preferred_name': patient.preferred_name,
                    'timezone': patient.timezone, 'language': patient.language,
                    'daily_check_in_enabled': patient.daily_check_in_enabled,
                    'daily_check_in_local_time': patient.daily_check_in_local_time,
                    'calling_route': patient.calling_route},
        'active_companion': route_view(db, patient.id),
        'voice': service_readiness(request.app),
        'current_proposal': proposal_dict(proposal) if proposal else None,
        'medication_plan': plan_dict(plan) if plan else None,
        'doses': [{'id': d.id, 'medicine_id': d.medicine_id, 'medicine_name': d.medicine_name,
                   'plan_version': d.plan_version, 'scheduled_at': iso(d.scheduled_at), 'report_state': d.report_state,
                   'report_time': iso(d.report_time), 'taken_time_text': d.taken_time_text,
                   'source': source(d.confirmation_proposal_id), 'provenance': source(d.confirmation_proposal_id),
                   'report_history': evidence.reports[d.id][-20:], 'history_truncated': len(evidence.reports[d.id]) > 20} for d in doses],
        'notes': [{'id': n.id, 'wording': n.wording, 'created_at': iso(n.created_at),
                   'shared_with_user_ids': n.shared_with_user_ids, 'source': source(n.proposal_id),
                   'provenance': source(n.proposal_id), 'occurrence_text': n.occurrence_text,
                   'occurred_at': iso(n.occurred_at), 'timezone': n.timezone} for n in notes],
        'measurements': [{'id': r.id, 'systolic': r.systolic, 'diastolic': r.diastolic, 'unit': r.unit,
                          'occurred_at': iso(r.occurred_at), 'source_description': r.source_description,
                          'reporting_actor': r.reporting_actor, 'source': source(r.proposal_id),
                          'provenance': source(r.proposal_id), 'created_at': iso(r.created_at),
                          'occurrence_text': r.occurrence_text, 'timezone': r.timezone} for r in measurements],
        'preventive_tasks': [{'id': t.id, 'description': t.description, 'state': t.state,
                              'source': t.source, 'due_date': iso(t.due_date),
                              'appointment_date': iso(t.appointment_date), 'completion_date': iso(t.completion_date),
                              'provenance': source(t.last_proposal_id), 'transitions': evidence.transitions[t.id][-20:], 'history_truncated': len(evidence.transitions[t.id]) > 20,
                              'created_at': iso(t.created_at), 'updated_at': iso(t.updated_at)} for t in tasks],
        'support_requests': [{'id': s.id, 'request_text': s.request_text, 'status': s.status,
                              'acknowledged_at': iso(s.acknowledged_at), 'resolved_at': iso(s.resolved_at),
                              'outcome': s.outcome, 'calling_route': s.calling_route_snapshot or ('No calling route is configured. Use your usual local support or emergency contact method.' if s.urgency == 'urgent' else None),
                              'calling_route_configured': bool(s.calling_route_snapshot),
                              'provenance': source(s.proposal_id), 'created_at': iso(s.created_at),
                              'urgency': s.urgency, 'barrier_text': s.barrier_text} for s in supports],
        'followups': [{'id': f.id, 'related_type': f.related_type, 'related_id': f.related_id,
                       'check_at': iso(f.check_at), 'resolution_state': f.resolution_state,
                       'reported_outcome': f.reported_outcome, 'provenance': source(f.proposal_id),
                       'resolutions': evidence.resolutions[f.id][-20:], 'history_truncated': len(evidence.resolutions[f.id]) > 20, 'created_at': iso(f.created_at)} for f in followups],
        'permitted_recipients': [{'id': u.id, 'name': u.name, 'relationship': g.relationship}
                                for g, u in recipients if not g.expires_at or aware(g.expires_at) > utcnow()],
    }


@router.post('/turns', status_code=202)
async def phone_turn(request: Request, background: BackgroundTasks,
                     authorization: str | None = Header(default=None),
                     idempotency_key: str | None = Header(default=None),
                     context_id: str | None = Header(default=None, alias='X-Context-Id'), db=Depends(phone_db)):
    from starlette.concurrency import run_in_threadpool
    from .phone_audio import MAX_INPUT, normalize_phone_audio
    from .services import sha_bytes
    from .turns import accept_turn
    device = authenticate_phone(db, authorization)
    try:
        key = str(UUID(idempotency_key or ''))
    except ValueError:
        raise HTTPException(400, 'Idempotency-Key must be a UUID')
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_INPUT:
            raise HTTPException(413, 'Phone audio exceeds 2 MiB')
    mime = request.headers.get('content-type', '').split(';', 1)[0].strip().lower()
    original = bytes(body)
    canonical = await run_in_threadpool(normalize_phone_audio, original, mime)
    if context_id:
        proposal = db.scalar(select(m.ConfirmationProposal).where(m.ConfirmationProposal.context_id == context_id))
        if proposal:
            phone_proposal(db, device, proposal.id, context_id)
    return accept_turn(request.app, db, device, canonical, sha_bytes(original), key, context_id, background)


@router.get('/turn-receipts/{idempotency_key}')
def turn_receipt(idempotency_key: str, authorization: str | None = Header(default=None), db=Depends(phone_db)):
    device = authenticate_phone(db, authorization)
    try:
        key = str(UUID(idempotency_key))
    except ValueError:
        raise HTTPException(400, 'Idempotency key must be a UUID')
    turn = db.scalar(select(m.VoiceTurn).where(m.VoiceTurn.device_id == device.id, m.VoiceTurn.idempotency_key == key))
    if not turn:
        raise HTTPException(404, 'No accepted turn found for this installation')
    return {'turn_id': turn.id, 'status': turn.status, 'received_at': iso(turn.received_at)}


@router.post('/proposals/{proposal_id}/speech')
async def proposal_speech(proposal_id: str, data: ProposalAction, request: Request,
                          authorization: str | None = Header(default=None), db=Depends(phone_db)):
    from .services import sha_bytes
    from .worker import _provider, _synthesise_sequence
    device = authenticate_phone(db, authorization)
    proposal = phone_proposal(db, device, proposal_id, data.context_id)
    state = proposal.status
    if state not in {'pending', 'committed'} or (state == 'pending' and aware(proposal.expires_at) <= utcnow()):
        raise HTTPException(409, 'Proposal is no longer current')
    spoken = 'Saved.' if state == 'committed' else proposal.readback
    try:
        clips = await _synthesise_sequence(_provider(request.app), spoken)
    except Exception:
        raise HTTPException(503, 'The care state is available, but spoken playback is currently unavailable')
    db.refresh(device)
    db.refresh(proposal)
    if device.revoked_at:
        raise HTTPException(403, 'This phone has been revoked')
    if proposal.status != state or (state == 'pending' and aware(proposal.expires_at) <= utcnow()):
        raise HTTPException(409, 'Proposal changed while speech was being prepared')
    expires = utcnow() + timedelta(minutes=2)
    if state == 'pending':
        expires = min(expires, aware(proposal.expires_at))
    paths = []
    for wav, duration in clips:
        asset = m.AudioAsset(device_id=device.id, context_guard={"proposal_id":proposal.id,"status":state}, wav_bytes=wav, content_sha256=sha_bytes(wav), duration_ms=duration, expires_at=expires)
        db.add(asset)
        db.flush()
        paths.append('/v1/device/audio/' + asset.id)
    db.commit()
    return {'expires_at': iso(expires), 'payload': {'status': state, 'spoken_text': spoken,
             'context_id': proposal.context_id, 'audio_paths': paths, 'record_id': proposal.record_id}}
