#!/usr/bin/env python3
"""ESP32 audio dashboard with an explicit record-to-Parse workflow."""
import argparse
import asyncio
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from dotenv import load_dotenv
load_dotenv(ROOT / "backend/.env", override=False)
from app.openai_provider import from_environment
from parse_online_relay import OnlineParseRelay, RelayError, SITE, private_json
from parse_remote_control import RemoteControl


def play_speaker_reply(serial_python, serial_port, reply):
    """Run the isolated Bluetooth helper; a transfer alone is not playback."""
    report_path = reply.with_suffix(".speaker.json")
    report_path.unlink(missing_ok=True)
    result = subprocess.run([
        serial_python, str(ROOT / "tools/esp32_ble_speaker.py"), "--port", serial_port,
        "--input", str(reply), "--report", str(report_path),
    ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=190)
    reply.with_suffix(".speaker.log").write_text(result.stdout)
    if result.returncode or not report_path.exists():
        raise RuntimeError("ESP32 speaker playback did not complete")
    report = json.loads(report_path.read_text())
    if (report.get("speaker_driver_completed") is not True
            or report.get("checksum_verified_on_esp32") is not True
            or report.get("sha256") != hashlib.sha256(reply.read_bytes()).hexdigest()):
        raise RuntimeError("ESP32 speaker completion could not be verified")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial-port", default="/dev/cu.usbmodem5CE52139521")
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--serial-python", default="/private/tmp/parse-esp32-tools/bin/python")
    parser.add_argument("--transport", choices=["usb", "bluetooth"], default="usb")
    parser.add_argument("--speaker-output", choices=["laptop", "esp32"], default="laptop",
                        help="Play replies on the ESP32 with the Bluetooth speaker firmware")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "runtime/esp32-20261009")
    args = parser.parse_args()
    if args.speaker_output == "esp32" and args.transport != "bluetooth":
        parser.error("--speaker-output esp32 requires --transport bluetooth")
    folder = args.data_dir.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    relay = OnlineParseRelay(folder)
    lock = threading.RLock()
    state = {"busy": False, "phase": "idle", "message": "Ready for a deliberate six-second recording.",
             "transport": "Bluetooth LE" if args.transport == "bluetooth" else "USB", "bluetooth": "Ready for a test" if args.transport == "bluetooth" else "Mac scanner verified; board relay not installed",
             "transcript": "", "reply_text": "", "error": None, "levels": [], "capture": None,
             "speech_ready": (folder / "parse-tts-test.wav").exists(),
             "speaker_output": args.speaker_output, "speaker_status": "idle",
             "parse_url": SITE, "parse_connection": {"state": "checking"},
             "parse_result": None, "can_retry": False}
    files = {"speech": folder / "parse-tts-test.wav"}

    def update(**values):
        with lock:
            state.update(values)

    def import_audio(path):
        raw = path.read_bytes()
        with wave.open(io.BytesIO(raw), "rb") as wav:
            rate, frames = wav.getframerate(), wav.getnframes()
            if (wav.getnchannels(), wav.getsampwidth(), rate) != (1, 2, 16000):
                raise ValueError("Unsupported microphone WAV")
            samples = struct.unpack("<" + str(frames) + "h", wav.readframes(frames))
        mean = sum(samples) / len(samples)
        rms = math.sqrt(sum((s - mean) ** 2 for s in samples) / len(samples))
        peak = max(abs(s) for s in samples)
        gain = min(40.0, 26000 / max(1, max(abs(s - mean) for s in samples)))
        normal = io.BytesIO()
        with wave.open(normal, "wb") as wav:
            wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
            wav.writeframes(struct.pack("<" + str(frames) + "h", *(max(-32768, min(32767, round((s - mean) * gain))) for s in samples)))
        boosted = path.with_name(path.stem + "-listen.wav")
        boosted.write_bytes(normal.getvalue())
        with lock:
            files["microphone"] = path
            files["listen"] = boosted
            state["capture"] = {"id": hashlib.sha256(raw).hexdigest(), "seconds": frames / rate,
                "rate": rate, "frames": frames, "peak": peak,
                "peak_dbfs": round(20 * math.log10(max(peak, 0.0001) / 32768), 1),
                "rms_dbfs": round(20 * math.log10(max(rms, 0.0001) / 32768), 1),
                "clipped": sum(abs(s) >= 32767 for s in samples), "unique": len(set(samples)),
                "listen_gain": round(gain, 1), "recorded_at": path.stat().st_mtime}

    candidates = [folder / "microphone-test.wav", *folder.glob("mic-[0-9]*.wav"), folder / "bluetooth-microphone-test.wav"]
    candidates = [path for path in candidates if path.exists() and not path.stem.endswith("-listen")]
    initial = max(candidates, key=lambda path: path.stat().st_mtime) if candidates else folder / "microphone-test.wav"
    if initial.exists():
        import_audio(initial)
    pending_path = folder / "parse-pending-recording.json"
    if pending_path.exists() and not pending_path.is_symlink():
        try:
            pending = json.loads(pending_path.read_text())
            source = (folder / pending["filename"]).resolve()
            if (source.parent == folder and source.is_file()
                    and pending.get("room_id") == (relay.session or {}).get("room_id")
                    and hashlib.sha256(source.read_bytes()).hexdigest() == pending["sha256"]):
                import_audio(source)
                state.update(can_retry=True, message="An unfinished clip is ready to retry in Parse.")
        except (ValueError, KeyError, OSError):
            pass
    replies = list(folder.glob("mic-reply-*.wav"))
    if replies:
        files["speech"] = max(replies, key=lambda path: path.stat().st_mtime)
        state["speech_ready"] = True

    def capture(send=True):
        target = folder / ("mic-" + str(time.time_ns()) + ".wav")
        try:
            if args.transport == "bluetooth":
                command = [args.serial_python, str(ROOT / "tools/esp32_ble_relay.py"), "--port", args.serial_port, "--output", str(target)]
            else:
                command = [args.serial_python, str(ROOT / "tools/esp32_bench.py"), "record", "--port", args.serial_port, "--output", str(target)]
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            log = []
            for line in process.stdout:
                log.append(line)
                if "MIC_COUNTDOWN" in line:
                    update(phase="countdown", message="Recording starts in 3 seconds. Speak near the INMP441.")
                elif "MIC_RECORDING" in line:
                    update(phase="recording", message="Recording for 6 seconds — speak or clap now.", recording_started=time.time())
                elif "MIC_STOPPED" in line:
                    update(phase="transfer", message="Capture stopped. Receiving the WAV over " + state["transport"] + ".")
                elif line.startswith("BLE_CONNECTED"):
                    update(bluetooth="Connected · encrypted", message="Bluetooth connected. Preparing the microphone.")
                elif line.startswith("BLE_PROGRESS"):
                    percent = int(line.strip().split()[-1])
                    update(transfer_percent=percent, message=f"Receiving microphone audio over Bluetooth: {percent}%")
                elif line.startswith("MIC_LEVEL"):
                    with lock:
                        state["levels"].append(line.strip())
            code = process.wait()
            target.with_suffix(".receiver.log").write_text("".join(log))
            if code != 0:
                raise RuntimeError("Capture failed. Keep the board connected, allow Bluetooth access, and close other serial monitors.")
            import_audio(target)
            if send:
                private_json(pending_path, {"filename": target.name,
                    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                    "room_id": (relay.session or {}).get("room_id")})
            update(can_retry=send)
            update(phase="idle", message="New ESP32 recording received over " + state["transport"] + "; checksum verified.",
                   bluetooth="Verified · disconnects between tests" if args.transport == "bluetooth" else state["bluetooth"])
            if send:
                send_to_parse()
        except Exception as exc:
            update(phase="error", error=str(exc) if isinstance(exc, RuntimeError) else "The capture could not be completed.")
        finally:
            update(busy=False)

    def send_to_parse():
        update(speaker_status="idle")
        try:
            with lock:
                source = files["microphone"]
            result = relay.submit(source, update)
            update(parse_result=result, transcript=result.get("transcript", ""), reply_text=result.get("spokenText", ""))
            if result.get("error"):
                raise RelayError(result["error"])
            update(can_retry=False)
            pending_path.unlink(missing_ok=True)
            text = result.get("spokenText", "")
            if text:
                update(phase="speech", message="The transcript and response are on Parse. Preparing the spoken reply.")
                try:
                    reply = folder / ("mic-reply-" + result["recordingId"] + ".wav")
                    wav = reply.read_bytes() if reply.exists() else asyncio.run(from_environment().synthesise_speech(text[:600]))
                    reply.write_bytes(wav)
                    reply.with_suffix(".json").write_text(json.dumps({"transcript": result["transcript"], "reply_text": text,
                        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "reply_sha256": hashlib.sha256(wav).hexdigest(),
                        "transport": state["transport"], "parse_recording_id": result["recordingId"]}, indent=2) + "\n")
                    with lock:
                        files["speech"] = reply
                    relay.upload_reply(result["recordingId"], wav)
                    update(speech_ready=True, speech_id=hashlib.sha256(wav).hexdigest())
                except Exception:
                    update(error="Sent to Parse successfully. The spoken reply is unavailable; read the response below.")
                else:
                    if args.speaker_output == "esp32":
                        update(phase="speech", speaker_status="sending",
                               message="Saved in Parse. Sending the spoken reply to the ESP32 speaker…")
                        try:
                            play_speaker_reply(args.serial_python, args.serial_port, reply)
                            update(speaker_status="complete")
                        except Exception:
                            update(speaker_status="error", error="Saved in Parse. ESP32 playback failed; use the dashboard audio player to hear the reply.")
            update(phase="complete", message="Sent to Parse. Review the prepared update in the shared dashboard." if result.get("proposalId") else "Sent to Parse. Your transcript and response are ready.")
        except RelayError as exc:
            update(phase="error", error=str(exc), message="Your microphone recording is kept. Retry sending the same clip.")
        except Exception:
            update(phase="error", error="The Parse connection was interrupted. Retry sending this recording.")
        finally:
            update(busy=False)

    def snapshot():
        with lock:
            return {"busy": state["busy"], "hardwareReady": Path(args.serial_port).exists(),
                    "canRetry": state["can_retry"], "phase": state["phase"], "message": state["message"],
                    "error": state["error"] or "", "transport": state["transport"],
                    "transferPercent": state.get("transfer_percent", 0),
                    "recordingStarted": state.get("recording_started", 0) * 1000}

    def start_remote(kind, finished):
        with lock:
            if state["busy"] or kind not in {"capture", "retry"}:
                return False
            if kind == "retry" and not state["can_retry"]:
                return False
            if kind == "capture" and not Path(args.serial_port).exists():
                return False
            state.update(busy=True, error=None, phase="connecting", message="Connecting to the ESP32…")
            if kind == "capture":
                state.update(levels=[], transcript="", reply_text="", parse_result=None,
                             can_retry=False, speech_ready=False, transfer_percent=0)
            def work():
                try:
                    (capture if kind == "capture" else send_to_parse)()
                finally:
                    with lock:
                        success = state["phase"] == "complete"
                    finished(success)
            threading.Thread(target=work, daemon=True).start()
            return True

    controller = RemoteControl(relay, folder, snapshot, start_remote)

    def remote_loop():
        while True:
            try:
                if state["parse_connection"].get("state") == "paired":
                    controller.tick()
            except Exception:
                # Transient network failures never trigger capture or discard
                # a command receipt; the next poll safely resumes reporting.
                pass
            time.sleep(2)

    def refresh_connection():
        while True:
            try:
                update(parse_connection=relay.connection())
            except RelayError as exc:
                update(parse_connection={"state": "unavailable", "message": str(exc)})
            except Exception:
                update(parse_connection={"state": "unavailable", "message": "The shared Parse connection is unavailable."})
            time.sleep(10)

    def pair(invitation):
        try:
            update(parse_connection=relay.pair(invitation), phase="idle", message="Compare the code, then approve this ESP32 connection on the Parse website.")
        except RelayError as exc:
            update(phase="error", error=str(exc))
        except Exception:
            update(phase="error", error="Pairing could not finish. Create a new ESP32 connection in Parse.")
        finally:
            update(busy=False)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, body, content_type="application/json", status=200):
            if not isinstance(body, bytes):
                body = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            return self.headers.get("Host") in {f"127.0.0.1:{args.port}", f"localhost:{args.port}"}

        def do_GET(self):
            if not self.valid_host():
                return self.send({"error": "Invalid host"}, status=403)
            path = urlsplit(self.path).path
            if path == "/":
                return self.send((ROOT / "tools/esp32_audio_dashboard.html").read_bytes(), "text/html; charset=utf-8")
            if path == "/api/status":
                with lock:
                    return self.send(dict(state))
            if path.startswith("/audio/"):
                with lock:
                    file = files.get(path.removeprefix("/audio/"))
                if file and file.is_file():
                    return self.send(file.read_bytes(), "audio/wav")
            return self.send({"error": "Not found"}, status=404)

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.send({"error": "Invalid request length"}, status=400)
            if (not self.valid_host() or self.headers.get("Origin") not in {f"http://127.0.0.1:{args.port}", f"http://localhost:{args.port}"}
                    or self.headers.get("X-Parse-Bench") != "1" or not 0 <= length <= 4096):
                return self.send({"error": "Open the local dashboard to start a test"}, status=403)
            path = urlsplit(self.path).path
            if path not in {"/api/record-send", "/api/retry", "/api/pair"}:
                return self.send({"error": "Not found"}, status=404)
            try:
                body = json.loads(self.rfile.read(length)) if length else {}
            except (ValueError, UnicodeDecodeError):
                return self.send({"error": "Invalid request"}, status=400)
            if not isinstance(body, dict):
                return self.send({"error": "Invalid request"}, status=400)
            with lock:
                if state["busy"]:
                    return self.send({"error": "A test is already running"}, status=409)
                if path == "/api/pair":
                    invitation = body.get("invitation")
                    if not isinstance(invitation, str) or len(invitation) > 1200:
                        return self.send({"error": "Use the pairing link from Parse"}, status=400)
                    target = lambda: pair(invitation)
                else:
                    if state["parse_connection"].get("state") != "paired":
                        return self.send({"error": "Connect and approve this ESP32 relay in the shared Parse dashboard first."}, status=409)
                    if path == "/api/retry" and not state["can_retry"]:
                        return self.send({"error": "There is no unfinished recording to send."}, status=400)
                    target = capture if path == "/api/record-send" else send_to_parse
                state.update(busy=True, error=None, phase="connecting", message="Connecting…")
                if path == "/api/record-send":
                    state.update(levels=[], transcript="", reply_text="", parse_result=None, can_retry=False, speech_ready=False, transfer_percent=0)
                threading.Thread(target=target, daemon=True).start()
            return self.send({"accepted": True}, status=202)

    print(f"ESP32 audio dashboard: http://127.0.0.1:{args.port}", flush=True)
    threading.Thread(target=refresh_connection, daemon=True).start()
    threading.Thread(target=remote_loop, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
