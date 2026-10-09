"""Same-origin browser transport for the existing phone and device care routes.

Only the server sees the installation credential. The narrow route map below
forwards to the existing ASGI handlers with an internal Authorization header.
"""
import hashlib
import hmac
import json
import asyncio
import logging
import re
import secrets
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from . import models as m
from .phone import EnrollmentCreate, enroll, enrollment_view, phone_db
from .routing import route_view
from .security import aware, sha256, utcnow

router = APIRouter(prefix="/v1/web", tags=["web companion"])
logger = logging.getLogger(__name__)
COOKIE = "parse_web_installation"
COOKIE_AGE = 365 * 24 * 3600
TOKEN = re.compile(r"[a-f0-9]{64}\Z")


class WebEnrollment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(min_length=1, max_length=80)


def _csrf(token: str) -> str:
    return hashlib.sha256(b"parse-web-csrf-v1:" + bytes.fromhex(token)).hexdigest()


def _cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(COOKIE, token, max_age=COOKIE_AGE, path="/v1/web",
                        httponly=True, secure=_secure(request),
                        samesite="strict")


def _secure(request: Request) -> bool:
    settings = request.app.state.settings
    return not settings.testing or settings.cookie_secure


def _token(request: Request) -> str | None:
    value = request.cookies.get(COOKIE)
    return value if value and TOKEN.fullmatch(value) else None


def _device(db, token: str | None):
    return db.scalar(select(m.Device).where(m.Device.credential_hash == sha256(token),
        m.Device.device_type == "phone", m.Device.platform == "web")) if token else None


def _check(request: Request, *, unsafe: bool, token: str | None = None, csrf: bool = False) -> None:
    if request.url.scheme != "https" and not request.app.state.settings.testing:
        raise HTTPException(400, "Browser companion requires HTTPS")
    if "authorization" in request.headers:
        raise HTTPException(400, "Authorization is not accepted on browser companion routes")
    origin = request.headers.get("origin", "").rstrip("/")
    if not unsafe:
        if origin and origin not in request.app.state.settings.allowed_origins:
            raise HTTPException(403, "Origin is not allowed")
        if request.headers.get("sec-fetch-site") in {"cross-site", "same-site"} and not origin:
            raise HTTPException(403, "Cross-site browser request is not allowed")
    if unsafe:
        if origin not in request.app.state.settings.allowed_origins:
            raise HTTPException(403, "Origin is not allowed")
        if request.headers.get("x-parse-web") != "1":
            raise HTTPException(403, "X-Parse-Web: 1 is required")
        if csrf and (not token or not hmac.compare_digest(request.headers.get("x-csrf-token", ""), _csrf(token))):
            raise HTTPException(403, "CSRF token is invalid")


@router.get("/session")
def session(request: Request, response: Response, db=Depends(phone_db)):
    _check(request, unsafe=False)
    token = _token(request)
    device = _device(db, token)
    if not token:
        token = secrets.token_hex(32)
        _cookie(response, request, token)
    response.headers["Cache-Control"] = "private, no-store"
    return {"has_installation": bool(device), "csrf_token": _csrf(token) if device else None}


@router.post("/enrollments")
def web_enroll(data: WebEnrollment, request: Request, response: Response, db=Depends(phone_db)):
    token = _token(request)
    device = _device(db, token)
    _check(request, unsafe=True, token=token, csrf=bool(device))
    enrollment = db.get(m.PhoneEnrollment, device.id) if device else None
    if device and device.revoked_at:
        raise HTTPException(403, "This browser installation was revoked; stop playback and clear it first")
    if device and enrollment and (device.patient_id or aware(enrollment.expires_at) > utcnow()):
        # A retry retains the original pairing code and browser identity.
        view = enrollment_view(db, device, enrollment, token)
        response.status_code = 200
    else:
        token = secrets.token_hex(32) if device or not token else token
        key = str(uuid4())
        # The phone endpoint owns enrollment, idempotency and rate limiting.
        native = Response(status_code=201)
        view = enroll(EnrollmentCreate(platform="web", display_name=data.display_name),
                      request, native, authorization="Bearer " + token,
                      idempotency_key=key, db=db)
        response.status_code = native.status_code
    _cookie(response, request, token)
    response.headers["Cache-Control"] = "private, no-store"
    return {**view, "csrf_token": _csrf(token)}


_ROUTES = (
    ("GET", re.compile(r"enrollments/current\Z"), "/v1/phone/"),
    ("GET", re.compile(r"home\Z"), "/v1/phone/"),
    ("PUT", re.compile(r"presence\Z"), "/v1/phone/"),
    ("POST", re.compile(r"turns\Z"), "/v1/phone/"),
    ("GET", re.compile(r"turn-receipts/[0-9a-fA-F-]{36}\Z"), "/v1/phone/"),
    ("GET", re.compile(r"turns/[^/]+\Z"), "/v1/device/"),
    ("GET", re.compile(r"audio/[^/]+\Z"), "/v1/device/"),
    ("HEAD", re.compile(r"audio/[^/]+\Z"), "/v1/device/"),
    ("POST", re.compile(r"proposals/[^/]+/(?:confirm|revise|cancel|speech)\Z"), "/v1/phone/"),
    ("POST", re.compile(r"speaker-check\Z"), "/v1/phone/"),
    ("GET", re.compile(r"pending-commands\Z"), "/v1/device/"),
    ("GET", re.compile(r"reminders/[^/]+\Z"), "/v1/phone/"),
    ("POST", re.compile(r"acks\Z"), "/v1/device/"),
    ("POST", re.compile(r"quiesce\Z"), "/v1/phone/"),
    ("DELETE", re.compile(r"installation\Z"), "/v1/phone/"),
)


@router.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "DELETE"])
async def forward(path: str, request: Request, db=Depends(phone_db)):
    target = next((prefix + path for method, pattern, prefix in _ROUTES
                   if request.method == method and pattern.fullmatch(path)), None)
    if not target:
        raise HTTPException(404, "Browser companion route not found")
    token = _token(request)
    device = _device(db, token)
    _check(request, unsafe=request.method not in {"GET", "HEAD"}, token=token,
           csrf=request.method not in {"GET", "HEAD"})
    if not device:
        raise HTTPException(401, "Browser installation not found")
    if device.revoked_at and path not in {"quiesce", "installation"}:
        raise HTTPException(403, "Browser installation was revoked")
    if device.revoked_at and path == "installation" and request.method == "DELETE":
        if device.patient_id and route_view(db, device.patient_id)["device_id"] == device.id:
            raise HTTPException(409, "Stop playback and pause this browser before clearing it")
        result = JSONResponse({"status": "revoked"}, headers={"Cache-Control": "private, no-store"})
        result.delete_cookie(COOKIE, path="/v1/web", secure=_secure(request),
                             httponly=True, samesite="strict")
        return result

    scope = dict(request.scope)
    scope["path"] = target
    scope["raw_path"] = target.encode("ascii")
    scope["headers"] = [(key, value) for key, value in scope["headers"]
                        if key.lower() not in {b"authorization", b"cookie"}]
    scope["headers"].append((b"authorization", ("Bearer " + token).encode("ascii")))
    messages = []

    async def collect(message):
        messages.append(message)

    # A turn's 202 body precedes its native BackgroundTasks. Run the native ASGI
    # response independently and return as soon as the receipt body is sent.
    if path == "turns" and request.method == "POST":
        receipt_sent = asyncio.Event()
        failure = []

        async def collect_turn(message):
            await collect(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                receipt_sent.set()

        async def dispatch_turn():
            try:
                await request.app.router(scope, request.receive, collect_turn)
            except BaseException as exc:
                if not receipt_sent.is_set():
                    failure.append(exc)
                receipt_sent.set()
                if not isinstance(exc, asyncio.CancelledError):
                    logger.exception("Browser turn dispatch failed")
                raise
            finally:
                if not receipt_sent.is_set():
                    failure.append(RuntimeError("Browser turn produced no receipt"))
                    receipt_sent.set()

        task = asyncio.create_task(dispatch_turn())
        active = getattr(request.app.state, "web_turn_dispatches", None)
        if active is None:
            active = request.app.state.web_turn_dispatches = set()
        active.add(task)

        def finished(done):
            active.discard(done)
            try:
                done.exception()
            except asyncio.CancelledError:
                pass

        task.add_done_callback(finished)
        await receipt_sent.wait()
        if failure:
            raise failure[0]
    else:
        # Internal ASGI dispatch preserves all phone/device validation.
        await request.app.router(scope, request.receive, collect)
    start = next(item for item in messages if item["type"] == "http.response.start")
    body = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    headers = {key.decode("latin1"): value.decode("latin1") for key, value in start["headers"]
               if key.lower() not in {b"content-length", b"set-cookie", b"cache-control"}}
    if request.method == "HEAD":
        length = next((value.decode("latin1") for key, value in start["headers"]
                       if key.lower() == b"content-length"), None)
        if length is not None:
            headers["Content-Length"] = length
    if headers.get("content-type", "").startswith("application/json") and body:
        payload = json.loads(body)

        def web_audio(value):
            if isinstance(value, str) and value.startswith("/v1/device/audio/"):
                return "/v1/web/audio/" + value.removeprefix("/v1/device/audio/")
            if isinstance(value, list):
                return [web_audio(item) for item in value]
            if isinstance(value, dict):
                return {key: web_audio(item) for key, item in value.items()}
            return value

        body = json.dumps(web_audio(payload), separators=(",", ":")).encode()
    headers["Cache-Control"] = "private, no-store"
    result = Response(content=body, status_code=start["status"], headers=headers)
    if path == "installation" and request.method == "DELETE" and start["status"] < 400:
        result.delete_cookie(COOKIE, path="/v1/web", secure=_secure(request),
                             httponly=True, samesite="strict")
    return result
