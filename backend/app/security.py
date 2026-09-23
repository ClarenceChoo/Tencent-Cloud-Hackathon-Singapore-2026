import hashlib
import hmac
import secrets
from datetime import datetime, timezone
from typing import Iterable, Optional, Tuple

from fastapi import HTTPException, Request, WebSocket, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AccessGrant, BrowserSession, Device, User


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$%s$%s" % (salt.hex(), derived.hex())


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, salt_hex, digest_hex = encoded.split("$", 2)
        if algorithm != "scrypt":
            return False
        candidate = hash_password(password, bytes.fromhex(salt_hex)).split("$", 2)[2]
        return hmac.compare_digest(candidate, digest_hex)
    except (ValueError, TypeError):
        return False


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def require_allowed_origin(request: Request) -> None:
    origin = request.headers.get("origin", "").rstrip("/")
    if origin not in request.app.state.settings.allowed_origins:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Origin is not allowed")


def get_browser_session(request: Request, db: Session) -> Tuple[User, BrowserSession]:
    token = request.cookies.get("careloop_session")
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    row = db.scalar(select(BrowserSession).where(BrowserSession.token_hash == sha256(token)))
    if not row or row.revoked_at or aware(row.expires_at) <= utcnow():
        raise HTTPException(status_code=401, detail="Session is invalid or expired")
    user = db.get(User, row.user_id)
    if not user or not user.active:
        raise HTTPException(status_code=401, detail="User is inactive")
    return user, row


def require_csrf(request: Request, session: BrowserSession) -> None:
    require_allowed_origin(request)
    supplied = request.headers.get("x-csrf-token")
    if not supplied or not hmac.compare_digest(sha256(supplied), session.csrf_hash):
        raise HTTPException(status_code=403, detail="CSRF token is invalid")


def grant_scopes(db: Session, user_id: str, patient_id: str) -> Tuple[AccessGrant, list]:
    grant = db.scalar(
        select(AccessGrant).where(
            AccessGrant.user_id == user_id,
            AccessGrant.patient_id == patient_id,
            AccessGrant.revoked_at.is_(None),
        )
    )
    if not grant or (grant.expires_at and aware(grant.expires_at) <= utcnow()):
        raise HTTPException(status_code=403, detail="Patient access is not permitted")
    return grant, list(grant.scopes or [])


def require_scope(scopes: Iterable[str], *accepted: str) -> None:
    available = set(scopes)
    if "*" not in available and not available.intersection(accepted):
        raise HTTPException(status_code=403, detail="Permission scope is insufficient")


def _bearer(value: Optional[str]) -> str:
    if not value or not value.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Device credential required")
    token = value[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Device credential required")
    return token


def authenticate_device_header(db: Session, authorization: Optional[str]) -> Device:
    token = _bearer(authorization)
    device = db.scalar(select(Device).where(Device.credential_hash == sha256(token)))
    if not device:
        raise HTTPException(status_code=401, detail="Device credential is invalid")
    if device.revoked_at or not device.patient_id:
        raise HTTPException(status_code=403, detail="Device is revoked or unbound")
    return device


def authenticate_device_websocket(db: Session, websocket: WebSocket) -> Device:
    return authenticate_device_header(db, websocket.headers.get("authorization"))


def iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return aware(value).isoformat().replace("+00:00", "Z")
    return value.isoformat()
