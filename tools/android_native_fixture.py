#!/usr/bin/env python3
"""Loopback HTTPS/native-module fixture. Scripted interpretation is NOT live ASR.

prepare creates a fresh private test directory and an external Gradle verification
variant. serve runs the real API/dashboard against a fictional database. A local
next-utterance.json file arms exactly one scripted transcript for the next native
recording. No fixture routes or trust anchors are added to the production app.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def prepare(directory: Path):
    directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    tls = directory / "tls"
    tls.mkdir(mode=0o700)
    def openssl(*args):
        subprocess.run(["openssl", *args], cwd=tls, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
            "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=Parse local verification only",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key",
            "-out", "server.csr", "-subj", "/CN=127.0.0.1")
    (tls / "server.ext").write_text("subjectAltName=IP:127.0.0.1,DNS:localhost\n"
                                    "basicConstraints=critical,CA:FALSE\n"
                                    "extendedKeyUsage=serverAuth\n")
    openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
            "-CAcreateserial", "-out", "server.pem", "-days", "2", "-extfile", "server.ext")
    for key in tls.glob("*.key"):
        key.chmod(0o600)
    res = directory / "android/res"
    (res / "raw").mkdir(parents=True)
    (res / "xml").mkdir()
    (res / "values").mkdir()
    (res / "raw/parse_local_ca.pem").write_bytes((tls / "ca.pem").read_bytes())
    (res / "values/strings.xml").write_text(
        '<resources><string name="app_name">Parse local verification</string></resources>\n')
    (res / "xml/parse_local_network.xml").write_text('''<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors><certificates src="system" /></trust-anchors>
  </base-config>
  <domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <trust-anchors><certificates src="@raw/parse_local_ca" /></trust-anchors>
  </domain-config>
</network-security-config>
''')
    (directory / "android/AndroidManifest.xml").write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:networkSecurityConfig="@xml/parse_local_network" />
</manifest>
''')
    # An external Gradle init script keeps the generated native project untouched.
    # Release source sets never reference this certificate or manifest.
    (directory / "native-verification.init.gradle").write_text('''gradle.beforeProject { project ->
  project.plugins.withId("com.android.application") {
    project.androidComponents.finalizeDsl { ignored ->
      def fixture = new File(System.getenv("PARSE_NATIVE_FIXTURE_DIR"))
      if (!fixture.isAbsolute() || !new File(fixture, "tls/ca.pem").isFile()) {
        throw new GradleException("Set PARSE_NATIVE_FIXTURE_DIR to a prepared local fixture")
      }
      project.android.buildTypes.create("nativeVerification") {
        initWith(project.android.buildTypes.release)
        applicationIdSuffix ".verification"
        debuggable false
        matchingFallbacks = ["release"]
        signingConfig project.android.signingConfigs.debug
      }
      project.android.sourceSets.nativeVerification {
        manifest.srcFile(new File(fixture, "android/AndroidManifest.xml"))
        res.srcDir(new File(fixture, "android/res"))
      }
    }
  }
}
''')
    print("Prepared private local TLS fixture and separate nativeVerification variant.")


def serve(directory: Path, port: int):
    if not (directory / "tls/server.key").is_file():
        raise SystemExit("Prepare a new fixture directory first.")
    if (directory / "fixture.db").exists():
        raise SystemExit("Refusing to reuse a fixture database; prepare a new directory.")
    if not (ROOT / "frontend/dist/index.html").is_file():
        raise SystemExit("Build frontend/dist before starting the native fixture.")
    os.environ.update(CARELOOP_PROVIDER="fixture", CARELOOP_TESTING="true",
                      CARELOOP_FIXTURE_REPLY_WAV=str(directory / "reply.wav"))
    from app.config import Settings
    from app.main import create_app
    from app.models import AccessGrant, Patient, User
    from app.provisioning import private_file
    from app.providers import FixtureProvider, ProviderUnavailable, validate_speech_wav
    from app.security import hash_password
    from app import worker
    from starlette.staticfiles import StaticFiles
    import uvicorn

    # A fixture tone exercises native WAV decoding/playback callbacks only.
    import math
    import struct
    with wave.open(str(directory / "reply.wav"), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"".join(struct.pack("<h", int(1500 * math.sin(2 * math.pi * 440 * n / 16000)))
                                 for n in range(16000)))

    class ArmedNativeProvider(FixtureProvider):
        async def transcribe_audio(self, wav: bytes) -> str:
            validate_speech_wav(wav)
            armed = directory / "next-utterance.json"
            if not armed.is_file():
                raise ProviderUnavailable("No native test scenario is armed. This is scripted speech.")
            scenario = json.loads(armed.read_text())
            transcript = scenario["transcript"]
            if not isinstance(transcript, str) or not transcript.strip():
                raise ProviderUnavailable("Invalid native test scenario.")
            armed.unlink()
            with wave.open(io.BytesIO(wav), "rb") as recording:
                metadata = {"scenario": scenario["name"], "sha256": hashlib.sha256(wav).hexdigest(),
                            "frames": recording.getnframes(), "sample_rate": recording.getframerate(),
                            "channels": recording.getnchannels(), "sample_width": recording.getsampwidth()}
            with (directory / "native-captures.jsonl").open("a") as log:
                log.write(json.dumps(metadata) + "\n")
            return transcript

    origin = f"https://127.0.0.1:{port}"
    settings = Settings(_env_file=None, database_url="sqlite:///" + str(directory / "fixture.db"),
                        cookie_secure=True, testing=True, development_seed=False, scheduler_enabled=False,
                        expo_push_enabled=False, allowed_origins=[origin], public_base_url=origin)
    app = create_app(settings)
    app.state.db.create_all()
    provider = ArmedNativeProvider({}, str(directory / "reply.wav"))
    # Scoped to this test-only process; production provider selection is unchanged.
    worker._provider = lambda _app: provider
    with app.state.db.SessionLocal() as db:
        patient = Patient(name="Fictional Mei Tan", preferred_name="Mei", timezone="Asia/Singapore", language="en")
        users = [User(name=name, email=f"{role}@native.invalid", role="owner" if role == "owner" else "caregiver",
                      password_hash=hash_password("fictional-native-only")) for role, name in [
                          ("owner", "Fictional Alex Tan"), ("caregiver", "Fictional Jamie Lim"),
                          ("restricted", "Fictional Second Caregiver")]]
        db.add_all([patient, *users])
        db.flush()
        db.add_all([AccessGrant(user_id=user.id, patient_id=patient.id, relationship=user.role,
                               scopes=["*"] if user.role == "owner" else ["read:dashboard"]) for user in users])
        db.commit()
        metadata = {"patient_id": patient.id, "caregiver_id": users[1].id, "origin": origin}
    private_file(directory / "fixture.json", json.dumps(metadata))
    app.mount("/", StaticFiles(directory=ROOT / "frontend/dist", html=True), name="fixture-dashboard")
    print("Native fixture ready: local HTTPS, fictional records, SCRIPTED interpretation and tone replies.", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, ssl_keyfile=str(directory / "tls/server.key"),
                ssl_certfile=str(directory / "tls/server.pem"), log_level="warning", access_log=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "serve"])
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8443)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.is_relative_to(ROOT / "runtime"):
        raise SystemExit("Use a NEW directory within this repository's ignored runtime folder.")
    if not 1024 <= args.port <= 65535:
        raise SystemExit("Use an unprivileged local port.")
    prepare(directory) if args.mode == "prepare" else serve(directory, args.port)


if __name__ == "__main__":
    main()
