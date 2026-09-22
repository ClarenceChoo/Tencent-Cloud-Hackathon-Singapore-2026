import io
import os
import wave
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.config import Settings
from app.main import create_app
from app.models import AccessGrant, Device, Patient, User
from app.security import hash_password, sha256, utcnow


ORIGIN = "http://testserver"


def wav_bytes(seconds=0.4):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buffer.getvalue()


@pytest.fixture
def env(tmp_path):
    postgres_url = os.getenv("CARELOOP_TEST_DATABASE_URL")
    admin_engine = None
    schema = None
    if postgres_url:
        parsed = make_url(postgres_url)
        if parsed.get_backend_name() != "postgresql":
            raise RuntimeError("CARELOOP_TEST_DATABASE_URL must use PostgreSQL")
        schema = "careloop_test_%s" % uuid4().hex
        admin_url = parsed.difference_update_query(["options"])
        admin_engine = create_engine(admin_url, pool_pre_ping=True)
        with admin_engine.begin() as connection:
            connection.execute(text('CREATE SCHEMA "%s"' % schema))
        database_url = parsed.update_query_dict({"options": "-csearch_path=%s" % schema}).render_as_string(hide_password=False)
    else:
        database_url = "sqlite:///%s" % (tmp_path / "test.db")
    settings = Settings(
        database_url=database_url,
        allowed_origins=[ORIGIN],
        cookie_secure=False,
        testing=True,
        scheduler_enabled=False,
    )
    app = create_app(settings)
    try:
        with TestClient(app, base_url=ORIGIN) as client:
            db = app.state.db.SessionLocal()
            owner = User(name="Owner", email="owner@example.invalid", role="owner", password_hash=hash_password("owner-password"))
            caregiver = User(name="Caregiver", email="caregiver@example.invalid", role="caregiver", password_hash=hash_password("caregiver-password"))
            caregiver_two = User(name="Second Caregiver", email="caregiver2@example.invalid", role="caregiver", password_hash=hash_password("caregiver2-password"))
            outsider = User(name="Outsider", email="outsider@example.invalid", role="caregiver", password_hash=hash_password("outsider-password"))
            patient = Patient(name="Fictional Patient", preferred_name="Pat", timezone="Asia/Singapore", language="en")
            other_patient = Patient(name="Other Patient", timezone="Asia/Singapore", language="en")
            db.add_all([owner, caregiver, caregiver_two, outsider, patient, other_patient])
            db.flush()
            owner_grant = AccessGrant(user_id=owner.id, patient_id=patient.id, relationship="owner", scopes=["*"])
            caregiver_grant = AccessGrant(user_id=caregiver.id, patient_id=patient.id, relationship="caregiver", scopes=["read:dashboard", "ack:support"])
            caregiver_two_grant = AccessGrant(user_id=caregiver_two.id, patient_id=patient.id, relationship="caregiver", scopes=["read:dashboard", "write:care", "ack:support", "resolve:support"])
            outsider_grant = AccessGrant(user_id=outsider.id, patient_id=other_patient.id, relationship="owner", scopes=["*"])
            credential = "device-test-credential"
            claim_code = "TEST-CODE"
            device = Device(credential_hash=sha256(credential), patient_id=patient.id, claimed_at=utcnow(), capabilities=["wav-16k-mono"])
            unclaimed = Device(credential_hash=sha256("unclaimed-credential"), claim_code_hash=sha256(claim_code), claim_expires_at=utcnow() + timedelta(hours=1))
            db.add_all([owner_grant, caregiver_grant, caregiver_two_grant, outsider_grant, device, unclaimed])
            db.commit()
            ids = {"owner": owner.id, "caregiver": caregiver.id, "caregiver_two": caregiver_two.id, "outsider": outsider.id, "patient": patient.id, "other_patient": other_patient.id, "device": device.id, "unclaimed": unclaimed.id, "credential": credential, "claim_code": claim_code}
            db.close()
            yield client, app, ids
    finally:
        app.state.db.engine.dispose()
        if admin_engine is not None and schema is not None:
            with admin_engine.begin() as connection:
                connection.execute(text('DROP SCHEMA "%s" CASCADE' % schema))
            admin_engine.dispose()


def login(client, email="owner@example.invalid", password="owner-password"):
    response = client.post("/v1/auth/login", json={"email": email, "password": password}, headers={"Origin": ORIGIN})
    assert response.status_code == 200, response.text
    return {"Origin": ORIGIN, "X-CSRF-Token": response.json()["csrf_token"]}
