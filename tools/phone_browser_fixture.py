#!/usr/bin/env python3
"""Disposable loopback phone/browser fixture. Scripted speech, no native phone."""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8003)
    parser.add_argument("--web-port", type=int, default=5175)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.is_relative_to(ROOT / "runtime"):
        raise SystemExit("Use a NEW directory inside this repository's ignored runtime folder.")
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.environ.update(CARELOOP_PROVIDER="fixture", CARELOOP_TESTING="true",
                      CARELOOP_FIXTURE_REPLY_WAV=str(directory / "reply.wav"))
    from app.config import Settings
    from app.main import create_app
    from app.models import AccessGrant, Patient, User
    from app.phone_audio import normalize_phone_audio
    from app.provisioning import private_file
    from app.security import hash_password
    import uvicorn

    settings = Settings(database_url="sqlite:///" + str(directory / "fixture.db"),
                        cookie_secure=False, testing=True, development_seed=False,
                        scheduler_enabled=False, allowed_origins=[f"http://127.0.0.1:{args.web_port}"],
                        public_base_url="https://parse.example")
    app = create_app(settings)
    app.state.db.create_all()
    with app.state.db.SessionLocal() as db:
        patient = Patient(name="Fictional Mei Tan", preferred_name="Mei", timezone="Asia/Singapore", language="en")
        users = [User(name=name, email=f"{role}@careloop.invalid", role="owner" if role == "owner" else "caregiver",
                      password_hash=hash_password("fictional-browser-only")) for role, name in [
                          ("owner", "Fictional Alex Tan"), ("caregiver", "Fictional Jamie Lim"),
                          ("restricted", "Fictional Second Caregiver")]]
        db.add_all([patient, *users])
        db.flush()
        grants = [AccessGrant(user_id=user.id, patient_id=patient.id, relationship=user.role,
                              scopes=["*"] if user.role == "owner" else ["read:dashboard"]) for user in users]
        db.add_all(grants)
        db.commit()
        metadata = {"patient_id": patient.id, "caregiver_id": users[1].id, "grant_id": grants[1].id}

    def proposal(wording, shared=True):
        return {"intent": "proposal", "kind": "health_note", "payload": {
            "wording": wording, "share_with_user_ids": [metadata["caregiver_id"]] if shared else []}}

    scenarios = {
        "original": proposal("Fictional right knee after walking"),
        "corrected": {"intent": "correct", "payload": {"wording": "Fictional left knee after walking",
                     "occurrence_text": "after walking", "share_with_user_ids": [metadata["caregiver_id"]]}},
        "private": proposal("Fictional private concern visible only to Mei and owner", False),
        "confirm": "yes save that",
        **{f"sample-{i}": proposal(f"Fictional phone latency sample {i:02d}") for i in range(30)},
    }
    for index, (name, interpretation) in enumerate(scenarios.items()):
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(16000)
            out.writeframes(b"".join(struct.pack("<h", int(2000 * math.sin(2 * math.pi * (300 + index * 30) * n / 16000))) for n in range(8000)))
        wav = buffer.getvalue()
        if index == 0:
            (directory / "reply.wav").write_bytes(wav)
        encoded = directory / f"{name}.m4a"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "wav", "-i", "pipe:0",
                        "-c:a", "aac", "-y", str(encoded)], input=wav, check=True)
        normalized = normalize_phone_audio(encoded.read_bytes(), "audio/mp4")
        transcript = interpretation if isinstance(interpretation, str) else "FIXTURE:" + json.dumps(interpretation)
        app.state.fixture_transcripts[hashlib.sha256(normalized).hexdigest()] = transcript
    private_file(directory / "browser.json", json.dumps(metadata))
    print("Phone/browser fixture ready: loopback, fictional records, scripted speech.", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
