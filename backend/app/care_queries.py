"""Bounded, read-only queries over currently permitted care evidence."""

from datetime import datetime, time, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models as m
from .provenance import CareEvidence
from .schemas import QueryRequest
from .security import iso, require_scope, utcnow


SourceKind = Literal["measurement", "support_request", "dose"]


def _permit(scopes: list[str], category: str) -> None:
    require_scope(scopes, "read:dashboard", f"read:{category}")


def _evidence(db: Session, patient_id: str, kind: SourceKind, rows: list) -> CareEvidence:
    return CareEvidence(db, patient_id, **{
        {"measurement": "measurements", "support_request": "supports", "dose": "doses"}[kind]: rows
    })


def _item(row, kind: SourceKind, evidence: CareEvidence) -> dict:
    common = {
        "source_type": kind,
        "source_id": row.id,
        "source_version": row.version if kind == "measurement" else None,
        "recorded_at": iso(row.created_at) if kind != "dose" else iso(row.report_time),
        "occurred_at": iso(row.occurred_at) if kind == "measurement" else None,
    }
    if kind == "measurement":
        return {**common, "measurement_type": row.measurement_type, "systolic": row.systolic,
                "diastolic": row.diastolic, "unit": row.unit, "occurrence_text": row.occurrence_text,
                "timezone": row.timezone, "source_description": row.source_description,
                "reporting_actor": row.reporting_actor, "provenance": evidence.source(row.proposal_id)}
    if kind == "support_request":
        return {**common, "request_text": row.request_text, "status": row.status,
                "urgency": row.urgency, "recipient_user_id": row.recipient_user_id,
                "barrier_text": row.barrier_text, "acknowledged_at": iso(row.acknowledged_at),
                "resolved_at": iso(row.resolved_at), "outcome": row.outcome,
                "provenance": evidence.source(row.proposal_id)}
    history = evidence.reports[row.id]
    return {**common, "plan_version": row.plan_version, "medicine_id": row.medicine_id,
            "medicine_name": row.medicine_name, "scheduled_at": iso(row.scheduled_at),
            "report_state": row.report_state if history else "unreported",
            "report_time": iso(row.report_time) if history else None,
            "taken_time_text": row.taken_time_text if history else None,
            "report_history": history,
            "provenance": evidence.source(row.confirmation_proposal_id) if history else None}


def run_care_query(db: Session, patient: m.Patient, viewer_user_id: str,
                   scopes: list[str], query: QueryRequest) -> dict:
    category = {"latest_reading": "measurements", "open_support": "support",
                "medication_reports": "medications"}[query.kind]
    _permit(scopes, category)
    if query.kind == "latest_reading":
        kind: SourceKind = "measurement"
        rows = db.scalars(select(m.Measurement).where(
            m.Measurement.patient_id == patient.id,
            m.Measurement.measurement_type == "blood_pressure",
            m.Measurement.superseded_at.is_(None),
        ).order_by(m.Measurement.created_at.desc(), m.Measurement.id.desc()).limit(1)).all()
        basis = "recorded_at"
    elif query.kind == "open_support":
        kind = "support_request"
        statement = select(m.SupportRequest).where(
            m.SupportRequest.patient_id == patient.id,
            m.SupportRequest.status != "resolved",
            m.SupportRequest.resolved_at.is_(None),
        )
        if "*" not in scopes:
            statement = statement.where(m.SupportRequest.recipient_user_id == viewer_user_id)
        rows = db.scalars(statement.order_by(
            m.SupportRequest.created_at.desc(), m.SupportRequest.id.desc()).limit(51)).all()
        basis = "recorded_at"
    else:
        kind = "dose"
        # Two local midnights independently converted to UTC handle 23/25-hour DST days.
        zone = ZoneInfo(patient.timezone)
        start = datetime.combine(query.local_date, time.min, zone).astimezone(timezone.utc)
        end = datetime.combine(query.local_date + timedelta(days=1), time.min, zone).astimezone(timezone.utc)
        rows = db.scalars(select(m.DoseInstance).where(
            m.DoseInstance.patient_id == patient.id,
            m.DoseInstance.scheduled_at >= start,
            m.DoseInstance.scheduled_at < end,
        ).order_by(m.DoseInstance.scheduled_at, m.DoseInstance.id).limit(51)).all()
        basis = "scheduled_local_date"
    truncated = len(rows) > 50
    visible = rows[:50]
    evidence = _evidence(db, patient.id, kind, visible)
    return {"kind": query.kind, "generated_at": iso(utcnow()), "timezone": patient.timezone,
            "date_basis": basis, "local_date": iso(query.local_date),
            "items": [_item(row, kind, evidence) for row in visible], "truncated": truncated}


def load_query_source(db: Session, patient: m.Patient, viewer_user_id: str,
                      scopes: list[str], kind: SourceKind, source_id: str) -> dict:
    _permit(scopes, {"measurement": "measurements", "support_request": "support",
                     "dose": "medications"}[kind])
    model = {"measurement": m.Measurement, "support_request": m.SupportRequest,
             "dose": m.DoseInstance}[kind]
    row = db.scalar(select(model).where(model.id == source_id, model.patient_id == patient.id))
    if (row is None or (kind == "measurement" and
                       (row.measurement_type != "blood_pressure" or row.superseded_at is not None)) or
            (kind == "support_request" and "*" not in scopes and
             row.recipient_user_id != viewer_user_id)):
        raise HTTPException(status_code=404, detail="Source is unavailable")
    return _item(row, kind, _evidence(db, patient.id, kind, [row]))
