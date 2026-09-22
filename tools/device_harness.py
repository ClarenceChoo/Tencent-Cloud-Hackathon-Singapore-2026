#!/usr/bin/env python3
"""Developer WAV transport harness. This does not replace ESP32 acceptance tests."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave

MAX_BYTES = 768 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_wav(data):
    if len(data) > MAX_BYTES:
        raise ValueError("WAV exceeds 768 KiB")
    with wave.open(io.BytesIO(data), "rb") as clip:
        if (clip.getnchannels(), clip.getsampwidth(), clip.getframerate(), clip.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError("Use mono, signed 16-bit PCM WAV at 16 kHz")
        frames = clip.getnframes()
        if not 4800 <= frames <= 320000 or len(clip.readframes(frames)) != frames * 2:
            raise ValueError("Use a complete recording lasting 0.3 to 20 seconds")


def base_url(value, allow_loopback):
    parsed = urllib.parse.urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"} or not parsed.hostname:
        raise ValueError("Backend URL must contain only scheme, hostname and optional port")
    local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"} and allow_loopback
    if parsed.scheme != "https" and not local_http:
        raise ValueError("HTTPS is required; local HTTP needs --allow-insecure-loopback")
    return value.rstrip("/")


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", opener=lambda name, flags: os.open(name, flags, 0o600)) as out:
        json.dump(state, out, indent=2)
        out.write("\n")
    os.replace(temporary, path)


def request(opener, url, token, data=None, headers=None):
    metadata = {"Authorization": "Bearer " + token, **(headers or {})}
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=metadata)
            with opener.open(req, timeout=30) as response:
                body = response.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise ValueError("Backend response exceeds the device limit")
                return body
        except urllib.error.HTTPError as exc:
            if exc.code not in {429, 502, 503, 504} or attempt == 3:
                raise RuntimeError("Backend rejected the request (HTTP %s)" % exc.code) from None
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise RuntimeError("Receipt is unconfirmed. Rerun with the same --state file to reconcile.") from None
        time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--wav", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True, help="Unique local state file per deliberate recording; reuse it for retries")
    parser.add_argument("--context-id", help="Context from the read-back being answered")
    parser.add_argument("--output-dir", type=Path, default=Path("runtime/replies"))
    parser.add_argument("--allow-insecure-loopback", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=120)
    args = parser.parse_args()
    token = os.environ.get("CARELOOP_DEVICE_TOKEN", "")
    if not token:
        parser.error("Set CARELOOP_DEVICE_TOKEN in the process environment, never in a URL")
    root = base_url(args.base_url, args.allow_insecure_loopback)
    if args.wav.stat().st_size > MAX_BYTES:
        raise ValueError("WAV exceeds 768 KiB")
    wav = args.wav.read_bytes()
    validate_wav(wav)
    identity = {"base_url": root, "wav_sha256": hashlib.sha256(wav).hexdigest(), "context_id": args.context_id}
    if args.state.exists():
        state = json.loads(args.state.read_text())
        if any(state.get(key) != value for key, value in identity.items()):
            raise ValueError("State belongs to a different recording, backend or context. Use a new state file.")
        uuid.UUID(state["idempotency_key"])
    else:
        state = {**identity, "idempotency_key": str(uuid.uuid4())}
        save_state(args.state, state)
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    if not state.get("turn_id"):
        headers = {"Content-Type": "audio/wav", "Idempotency-Key": state["idempotency_key"]}
        if args.context_id:
            headers["X-Context-Id"] = args.context_id
        accepted = json.loads(request(opener, root + "/v1/device/turns", token, wav, headers))
        state["turn_id"] = accepted["turn_id"]
        save_state(args.state, state)
    deadline = time.monotonic() + args.wait_seconds
    while True:
        result = json.loads(request(opener, root + "/v1/device/turns/" + urllib.parse.quote(state["turn_id"], safe=""), token))
        if result["status"] not in {"accepted", "transcribing", "transcribed", "processing"}:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Processing is still pending. Rerun with the same --state file; do not create a second turn.")
        time.sleep(0.5)
    payload = (result.get("event") or {}).get("payload") or {}
    if result["status"] == "failed":
        raise RuntimeError("Turn processing failed. No successful care-record save is confirmed by this response.")
    paths = payload.get("audio_paths") or ([payload["audio_path"]] if payload.get("audio_path") else [])
    args.output_dir.mkdir(parents=True, exist_ok=True)
    files = []
    for path in paths:
        if not isinstance(path, str) or not re.fullmatch(r"/v1/device/audio/[A-Za-z0-9_-]+", path):
            raise ValueError("Backend returned a disallowed audio path")
        audio = request(opener, root + path, token)
        validate_wav(audio)
        output = args.output_dir / (path.rsplit("/", 1)[-1] + ".wav")
        with output.open("wb", opener=lambda name, flags: os.open(name, flags, 0o600)) as out:
            out.write(audio)
        files.append(str(output))
    print(json.dumps({"turn_id": state["turn_id"], "status": result["status"], "context_id": payload.get("context_id"), "spoken_text": payload.get("spoken_text"), "record_type": payload.get("record_type"), "record_id": payload.get("record_id"), "reply_files": files}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, wave.Error, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
