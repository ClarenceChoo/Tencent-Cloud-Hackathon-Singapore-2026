import io
import asyncio
import shutil
import subprocess
import threading
import wave
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import models as m
from app.phone_audio import MAX_INPUT, normalize_phone_audio
from app.services import validate_wav
from conftest import ORIGIN, login, wav_bytes
from test_phone_identity import approve


WEB = {"Origin": ORIGIN, "X-Parse-Web": "1"}


@pytest.fixture
def webm(tmp_path):
    assert shutil.which("ffmpeg"), "Install FFmpeg to verify browser audio"
    path = tmp_path / "microphone.webm"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                    "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", "libopus", str(path)], check=True)
    return path.read_bytes()


def enroll(client):
    initial = client.get("/v1/web/session")
    assert initial.status_code == 200
    assert initial.json() == {"has_installation": False, "csrf_token": None}
    created = client.post("/v1/web/enrollments", json={"display_name": "Browser companion"}, headers=WEB)
    assert created.status_code == 201, created.text
    return created


def test_webm_opus_decodes_and_rejects_other_streams(tmp_path, webm):
    wav = normalize_phone_audio(webm, "audio/webm")
    assert 900 <= validate_wav(wav) <= 1100
    with wave.open(io.BytesIO(wav)) as audio:
        assert (audio.getnchannels(), audio.getframerate(), audio.getsampwidth()) == (1, 16000, 2)
    # MediaRecorder-style nonseekable WebM has no container duration metadata.
    streaming = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", "libopus", "-f", "webm", "pipe:1"],
        check=True, stdout=subprocess.PIPE).stdout
    assert 900 <= validate_wav(normalize_phone_audio(streaming, "audio/webm")) <= 1100
    for body, mime in [(webm, "audio/mp4"), (wav, "audio/webm"), (b"bad", "audio/webm"),
                       (webm, "video/webm"), (b"x" * (MAX_INPUT + 1), "audio/webm")]:
        with pytest.raises(HTTPException):
            normalize_phone_audio(body, mime)
    for name, source, extra in [("long", "sine=duration=21", []),
                                ("video", "sine=duration=1", ["-f", "lavfi", "-i", "color=duration=1:size=16x16", "-c:v", "libvpx-vp9"])]:
        path = tmp_path / (name + ".webm")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", source,
                        *extra, "-c:a", "libopus", str(path)], check=True)
        with pytest.raises(HTTPException) as exc:
            normalize_phone_audio(path.read_bytes(), "audio/webm")
        assert exc.value.status_code == 400


def test_browser_cookie_origin_csrf_pairing_and_revocation(env):
    client, app, ids = env
    assert client.get("/v1/web/session", headers={"Origin": "https://other.invalid"}).status_code == 403
    assert client.get("/v1/web/session", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.post("/v1/web/enrollments", json={"display_name": "Browser"}).status_code == 403
    assert client.post("/v1/web/enrollments", json={"display_name": "Browser"},
                       headers={"Origin": ORIGIN}).status_code == 403
    assert client.post("/v1/web/enrollments", json={"display_name": "Browser"},
                       headers={**WEB, "Authorization": "Bearer bad"}).status_code == 400
    created = enroll(client)
    cookie = created.headers["set-cookie"]
    assert "httponly" in cookie.lower() and "samesite=strict" in cookie.lower()
    app.state.settings.cookie_secure = True
    client.cookies.clear()
    secure_session = client.get("/v1/web/session")
    assert "secure" in secure_session.headers["set-cookie"].lower()
    client.cookies.clear()
    app.state.settings.cookie_secure = False
    # The original browser's enrollment identity remains recoverable from its cookie.
    client.cookies.set("parse_web_installation", cookie.split(";", 1)[0].split("=", 1)[1], path="/v1/web")
    assert "authorization" not in created.text.lower() and "credential" not in created.text.lower()
    csrf = created.json()["csrf_token"]
    session = client.get("/v1/web/session")
    assert session.json() == {"has_installation": True, "csrf_token": csrf}
    assert client.post("/v1/web/enrollments", json={"display_name": "Browser"}, headers=WEB).status_code == 403
    retry = client.post("/v1/web/enrollments", json={"display_name": "Different ignored"},
                        headers={**WEB, "X-CSRF-Token": csrf})
    assert retry.status_code == 200 and retry.json()["code"] == created.json()["code"]
    assert client.post("/v1/web/quiesce", json={"playback_stopped": True, "local_alerts_cleared": True},
                       headers={**WEB, "X-CSRF-Token": csrf}).status_code == 401
    assert approve(client, ids, created.json()["code"]).status_code == 200
    assert client.get("/v1/web/enrollments/current").json()["status"] == "paired"
    assert client.get("/v1/web/home", headers={"Authorization": "Bearer bad"}).status_code == 400
    assert client.get("/v1/web/home").status_code == 200
    assert client.post("/v1/web/quiesce", json={"playback_stopped": True, "local_alerts_cleared": True},
                       headers={**WEB, "X-CSRF-Token": "wrong"}).status_code == 403
    assert client.post("/v1/web/quiesce", json={"playback_stopped": True, "local_alerts_cleared": True},
                       headers={**WEB, "X-CSRF-Token": csrf}).status_code == 200
    revoked = client.delete("/v1/web/installation", headers={**WEB, "X-CSRF-Token": csrf})
    assert revoked.status_code == 200 and "max-age=0" in revoked.headers["set-cookie"].lower()
    assert client.get("/v1/web/home").status_code in {401, 403}
    with app.state.db.SessionLocal() as db:
        device = db.get(m.Device, created.json()["device_id"])
        assert device.revoked_at is not None and device.platform == "web"


def test_browser_turn_uses_shared_proposal_and_scopes_audio(env, webm, monkeypatch):
    client, app, ids = env
    created = enroll(client)
    csrf = created.json()["csrf_token"]
    assert approve(client, ids, created.json()["code"]).status_code == 200

    class Speech:
        async def transcribe_audio(self, wav):
            validate_wav(wav)
            return "My knee hurt after walking"

        async def interpret_turn(self, transcript, context):
            return {"intent": "proposal", "kind": "health_note", "payload": {
                "wording": transcript, "share_with_user_ids": [ids["caregiver"]]}, "spoken_text": ""}

        async def synthesise_speech(self, text):
            return wav_bytes()

    monkeypatch.setattr("app.worker._provider", lambda _: Speech())
    monkeypatch.setattr("app.providers.get_provider", lambda **_: Speech())
    key = str(uuid4())
    headers = {**WEB, "X-CSRF-Token": csrf, "Idempotency-Key": key, "Content-Type": "audio/webm;codecs=opus"}
    accepted = client.post("/v1/web/turns", content=webm, headers=headers)
    assert accepted.status_code == 202, accepted.text
    assert client.get("/v1/web/turn-receipts/" + key).json()["turn_id"] == accepted.json()["turn_id"]
    result = client.get("/v1/web/turns/" + accepted.json()["turn_id"])
    assert result.status_code == 200, result.text
    audio = result.json()["event"]["payload"]["audio_paths"][0]
    assert audio.startswith("/v1/web/audio/")
    assert client.head(audio).status_code == 200
    assert client.get(audio).status_code == 200
    proposal = client.get("/v1/web/home").json()["current_proposal"]
    assert proposal and proposal["kind"] == "health_note"

    # A second browser has its own credential and cannot fetch this turn or audio.
    first_cookie = client.cookies.get("parse_web_installation")
    client.cookies.clear()
    second = enroll(client)
    assert second.json()["device_id"] != created.json()["device_id"]
    assert approve(client, ids, second.json()["code"]).status_code == 200
    assert client.get(audio).status_code == 404
    assert client.get("/v1/web/turns/" + accepted.json()["turn_id"]).status_code == 404
    client.cookies.clear()
    client.cookies.set("parse_web_installation", first_cookie, path="/v1/web")
    confirmed = client.post("/v1/web/proposals/" + proposal["id"] + "/confirm",
                            json={"context_id": proposal["context_id"], "confirmed": True},
                            headers={**WEB, "X-CSRF-Token": csrf})
    assert confirmed.status_code == 200, confirmed.text
    with app.state.db.SessionLocal() as db:
        notes = db.scalars(select(m.HealthNote)).all()
        assert len(notes) == 1 and notes[0].wording == "My knee hurt after walking"
    login(client, "caregiver@example.invalid", "caregiver-password")
    assert len(client.get("/v1/app/patients/" + ids["patient"] + "/dashboard").json()["notes"]) == 1


def test_web_receipt_does_not_wait_for_speech_processing(env, webm, monkeypatch):
    client, app, ids = env
    created = enroll(client)
    assert approve(client, ids, created.json()["code"]).status_code == 200
    entered = threading.Event()
    release = threading.Event()

    class SlowSpeech:
        async def transcribe_audio(self, wav):
            entered.set()
            await asyncio.to_thread(release.wait)
            return "I feel okay"

        async def interpret_turn(self, transcript, context):
            return {"intent": "chat", "spoken_text": "I heard you."}

        async def synthesise_speech(self, text):
            return wav_bytes()

    monkeypatch.setattr("app.worker._provider", lambda _: SlowSpeech())
    monkeypatch.setattr("app.providers.get_provider", lambda **_: SlowSpeech())
    headers = {**WEB, "X-CSRF-Token": created.json()["csrf_token"],
               "Idempotency-Key": str(uuid4()), "Content-Type": "audio/webm"}
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(client.post, "/v1/web/turns", content=webm, headers=headers)
            receipt = future.result(timeout=3)
            assert receipt.status_code == 202, receipt.text
            assert entered.wait(3)
            assert not release.is_set()
    finally:
        release.set()


def test_revoked_browser_can_quiesce_before_cookie_clear(env):
    client, app, ids = env
    created = enroll(client)
    csrf = created.json()["csrf_token"]
    assert approve(client, ids, created.json()["code"]).status_code == 200
    owner = login(client)
    selected = client.put("/v1/app/patients/" + ids["patient"] + "/active-companion",
        json={"device_id": created.json()["device_id"], "expected_generation": 1,
              "other_pendants_powered_off": True}, headers=owner)
    assert selected.status_code == 200, selected.text
    assert client.post("/v1/app/devices/" + created.json()["device_id"] + "/revoke", headers=owner).status_code == 200
    assert client.get("/v1/web/session").json() == {"has_installation": True, "csrf_token": csrf}
    assert client.get("/v1/web/home").status_code == 403
    assert client.delete("/v1/web/installation", headers={**WEB, "X-CSRF-Token": csrf}).status_code == 409
    assert client.post("/v1/web/quiesce", json={"playback_stopped": True, "local_alerts_cleared": True},
                       headers={**WEB, "X-CSRF-Token": csrf}).status_code == 200
    cleared = client.delete("/v1/web/installation", headers={**WEB, "X-CSRF-Token": csrf})
    assert cleared.status_code == 200 and "max-age=0" in cleared.headers["set-cookie"].lower()
    assert client.get("/v1/web/session").json() == {"has_installation": False, "csrf_token": None}


def test_web_routes_require_https_outside_tests(env):
    client, app, ids = env
    app.state.settings.testing = False
    app.state.settings.cookie_secure = False
    assert client.get("/v1/web/session").status_code == 400
    assert client.post("/v1/web/enrollments", json={"display_name": "Browser"}, headers=WEB).status_code == 400
