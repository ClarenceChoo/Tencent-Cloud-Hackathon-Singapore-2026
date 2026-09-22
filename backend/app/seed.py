"""Create a visibly fictional local demo account and one unclaimed device."""

import secrets
from datetime import timedelta

from sqlalchemy import select

from .config import get_settings
from .database import Database
from .models import AccessGrant, Device, Patient, User
from .security import hash_password, sha256, utcnow


def main() -> None:
    settings = get_settings()
    if not settings.development_seed:
        raise SystemExit("Refusing to seed. Set CARELOOP_DEVELOPMENT_SEED=true to create fictional demo data.")
    db_manager = Database(settings.database_url)
    db_manager.create_all()
    db = db_manager.SessionLocal()
    try:
        existing = db.scalar(select(User).where(User.email == "owner@careloop.invalid"))
        if existing:
            print("Fictional seed already exists; no credentials or claim codes were changed.")
            return
        owner = User(name="Fictional Alex Tan", email="owner@careloop.invalid", role="owner", password_hash=hash_password("fictional-demo-only"))
        caregiver = User(name="Fictional Jamie Lim", email="caregiver@careloop.invalid", role="caregiver", password_hash=hash_password("fictional-caregiver-only"))
        patient = Patient(name="Fictional Mei Tan", preferred_name="Mei", timezone="Asia/Singapore", language="en")
        db.add_all([owner, caregiver, patient])
        db.flush()
        db.add_all([
            AccessGrant(user_id=owner.id, patient_id=patient.id, relationship="owner", scopes=["*"]),
            AccessGrant(user_id=caregiver.id, patient_id=patient.id, relationship="caregiver", scopes=["read:dashboard", "ack:support", "resolve:support", "write:care"]),
        ])
        credential = "dev_" + secrets.token_urlsafe(32)
        claim_code = "%s-%s" % (secrets.token_hex(2).upper(), secrets.token_hex(2).upper())
        device = Device(credential_hash=sha256(credential), claim_code_hash=sha256(claim_code), claim_expires_at=utcnow() + timedelta(hours=1), capabilities=["wav-16k-mono", "wss-events"])
        db.add(device)
        db.commit()
        print("Created FICTIONAL development data only.")
        print("Owner login: owner@careloop.invalid / fictional-demo-only")
        print("Caregiver login: caregiver@careloop.invalid / fictional-caregiver-only")
        print("Patient ID: %s" % patient.id)
        print("One-time claim code (expires in 1 hour): %s" % claim_code)
        print("Device credential (store in firmware secrets, shown once): %s" % credential)
    finally:
        db.close()


if __name__ == "__main__":
    main()
