#!/usr/bin/env python3
"""Disposable, same-origin web companion demo with fictional data and scripted speech.

Actual browser MediaRecorder bytes pass through the production decoder/worker.
The local scenario file supplies the transcript/interpretation; this does not
recognize speech and must never be deployed as a live service.
"""
import argparse
from datetime import timedelta
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import struct
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=5190)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.is_relative_to(ROOT / "runtime"):
        raise SystemExit("Use a new directory inside this repository's ignored runtime folder.")
    if not (ROOT / "frontend/dist/index.html").is_file():
        raise SystemExit("Build the dashboard and companion before starting the fixture.")
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    # Keep one served build for this run even if another task rebuilds the app.
    web_directory = directory / "web"
    shutil.copytree(ROOT / "frontend/dist", web_directory)
    os.environ.update(CARELOOP_PROVIDER="fixture", CARELOOP_TESTING="true",
                      CARELOOP_FIXTURE_REPLY_WAV=str(directory / "reply.wav"))
    from app.config import Settings
    from app.main import create_app
    from app.models import AccessGrant, Patient, User, MedicationPlanVersion, DoseInstance
    from app.providers import FixtureProvider, ProviderUnavailable, validate_speech_wav, parse_interpretation
    from app.provisioning import private_file
    from app.security import hash_password, utcnow
    from app import phone_audio, worker
    from fastapi import HTTPException
    from starlette.staticfiles import StaticFiles
    from starlette.responses import FileResponse
    import uvicorn

    # Tone audio is a transparent fixture, not a voice-over or live TTS result.
    for filename, seconds in [("reply.wav", .6), ("microphone.wav", 30)]:
        with wave.open(str(directory / filename), "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            wav.writeframes(b"".join(struct.pack("<h", int(1000 * math.sin(2 * math.pi * 440 * n / 16000)))
                                     for n in range(int(16000 * seconds))))

    class ArmedWebProvider(FixtureProvider):
        def __init__(self):
            super().__init__({}, str(directory / "reply.wav"))
            self.interpretations = {}

        async def transcribe_audio(self, wav, vocabulary=None):
            validate_speech_wav(wav)
            armed = directory / "next-utterance.json"
            if not armed.is_file():
                raise ProviderUnavailable("This is a scripted demo. No speech scenario is ready.")
            scenario = json.loads(armed.read_text())
            transcript = scenario["transcript"]
            if not isinstance(transcript, str) or not transcript.strip():
                raise ProviderUnavailable("Invalid scripted transcript.")
            interpretation = parse_interpretation(json.dumps(scenario["interpretation"]))
            self.interpretations[transcript] = interpretation
            armed.unlink()
            with wave.open(io.BytesIO(wav), "rb") as recording:
                metadata = {"scenario": scenario["name"], "sha256": hashlib.sha256(wav).hexdigest(),
                            "frames": recording.getnframes(), "sample_rate": recording.getframerate(),
                            "channels": recording.getnchannels(), "sample_width": recording.getsampwidth(),
                            "vocabulary_version": getattr(vocabulary, "version", None)}
            with (directory / "captures.jsonl").open("a") as out:
                out.write(json.dumps(metadata) + "\n")
            return transcript

        async def interpret_turn(self, transcript, context):
            if transcript not in self.interpretations:
                raise ProviderUnavailable("Scripted interpretation was not registered.")
            return self.interpretations[transcript]

    origin = f"http://127.0.0.1:{args.port}"
    settings = Settings(_env_file=None, database_url="sqlite:///" + str(directory / "fixture.db"),
                        cookie_secure=False, testing=True, development_seed=False,
                        scheduler_enabled=False, expo_push_enabled=False, allowed_origins=[origin],
                        public_base_url="https://parse.example")
    app = create_app(settings)
    app.state.db.create_all()
    provider = ArmedWebProvider()
    worker._provider = lambda _app: provider
    normalize = phone_audio.normalize_phone_audio

    def observed_normalize(body, mime):
        metadata = {"mime": mime, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        try:
            result = normalize(body, mime)
            metadata["normalized_bytes"] = len(result)
            return result
        except HTTPException as error:
            metadata.update(status=error.status_code, error=error.detail)
            raise
        finally:
            with (directory / "uploads.jsonl").open("a") as out:
                out.write(json.dumps(metadata) + "\n")
    phone_audio.normalize_phone_audio = observed_normalize

    with app.state.db.SessionLocal() as db:
        patient = Patient(name="Fictional Mei Tan", preferred_name="Mei", timezone="Asia/Singapore", language="en")
        second_patient = Patient(name="Fictional Empty Care Space", preferred_name="Second", timezone="America/New_York", language="en")
        users = [User(name=name, email=f"{role}@web.invalid", role="owner" if role == "owner" else "caregiver",
                      password_hash=hash_password("fictional-web-only")) for role, name in [
                          ("owner", "Fictional Alex Tan"), ("caregiver", "Fictional Jamie Lim"),
                          ("restricted", "Fictional Second Caregiver")]]
        db.add_all([patient, second_patient, *users]); db.flush()
        db.add_all([AccessGrant(user_id=user.id, patient_id=patient.id, relationship=user.role,
                               scopes=["*"] if user.role == "owner" else ["read:dashboard", "ack:support", "resolve:support"])
                    for user in users])
        db.add_all([AccessGrant(user_id=user.id, patient_id=second_patient.id, relationship=user.role,
                               scopes=["*"] if user.role == "owner" else ["read:dashboard", "ack:support", "resolve:support"])
                    for user in users[:2]])
        plan = MedicationPlanVersion(patient_id=patient.id, version=1, timezone=patient.timezone,
            source="Fictional demonstration plan", checked_by_user_id=users[0].id,
            checked_by_name=users[0].name, checked_at=utcnow(), active=True,
            medicines=[{"id": "demo_medicine", "name": "Example medicine", "instructions": "Follow the checked care plan.",
                        "reviewed_reference": "A fictional medicine used to demonstrate tracking.", "reference_source": "Fictional demo plan"}],
            schedule=[{"medicine_id": "demo_medicine", "local_time": "08:00"}])
        db.add(plan); db.flush()
        dose = DoseInstance(patient_id=patient.id, plan_id=plan.id, plan_version=1,
                            medicine_id="demo_medicine", medicine_name="Example medicine", scheduled_at=utcnow()-timedelta(minutes=5))
        db.add(dose); db.commit()
        metadata = {"patient_id": patient.id, "caregiver_id": users[1].id, "restricted_id": users[2].id,
                    "second_patient_id": second_patient.id, "dose_id": dose.id,
                    "origin": origin, "speech": "scripted", "data": "fictional"}
    metadata["startup_source_sha256"] = {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (ROOT / "backend/app").glob("*.py")
        if path.is_file()
    }
    metadata["startup_source_sha256"].update({
        "frontend/dist/" + str(path.relative_to(web_directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in web_directory.rglob("*") if path.is_file()
    })
    metadata["frontend_snapshot"] = True
    private_file(directory / "fixture.json", json.dumps(metadata))

    @app.middleware("http")
    async def document_policy(request, call_next):
        response = await call_next(request)
        is_companion = request.url.path == "/companion" or request.url.path.startswith("/companion/")
        response.headers["Permissions-Policy"] = "camera=(), microphone=" + ("(self)" if is_companion else "()") + ", geolocation=()"
        return response

    @app.get("/", include_in_schema=False)
    @app.get("/companion", include_in_schema=False)
    @app.get("/companion/", include_in_schema=False)
    @app.get("/shared/summaries/{token}", include_in_schema=False)
    def page(token: str = ""):
        return FileResponse(web_directory / "index.html")
    @app.get("/landing", include_in_schema=False)
    @app.get("/landing/", include_in_schema=False)
    def landing():
        return FileResponse(web_directory / "landing/index.html")
    app.mount("/assets", StaticFiles(directory=web_directory / "assets"), name="web-assets")
    app.mount("/brand", StaticFiles(directory=web_directory / "brand"), name="web-brand")
    app.mount("/landing", StaticFiles(directory=web_directory / "landing"), name="web-landing-assets")
    # Static manifest/icons may be added later; never expose runtime/ or API data.
    for filename in ["companion.webmanifest", "parse-companion.svg", "parse-icon.svg", "manifest.webmanifest"]:
        static = web_directory / filename
        if static.is_file():
            def serve(path=static):
                return FileResponse(path)
            app.add_api_route("/" + filename, serve, methods=["GET"], include_in_schema=False)
    print("Web companion fixture ready: " + origin + "/companion — fictional data, scripted speech.", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
