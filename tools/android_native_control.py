#!/usr/bin/env python3
"""Queue a reminder only in an already-created fictional Android runtime fixture.

Uses the production scheduler and WAV-tone provider. It never reads installation
credentials or opens an HTTP listener. Not a production administration tool.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["enqueue", "inspect"])
    parser.add_argument("--kind", choices=["medication", "checkin"], default="medication")
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.is_relative_to(ROOT / "runtime") or not (directory / "fixture.json").is_file():
        raise SystemExit("Use an existing, private runtime native fixture.")
    metadata = json.loads((directory / "fixture.json").read_text())
    if not metadata["origin"].startswith("https://127.0.0.1:") or not (directory / "fixture.db").is_file():
        raise SystemExit("Not a loopback native fixture.")
    os.environ.update(CARELOOP_PROVIDER="fixture", CARELOOP_TESTING="true",
                      CARELOOP_FIXTURE_REPLY_WAV=str(directory / "reply.wav"))
    from sqlalchemy import select
    from app import models as m, worker
    from app.config import Settings
    from app.main import create_app
    from app.providers import FixtureProvider
    from app.security import utcnow
    app = create_app(Settings(_env_file=None, database_url="sqlite:///" + str(directory / "fixture.db"),
                             testing=True, development_seed=False, scheduler_enabled=False, expo_push_enabled=False))
    provider = FixtureProvider({}, str(directory / "reply.wav"))
    worker._provider = lambda _app: provider
    with app.state.db.SessionLocal() as db:
        if not db.scalar(select(m.User).where(m.User.email == "owner@native.invalid", m.User.role == "owner")):
            raise SystemExit("Fictional native owner marker not found.")
        patient = db.get(m.Patient, metadata["patient_id"])
        if not patient or patient.name != "Fictional Mei Tan":
            raise SystemExit("Unexpected fixture patient.")
        result = {"kind": args.kind}
        existing_checkins = set(db.scalars(select(m.CheckInDelivery.id).where(m.CheckInDelivery.patient_id == patient.id)).all())
        if args.mode == "enqueue":
            if args.kind == "medication":
                plan = db.scalar(select(m.MedicationPlanVersion).where(m.MedicationPlanVersion.patient_id == patient.id,
                                                                      m.MedicationPlanVersion.active.is_(True)))
                if not plan or not plan.medicines:
                    raise SystemExit("Create a fictional checked medication plan through the owner API first.")
                medicine = plan.medicines[0]
                dose = m.DoseInstance(patient_id=patient.id, plan_id=plan.id, plan_version=plan.version,
                                      medicine_id=medicine["id"], medicine_name=medicine["name"], scheduled_at=utcnow())
                db.add(dose)
                db.flush()
                result["dose_id"] = dose.id
            else:
                patient.daily_check_in_enabled = True
                patient.daily_check_in_local_time = utcnow().astimezone(ZoneInfo(patient.timezone)).strftime("%H:%M")
            db.commit()
    if args.mode == "enqueue":
        asyncio.run(worker.scheduler_tick(app))
    with app.state.db.SessionLocal() as db:
        query = (select(m.ReminderCommand).join(m.DoseInstance)
                 .where(m.DoseInstance.patient_id == metadata["patient_id"])) if args.kind == "medication" else (
                    select(m.CheckInDelivery).where(m.CheckInDelivery.patient_id == metadata["patient_id"]))
        attempts = db.scalars(query).all()
        result["attempts"] = [{"id": a.id, "delivery_state": a.delivery_state, "route_generation": a.route_generation,
                               "occurrence_id": a.occurrence_id,
                               "acks": [{"stage": ack.stage, "id": ack.ack_id} for ack in db.scalars(select(m.ReminderAck).where(m.ReminderAck.command_id == a.id)).all()]}
                              for a in attempts]
        if args.kind == "medication" and result.get("dose_id"):
            result["command_id"] = next(a.id for a in attempts if a.dose_instance_id == result["dose_id"])
        elif args.kind == "checkin" and args.mode == "enqueue":
            created = [a for a in attempts if a.id not in existing_checkins]
            if len(created) != 1:
                raise SystemExit("This fixture did not create one new daily check-in; do not count an old delivery as a new native test.")
            result["command_id"] = created[0].id
    print(json.dumps(result))


if __name__ == "__main__":
    main()
