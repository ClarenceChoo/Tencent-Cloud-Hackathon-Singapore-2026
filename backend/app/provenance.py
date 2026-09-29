"""Expose confirmation provenance only for records already authorized by the caller."""

from collections import defaultdict
from sqlalchemy import select

from . import models as m
from .security import iso


class CareEvidence:
    def __init__(
        self,
        db,
        patient_id,
        *,
        doses=(),
        notes=(),
        measurements=(),
        tasks=(),
        supports=(),
        followups=(),
    ):
        self.sources = {}
        self.transitions = defaultdict(list)
        self.resolutions = defaultdict(list)
        self.reports = defaultdict(list)
        task_ids = [row.id for row in tasks]
        followup_ids = [row.id for row in followups]
        dose_ids = [row.id for row in doses]
        transitions = (
            db.scalars(
                select(m.PreventiveTransition)
                .where(m.PreventiveTransition.task_id.in_(task_ids))
                .order_by(m.PreventiveTransition.created_at, m.PreventiveTransition.id)
            ).all()
            if task_ids
            else []
        )
        resolutions = (
            db.scalars(
                select(m.FollowUpResolution)
                .where(m.FollowUpResolution.followup_id.in_(followup_ids))
                .order_by(m.FollowUpResolution.created_at, m.FollowUpResolution.id)
            ).all()
            if followup_ids
            else []
        )
        reports = (
            db.scalars(
                select(m.ConfirmationProposal)
                .where(
                    m.ConfirmationProposal.patient_id == patient_id,
                    m.ConfirmationProposal.kind == "medication_report",
                    m.ConfirmationProposal.status == "committed",
                    m.ConfirmationProposal.record_id.in_(dose_ids),
                )
                .order_by(
                    m.ConfirmationProposal.confirmed_at, m.ConfirmationProposal.id
                )
            ).all()
            if dose_ids
            else []
        )
        proposal_ids = {
            row.proposal_id
            for row in [
                *notes,
                *measurements,
                *supports,
                *followups,
                *transitions,
                *resolutions,
            ]
        }
        proposal_ids.update(row.last_proposal_id for row in tasks)
        proposal_ids.update(
            row.confirmation_proposal_id
            for row in doses
            if row.confirmation_proposal_id
        )
        proposal_ids.update(row.id for row in reports)
        if proposal_ids:
            rows = db.execute(
                select(m.ConfirmationProposal, m.VoiceTurn, m.Device)
                .outerjoin(
                    m.VoiceTurn, m.VoiceTurn.id == m.ConfirmationProposal.source_turn_id
                )
                .outerjoin(m.Device, m.Device.id == m.VoiceTurn.device_id)
                .where(
                    m.ConfirmationProposal.id.in_(proposal_ids),
                    m.ConfirmationProposal.patient_id == patient_id,
                    m.ConfirmationProposal.status == "committed",
                )
            ).all()
            for proposal, turn, device in rows:
                kind = "unknown"
                if (
                    turn
                    and device
                    and turn.patient_id == patient_id
                    and device.patient_id == patient_id
                ):
                    kind = (
                        device.device_type
                        if device.device_type in {"phone", "pendant"}
                        else "unknown"
                    )
                elif not proposal.source_turn_id and proposal.created_by_user_id:
                    kind = "dashboard"
                self.sources[proposal.id] = {
                    "type": kind,
                    "device_id": device.id if kind in {"phone", "pendant"} else None,
                    "turn_id": turn.id if kind in {"phone", "pendant"} else None,
                    "proposal_id": proposal.id,
                    "confirmed_at": iso(proposal.confirmed_at),
                }
        for row in transitions:
            self.transitions[row.task_id].append(
                {
                    "id": row.id,
                    "from_state": row.from_state,
                    "to_state": row.to_state,
                    "appointment_date": iso(row.appointment_date),
                    "completion_date": iso(row.completion_date),
                    "created_at": iso(row.created_at),
                    "provenance": self.source(row.proposal_id),
                }
            )
        for row in resolutions:
            self.resolutions[row.followup_id].append(
                {
                    "id": row.id,
                    "reported_outcome": row.reported_outcome,
                    "created_at": iso(row.created_at),
                    "provenance": self.source(row.proposal_id),
                }
            )
        for row in reports:
            self.reports[row.record_id].append(
                {
                    "id": row.id,
                    "report_state": row.payload["report_state"],
                    "taken_time_text": row.payload.get("taken_time_text"),
                    "confirmed_at": iso(row.confirmed_at),
                    "provenance": self.source(row.id),
                }
            )

    def source(self, proposal_id):
        # Absence of a voice turn is not evidence that a dashboard created it.
        return self.sources.get(
            proposal_id,
            {
                "type": "unknown",
                "device_id": None,
                "turn_id": None,
                "proposal_id": None,
                "confirmed_at": None,
            },
        )
