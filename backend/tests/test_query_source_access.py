"""Opening evidence rechecks patient, category, and row access."""

from datetime import datetime, timezone

from app import models as m
from conftest import login
from test_care_queries import seed_proposals


def _source(client, patient_id, kind, source_id):
    return client.get(f"/v1/app/patients/{patient_id}/query-sources/{kind}/{source_id}")


def test_source_rechecks_hidden_cross_patient_revoked_and_corrected_rows(env):
    client, app, ids = env
    db = app.state.db.SessionLocal()
    timestamp = datetime(2026, 5, 1, tzinfo=timezone.utc)
    seed_proposals(db, [
        ("proposal_s1", ids["patient"], "support_request", "support_visible"),
        ("proposal_s2", ids["patient"], "support_request", "support_hidden"),
        ("proposal_s3", ids["other_patient"], "support_request", "support_elsewhere"),
        ("proposal_m1", ids["patient"], "measurement", "measurement_corrected"),
    ])
    db.add_all([
        m.SupportRequest(id="support_visible", patient_id=ids["patient"], request_text="Visible fictional request",
                         recipient_user_id=ids["caregiver"], status="sent", proposal_id="proposal_s1", created_at=timestamp),
        m.SupportRequest(id="support_hidden", patient_id=ids["patient"], request_text="Private fictional request",
                         recipient_user_id=ids["caregiver_two"], status="sent", proposal_id="proposal_s2", created_at=timestamp),
        m.SupportRequest(id="support_elsewhere", patient_id=ids["other_patient"], request_text="Other care space",
                         recipient_user_id=ids["outsider"], status="sent", proposal_id="proposal_s3", created_at=timestamp),
        m.Measurement(id="measurement_corrected", patient_id=ids["patient"], measurement_type="blood_pressure",
                      systolic=130, diastolic=90, unit="mmHg", timezone="Asia/Singapore",
                      source_description="Fictional cuff", reporting_actor="patient", proposal_id="proposal_m1",
                      created_at=timestamp, superseded_at=timestamp),
    ])
    db.commit()
    db.close()
    caregiver = login(client, "caregiver@example.invalid", "caregiver-password")
    visible = _source(client, ids["patient"], "support_request", "support_visible")
    assert visible.status_code == 200
    assert visible.headers["Cache-Control"] == "private, no-store"
    assert visible.json()["status"] == "sent"
    for kind, source_id in [("support_request", "support_hidden"),
                            ("support_request", "support_elsewhere"),
                            ("measurement", "measurement_corrected")]:
        result = _source(client, ids["patient"], kind, source_id)
        assert result.status_code == 404
        assert result.headers["Cache-Control"] == "private, no-store"
        assert "Private fictional request" not in result.text
    db = app.state.db.SessionLocal()
    row = db.get(m.SupportRequest, "support_visible")
    row.status = "acknowledged"
    db.commit()
    db.close()
    assert _source(client, ids["patient"], "support_request", "support_visible").json()["status"] == "acknowledged"
    db = app.state.db.SessionLocal()
    grant = db.query(m.AccessGrant).filter_by(user_id=ids["caregiver"], patient_id=ids["patient"]).one()
    grant.scopes = ["read:measurements"]
    db.commit()
    db.close()
    assert _source(client, ids["patient"], "support_request", "support_visible").status_code == 403
    assert _source(client, ids["patient"], "measurement", "measurement_corrected").status_code == 404


def test_query_read_has_no_record_mutation(env):
    client, app, ids = env
    headers = login(client)
    db = app.state.db.SessionLocal()
    before = tuple(db.query(model).count() for model in (m.ConfirmationProposal, m.AuditEvent, m.Measurement,
                                                           m.SupportRequest, m.DoseInstance))
    db.close()
    for kind in ("latest_reading", "open_support"):
        result = client.post(f"/v1/app/patients/{ids['patient']}/queries", json={"kind": kind}, headers=headers)
        assert result.status_code == 200
        assert result.json()["items"] == []
    db = app.state.db.SessionLocal()
    after = tuple(db.query(model).count() for model in (m.ConfirmationProposal, m.AuditEvent, m.Measurement,
                                                          m.SupportRequest, m.DoseInstance))
    db.close()
    assert after == before
