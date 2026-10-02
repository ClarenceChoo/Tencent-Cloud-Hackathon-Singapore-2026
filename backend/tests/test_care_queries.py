"""Ask Parse returns only bounded, currently permitted care evidence."""

from datetime import date, datetime, timedelta, timezone

from app import models as m
from conftest import ORIGIN, login


def _query(client, patient_id, headers, kind, local_date=None):
    body = {"kind": kind}
    if local_date is not None:
        body["local_date"] = local_date
    return client.post(f"/v1/app/patients/{patient_id}/queries", json=body, headers=headers)


def seed_proposals(db, records):
    timestamp = datetime(2026, 5, 1, tzinfo=timezone.utc)
    db.add_all([m.ConfirmationProposal(
        id=proposal_id, patient_id=patient_id, kind=kind, payload={}, readback="Fictional confirmation",
        context_id=f"context_{proposal_id}", status="committed", created_at=timestamp,
        confirmed_at=timestamp, expires_at=timestamp + timedelta(days=1),
        record_type=kind, record_id=record_id,
    ) for proposal_id, patient_id, kind, record_id in records])
    db.flush()


def _seed_measurements(app, patient_id):
    db = app.state.db.SessionLocal()
    seed_proposals(db, [(f"proposal_{name}", patient_id, "measurement", f"measurement_{name}")
                        for name in ("a", "b")] +
                   [("proposal_old", patient_id, "measurement", "measurement_old")])
    recorded = datetime(2026, 5, 1, tzinfo=timezone.utc)
    rows = [m.Measurement(id=f"measurement_{name}", patient_id=patient_id,
                          measurement_type="blood_pressure", systolic=120, diastolic=80,
                          unit="mmHg", timezone="Asia/Singapore", source_description="Fictional home cuff",
                          reporting_actor="patient", proposal_id=f"proposal_{name}", created_at=recorded,
                          occurred_at=None) for name in ("a", "b")]
    rows.append(m.Measurement(id="measurement_old", patient_id=patient_id,
                              measurement_type="blood_pressure", systolic=140, diastolic=90,
                              unit="mmHg", timezone="Asia/Singapore", source_description="Fictional home cuff",
                              reporting_actor="patient", proposal_id="proposal_old", created_at=recorded + timedelta(days=1),
                              superseded_at=recorded + timedelta(days=2)))
    db.add_all(rows)
    db.commit()
    db.close()


def test_reading_order_excludes_superseded_and_reports_unknown_occurrence(env):
    client, app, ids = env
    _seed_measurements(app, ids["patient"])
    headers = login(client)
    response = _query(client, ids["patient"], headers, "latest_reading")
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "private, no-store"
    data = response.json()
    assert data["date_basis"] == "recorded_at"
    assert data["truncated"] is False
    assert len(data["items"]) == 1
    assert data["items"][0]["source_id"] == "measurement_b"
    assert data["items"][0]["occurred_at"] is None
    assert data["items"][0]["recorded_at"] == "2026-05-01T00:00:00Z"


def test_category_permission_validation_and_csrf_are_distinct(env):
    client, app, ids = env
    headers = login(client)
    assert _query(client, ids["patient"], headers, "medication_reports").status_code == 422
    assert _query(client, ids["patient"], headers, "open_support", "2026-05-01").status_code == 422
    assert _query(client, ids["patient"], headers, "anything_else").status_code == 422
    assert _query(client, ids["patient"], {"Origin": ORIGIN}, "latest_reading").status_code == 403
    assert _query(client, ids["patient"], {"X-CSRF-Token": headers["X-CSRF-Token"]}, "latest_reading").status_code == 403
    client.post("/v1/auth/logout", headers=headers)
    db = app.state.db.SessionLocal()
    grant = db.query(m.AccessGrant).filter_by(user_id=ids["caregiver"], patient_id=ids["patient"]).one()
    grant.scopes = ["read:measurements"]
    db.commit()
    db.close()
    caregiver = login(client, "caregiver@example.invalid", "caregiver-password")
    assert _query(client, ids["patient"], caregiver, "latest_reading").status_code == 200
    forbidden = _query(client, ids["patient"], caregiver, "open_support")
    assert forbidden.status_code == 403
    assert forbidden.headers["Cache-Control"] == "private, no-store"
    assert _query(client, ids["patient"], caregiver, "medication_reports", "2026-05-01").status_code == 403


def test_support_row_filter_precedes_limit_and_matches_dashboard(env):
    client, app, ids = env
    db = app.state.db.SessionLocal()
    start = datetime(2026, 5, 1, tzinfo=timezone.utc)
    seed_proposals(db, [(f"support_proposal_{n}", ids["patient"], "support_request", f"support_{n:03d}")
                        for n in range(63)])
    rows = [m.SupportRequest(id=f"support_{n:03d}", patient_id=ids["patient"],
                             request_text=f"Fictional request {n}", recipient_user_id=ids["caregiver_two"] if n < 60 else ids["caregiver"],
                             status="sent", proposal_id=f"support_proposal_{n}", created_at=start + timedelta(minutes=n))
            for n in range(63)]
    rows[-1].status = "resolved"
    db.add_all(rows)
    db.commit()
    db.close()
    caregiver = login(client, "caregiver@example.invalid", "caregiver-password")
    data = _query(client, ids["patient"], caregiver, "open_support").json()
    assert [row["source_id"] for row in data["items"]] == ["support_061", "support_060"]
    assert data["truncated"] is False
    dashboard = client.get(f"/v1/app/patients/{ids['patient']}/dashboard").json()
    assert {row["source_id"] for row in data["items"]}.issubset({row["id"] for row in dashboard["support_requests"]})
    assert "support_059" not in str(data)
    client.post("/v1/auth/logout", headers=caregiver)
    owner = login(client)
    owner_data = _query(client, ids["patient"], owner, "open_support").json()
    assert len(owner_data["items"]) == 50
    assert owner_data["truncated"] is True
    assert "total" not in owner_data


def test_historical_doses_use_patient_local_dst_bounds_not_dashboard_cap(env):
    client, app, ids = env
    db = app.state.db.SessionLocal()
    patient = db.get(m.Patient, ids["patient"])
    patient.timezone = "America/New_York"
    plan = m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone=patient.timezone,
                                   source="Fictional plan", checked_by_user_id=ids["owner"],
                                   checked_by_name="Owner", medicines=[], schedule=[], active=True)
    db.add(plan)
    db.flush()
    historical = datetime(2026, 3, 8, 5, 30, tzinfo=timezone.utc)
    after_midnight = datetime(2026, 3, 9, 3, 30, tzinfo=timezone.utc)
    outside = datetime(2026, 3, 9, 4, 30, tzinfo=timezone.utc)
    doses = [m.DoseInstance(id=f"dose_hist_{n:03d}", patient_id=ids["patient"], plan_id=plan.id,
                            plan_version=1, medicine_id="med", medicine_name="Fictional medicine",
                            scheduled_at=historical + timedelta(minutes=n), report_state="unconfirmed")
             for n in range(10)]
    doses += [m.DoseInstance(id="dose_late", patient_id=ids["patient"], plan_id=plan.id,
                             plan_version=1, medicine_id="med", medicine_name="Fictional medicine",
                             scheduled_at=after_midnight),
              m.DoseInstance(id="dose_outside", patient_id=ids["patient"], plan_id=plan.id,
                             plan_version=1, medicine_id="med", medicine_name="Fictional medicine",
                             scheduled_at=outside)]
    doses += [m.DoseInstance(id=f"dose_future_{n:03d}", patient_id=ids["patient"], plan_id=plan.id,
                             plan_version=1, medicine_id="med", medicine_name="Fictional medicine",
                             scheduled_at=datetime(2026, 6, 1, tzinfo=timezone.utc) + timedelta(minutes=n))
              for n in range(101)]
    db.add_all(doses)
    db.commit()
    db.close()
    headers = login(client)
    result = _query(client, ids["patient"], headers, "medication_reports", "2026-03-08")
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["timezone"] == "America/New_York"
    assert data["date_basis"] == "scheduled_local_date"
    assert data["local_date"] == "2026-03-08"
    assert [r["source_id"] for r in data["items"]] == [f"dose_hist_{n:03d}" for n in range(10)] + ["dose_late"]
    assert data["items"][0]["report_state"] == "unreported"
    assert data["items"][0]["report_history"] == []
    assert "dose_outside" not in str(data)
    dashboard = client.get(f"/v1/app/patients/{ids['patient']}/dashboard").json()
    assert not any(r["id"].startswith("dose_hist") for r in dashboard["doses"])
