"""Explicit deployment provisioning; disabled unless CARELOOP_ADMIN_ENABLED=true."""

import argparse
import os
import secrets
from datetime import timedelta

from sqlalchemy import select

from .config import get_settings
from .database import Database
from .models import AccessGrant, Device, Patient, User
from .security import hash_password, sha256, utcnow


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="CareLoop deployment provisioning")
    commands = root.add_subparsers(dest="command", required=True)
    user = commands.add_parser("create-user")
    user.add_argument("--email", required=True)
    user.add_argument("--name", required=True)
    user.add_argument("--role", choices=["owner", "caregiver"], required=True)
    user.add_argument("--password-env", default="CARELOOP_NEW_USER_PASSWORD")
    patient = commands.add_parser("create-patient")
    patient.add_argument("--name", required=True)
    patient.add_argument("--preferred-name")
    patient.add_argument("--timezone", required=True)
    patient.add_argument("--language", default="en")
    patient.add_argument("--owner-email", required=True)
    device = commands.add_parser("provision-device")
    device.add_argument("--claim-minutes", type=int, default=60)
    return root


def main() -> None:
    args = parser().parse_args()
    settings = get_settings()
    if not settings.admin_enabled:
        raise SystemExit("Provisioning is disabled. Set CARELOOP_ADMIN_ENABLED=true for this command only.")
    database = Database(settings.database_url)
    database.create_all()
    db = database.SessionLocal()
    try:
        if args.command == "create-user":
            password = os.getenv(args.password_env, "")
            if len(password) < 12:
                raise SystemExit("The password environment variable must contain at least 12 characters.")
            email = args.email.strip().lower()
            if db.scalar(select(User).where(User.email == email)):
                raise SystemExit("A user with that email already exists.")
            user = User(email=email, name=args.name.strip(), role=args.role, password_hash=hash_password(password))
            db.add(user); db.commit()
            print("Created user %s (%s)." % (user.id, user.email))
        elif args.command == "create-patient":
            owner = db.scalar(select(User).where(User.email == args.owner_email.strip().lower(), User.active.is_(True)))
            if not owner:
                raise SystemExit("Owner email does not identify an active user.")
            patient = Patient(name=args.name.strip(), preferred_name=args.preferred_name, timezone=args.timezone, language=args.language)
            db.add(patient); db.flush()
            db.add(AccessGrant(user_id=owner.id, patient_id=patient.id, relationship="owner", scopes=["*"]))
            db.commit()
            print("Created patient %s with owner %s." % (patient.id, owner.email))
        elif args.command == "provision-device":
            if not 5 <= args.claim_minutes <= 1440:
                raise SystemExit("Claim lifetime must be between 5 and 1440 minutes.")
            credential = "dev_" + secrets.token_urlsafe(32)
            claim_code = "%s-%s" % (secrets.token_hex(2).upper(), secrets.token_hex(2).upper())
            device = Device(credential_hash=sha256(credential), claim_code_hash=sha256(claim_code), claim_expires_at=utcnow() + timedelta(minutes=args.claim_minutes), capabilities=["wav-16k-mono", "wss-events"])
            db.add(device); db.commit()
            print("Created device %s." % device.id)
            print("One-time claim code: %s" % claim_code)
            print("Device credential (shown once): %s" % credential)
    finally:
        db.close()


if __name__ == "__main__":
    main()
