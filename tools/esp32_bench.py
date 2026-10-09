#!/usr/bin/env python3
"""Receive a bounded microphone recording or run the ESP32's HTTPS probe.

Use the microphone diagnostic firmware. Credentials are read from a local file,
sent only over the selected USB serial port, and never included in output.
"""
import argparse
import base64
import binascii
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import time
import wave

import serial


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["record", "network"])
    parser.add_argument("--port", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--wifi-config", type=Path)
    parser.add_argument("--play-reference", type=Path, help="Play a local WAV on macOS during the capture")
    args = parser.parse_args()
    if args.mode == "network":
        if not args.wifi_config:
            parser.error("--wifi-config is required for network")
        config = json.loads(args.wifi_config.read_text())
        ssid, password = config.get("ssid"), config.get("password")
        if not isinstance(ssid, str) or not 1 <= len(ssid.encode()) <= 32:
            parser.error("Enter the Wi-Fi SSID in the private configuration file")
        if not isinstance(password, str) or not 8 <= len(password.encode()) <= 63:
            parser.error("Enter a WPA2 password in the private configuration file")
        command = "net " + json.dumps({"ssid": ssid, "password": password, "epoch": int(time.time())}, separators=(",", ":"), ensure_ascii=False)
        if len(command.encode()) >= 511:
            parser.error("Encoded Wi-Fi configuration exceeds the serial command limit")
    else:
        command = "record"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    connection = serial.Serial()
    connection.port, connection.baudrate, connection.timeout = args.port, 115200, 0.25
    connection.dtr = False
    connection.rts = False
    connection.open()
    lines, data = [], bytearray()
    expected_size = expected_hash = None
    finished = False
    try:
        # The WCH bridge can reset this board when the port opens, even with
        # DTR/RTS requested low. Let startup complete before sending a command.
        ready_deadline = time.monotonic() + 2.5
        while time.monotonic() < ready_deadline:
            connection.read(connection.in_waiting or 1)
        connection.reset_input_buffer()
        connection.write((command + "\n").encode())
        connection.flush()
        command = None
        deadline = time.monotonic() + 100
        pending = bytearray()
        while time.monotonic() < deadline:
            pending.extend(connection.read(connection.in_waiting or 1))
            if len(pending) > 65536:
                raise RuntimeError("Serial framing exceeded the buffer limit")
            while b"\n" in pending:
                raw, _, pending = pending.partition(b"\n")
                line = raw.decode("utf-8", errors="replace").strip()
                if line.startswith("MIC_DATA "):
                    if expected_size is None:
                        raise RuntimeError("Audio data arrived without a header")
                    try:
                        data.extend(base64.b64decode(line[9:], validate=True))
                    except binascii.Error:
                        args.output.with_suffix(".invalid-frame.txt").write_text(line)
                        raise RuntimeError("Invalid serial audio frame; saved locally for diagnosis") from None
                    if len(data) > expected_size:
                        raise RuntimeError("Audio exceeded declared length")
                    continue
                if not line:
                    continue
                lines.append(line)
                print(line, flush=True)
                if line.startswith("MIC_RECORDING") and args.play_reference:
                    subprocess.Popen(["/usr/bin/afplay", str(args.play_reference.resolve())],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if line.startswith("MIC_ERROR") or line.startswith("BENCH_ERROR") or line.startswith("NET_ERROR"):
                    raise RuntimeError("Device diagnostic reported an error")
                if line.startswith("MIC_WAV_BEGIN "):
                    _, size, expected_hash = line.split()
                    expected_size = int(size)
                    if not 44 < expected_size <= 640044:
                        raise RuntimeError("Invalid WAV length")
                if (args.mode == "record" and line == "MIC_WAV_END") or (args.mode == "network" and line.startswith("NET_DONE")):
                    finished = True
                    break
            if finished:
                break
        if not finished:
            raise RuntimeError("Timed out waiting for the diagnostic to finish")
    finally:
        connection.close()
        args.output.with_suffix(".console.log").write_text("\n".join(lines) + "\n")
    if args.mode == "record":
        if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected_hash:
            raise RuntimeError("WAV length or SHA-256 verification failed")
        with wave.open(io.BytesIO(data), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise RuntimeError("Unexpected WAV format")
            frames = wav.getnframes()
            samples = struct.unpack("<" + str(frames) + "h", wav.readframes(frames))
        peak = max(abs(sample) for sample in samples)
        unique = len(set(samples))
        args.output.write_bytes(data)
        report = {"transport": "USB serial", "checksum_verified": True, "sha256": expected_hash,
                  "frames": frames, "seconds": frames / 16000, "peak_pcm16": peak,
                  "unique_sample_values": unique, "signal_present": unique > 1,
                  "acoustic_response_verified": False,
                  "note": "Changing samples alone do not establish intelligible speech or acoustic response.",
                  "file": str(args.output.resolve())}
        args.output.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
    else:
        report = {"source": "ESP32-S3", "events": [line for line in lines if line.startswith("NET_")]}
        args.output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
