"""Read-only status answers are rendered from care records, never model prose."""

import hashlib
import json

from . import models as m
from .security import iso


def status_reply(db, patient_id, kind, record_id):
    model = {"support_status": m.SupportRequest, "followup_status": m.FollowUp}.get(
        kind
    )
    item = (
        db.get(model, record_id, populate_existing=True)
        if model and isinstance(record_id, str) and len(record_id) <= 64
        else None
    )
    if not item or item.patient_id != patient_id:
        return (
            "Which support request or follow-up do you mean? Please identify it so I can check the record.",
            None,
        )
    if kind == "support_status":
        facts = [
            item.status,
            iso(item.acknowledged_at),
            iso(item.resolved_at),
            item.outcome,
        ]
        if item.status == "resolved":
            text = "The caregiver marked this support request resolved."
            if item.outcome:
                text += " The recorded outcome is: " + item.outcome
        elif item.status == "acknowledged" and item.acknowledged_at:
            text = "The recipient has acknowledged this support request. No resolution has been recorded."
        else:
            text = "This support request is recorded, but the recipient has not acknowledged it. Parse cannot say that anyone has seen it."
    else:
        facts = [item.resolution_state, item.reported_outcome, iso(item.check_at)]
        if item.resolution_state == "resolved":
            text = "This follow-up has a confirmed reported outcome: " + (
                item.reported_outcome or "No outcome text was recorded."
            )
        else:
            text = (
                "This follow-up is still open. No confirmed outcome has been recorded."
            )
    digest = hashlib.sha256(
        json.dumps(facts, separators=(",", ":")).encode()
    ).hexdigest()
    return text, {"kind": kind, "record_id": item.id, "version": digest}
