"""Paired, recording-scoped bridge to the shared Parse website."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4
import wave

import httpx

SITE = "https://parse-shared-voice.iians0n.chatgpt.site"
PHONE = "https://parse-phone-companion.iians0n.chatgpt.site"
COOKIE = "parse_voice_phone"


class RelayError(RuntimeError):
    """User-facing failure with no tokens, request headers or provider bodies."""


def private_json(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".parse-")
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, indent=2)
            output.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class OnlineParseRelay:
    def __init__(self, folder, *, transport=None):
        self.folder = Path(folder)
        self.path = self.folder / "parse-pairing-private.json"
        self.session = None
        self.transport = transport
        if self.path.exists():
            if self.path.is_symlink() or self.path.stat().st_mode & 0o077:
                raise RelayError("The relay pairing file must be private to your account.")
            value = json.loads(self.path.read_text())
            if re.fullmatch(r"[a-f0-9]{64}", value.get("token", "")):
                UUID(value["room_id"])
                self.session = value

    def _request(self, method, path, *, data=None, audio=None, token=None, retry=True, timeout=150):
        headers = {"Origin": PHONE, "X-Parse-Voice": "1"}
        token = token or (self.session or {}).get("token")
        if token:
            headers["Cookie"] = COOKIE + "=" + token
        kwargs = {"json": data} if audio is None else {"content": audio}
        headers["Content-Type"] = "application/json" if audio is None else "audio/wav"
        # All credentials are restricted to this exact bridge origin; redirects
        # cannot forward a cookie or audio to another host.
        with httpx.Client(timeout=timeout, follow_redirects=False, trust_env=False, transport=self.transport) as client:
            for attempt in range(3 if retry else 1):
                try:
                    response = client.request(method, PHONE + "/api/voice/phone/" + path, headers=headers, **kwargs)
                    if response.status_code >= 500 and retry and attempt < 2:
                        time.sleep(attempt + 1)
                        continue
                    if not response.is_success:
                        if response.status_code in {403, 410}:
                            raise RelayError("This ESP32 connection needs approval or has expired. Reconnect it from Parse → Phone & voice.")
                        raise RelayError("Parse could not finish this step. Use Retry sending to resume the same recording.")
                    return response.json(), response
                except httpx.HTTPError:
                    if retry and attempt < 2:
                        time.sleep(attempt + 1)
                        continue
                    raise RelayError("The shared Parse website could not be reached. Keep this recording and retry sending.") from None

    def pair(self, invitation):
        url = urlsplit(invitation)
        if url.scheme != "https" or url.netloc != urlsplit(PHONE).netloc or url.path != "/phone":
            raise RelayError("Use the ESP32 pairing link from the shared Parse website.")
        room = parse_qs(url.query).get("room", [""])[0]
        token = parse_qs(url.fragment).get("pair", [""])[0]
        try:
            UUID(room)
        except ValueError:
            raise RelayError("The pairing link is incomplete.") from None
        if not re.fullmatch(r"[a-f0-9]{64}", token):
            raise RelayError("The pairing link is incomplete.")
        value, response = self._request("POST", f"rooms/{room}/claim", data={"token": token}, retry=False)
        if value.get("room", {}).get("clientType") != "esp32":
            raise RelayError("Create an ESP32 connection in Parse, then open its pairing link.")
        issued = response.cookies.get(COOKIE)
        if not issued or not re.fullmatch(r"[a-f0-9]{64}", issued):
            raise RelayError("Pairing could not be saved. Create a new ESP32 connection in Parse.")
        self.session = {"room_id": room, "token": issued}
        private_json(self.path, self.session)
        return value["room"]

    def connection(self):
        if not self.session:
            return {"state": "unpaired"}
        value, _ = self._request("GET", "rooms/" + self.session["room_id"])
        room = value["room"]
        if room.get("clientType") != "esp32":
            raise RelayError("Connect the ESP32 relay from Parse before recording.")
        return room

    def control(self, data):
        if not self.session:
            raise RelayError("Connect this laptop in Parse first.")
        value, _ = self._request("POST", f"rooms/{self.session['room_id']}/relay", data=data, retry=False, timeout=12)
        return value

    def upload_reply(self, recording_id, wav):
        UUID(recording_id)
        self._request("POST", f"recordings/{recording_id}/reply", audio=wav)

    def submit(self, path, progress):
        if self.connection()["state"] != "paired":
            raise RelayError("Approve the matching ESP32 code on the Parse website first.")
        raw = Path(path).read_bytes()
        with wave.open(io.BytesIO(raw), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000) or not 4800 <= wav.getnframes() <= 320000:
                raise RelayError("Record 0.3–20 seconds of 16 kHz mono audio.")
            pcm = wav.readframes(wav.getnframes())
            if len(pcm) != wav.getnframes() * 2:
                raise RelayError("The microphone recording is incomplete.")
        digest = hashlib.sha256(raw).hexdigest()
        ledger = self.folder / ("parse-upload-" + digest + ".json")
        job = json.loads(ledger.read_text()) if ledger.exists() else {}
        if job.get("room_id") != self.session["room_id"]:
            job = {"room_id": self.session["room_id"], "recording_id": str(uuid4()), "sha256": digest}
            private_json(ledger, job)
        rid = job["recording_id"]
        progress(phase="uploading", message="Sending this ESP32 recording to the shared Parse website.", parse_recording_id=rid)
        value, _ = self._request("POST", "recordings", data={"roomId": job["room_id"], "recordingId": rid})
        recording = value["recording"]
        chunks = [pcm[at:at + 32000] for at in range(0, len(pcm), 32000)]
        if recording["state"] == "receiving":
            for sequence in range(recording["chunks"], len(chunks)):
                chunk = io.BytesIO()
                with wave.open(chunk, "wb") as wav:
                    wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                    wav.writeframes(chunks[sequence])
                self._request("POST", f"recordings/{rid}/chunks/{sequence}", audio=chunk.getvalue())
                progress(message=f"Uploaded {sequence + 1} of {len(chunks)} audio chunks to Parse.")
        progress(phase="interpreting", message="Parse is transcribing your words and choosing the relevant care function.")
        value, _ = self._request("POST", f"recordings/{rid}/finish", data={"chunks": len(chunks)})
        result = value.get("relay")
        if not isinstance(result, dict):
            raise RelayError("Your recording reached Parse. Open its voice inbox to review the transcript.")
        job["result"] = result
        job["completed_at"] = time.time()
        private_json(ledger, job)
        return {**result, "recordingId": rid}
