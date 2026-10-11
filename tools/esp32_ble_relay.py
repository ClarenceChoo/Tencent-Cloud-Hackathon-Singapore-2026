#!/usr/bin/env python3
"""ESP32 audio over encrypted Bluetooth LE, with a USB session-key handoff.

The USB cable provides power and authorizes a three-minute bench session.
Capture commands, WAV data, and optional reply audio cross Bluetooth LE.
No Wi-Fi credentials or persistent Bluetooth keys are required.
"""
import argparse
import asyncio
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import threading
import time
import wave

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import serial

SERVICE = "91bad492-b950-4226-aa2b-4ede9fa42f59"
RPC = "0d563a58-196a-48ce-ace2-dfec78acc814"
AUDIO = "1d563a58-196a-48ce-ace2-dfec78acc814"


async def exercise(args, key):
    device = await BleakScanner.find_device_by_filter(
        lambda dev, ad: SERVICE in [value.lower() for value in ad.service_uuids], timeout=15)
    if not device:
        raise RuntimeError("Parse Bluetooth advertisement not found")
    aes, counter, last_request = AESGCM(key), 0, None
    async with BleakClient(device, timeout=20) as client:
        async def rpc(payload, *, read_reply=True):
            nonlocal counter, last_request
            counter += 1
            sequence = struct.pack("<I", counter)
            encrypted = aes.encrypt(b"PARSE-RX" + sequence, payload, None)
            last_request = sequence + encrypted
            await client.write_gatt_char(RPC, last_request, response=True)
            if not read_reply:
                return b""
            packet = bytes(await client.read_gatt_char(RPC))
            if packet[:4] != sequence:
                raise RuntimeError("Bluetooth response sequence mismatch")
            response = aes.decrypt(b"PARSE-TX" + sequence, packet[4:], None)
            if not response or response[0]:
                raise RuntimeError("ESP32 rejected Bluetooth command")
            return response[1:]

        identity = await rpc(b"\x01")
        if identity != b"Parse ESP32-S3 BLE v1":
            raise RuntimeError("Unexpected Bluetooth firmware identity")
        async def require_rejection(packet):
            try:
                await client.write_gatt_char(RPC, packet, response=True)
            except BleakError:
                return
            raise RuntimeError("Bluetooth authentication/replay check did not reject the invalid request")
        await require_rejection(last_request)
        next_sequence = struct.pack("<I", counter + 1)
        tampered = bytearray(next_sequence + aes.encrypt(b"PARSE-RX" + next_sequence, b"\x01", None))
        tampered[-1] ^= 1
        await require_rejection(tampered)
        print("BLE_CONNECTED authenticated encrypted session; capture data uses Bluetooth", flush=True)
        await rpc(b"\x02")
        deadline = time.monotonic() + 25
        while True:
            state = await rpc(b"\x03")
            if state[0] == 2:
                break
            if time.monotonic() > deadline:
                raise RuntimeError("ESP32 microphone capture did not complete")
            await asyncio.sleep(.3)
        size = struct.unpack_from("<I", state, 1)[0]
        expected_hash = state[5:37]
        if not 44 < size <= 640044:
            raise RuntimeError("Invalid Bluetooth WAV size")
        print("BLE_TRANSFER receiving microphone WAV", flush=True)
        audio = bytearray()
        transfer_started = time.monotonic()
        next_progress, last_counter = 25, 0
        complete, stream_errors = asyncio.Event(), []
        def notification(_characteristic, packet):
            nonlocal next_progress, last_counter
            try:
                packet = bytes(packet)
                count = struct.unpack_from("<I", packet)[0]
                if count <= last_counter:
                    raise RuntimeError("Repeated Bluetooth audio packet")
                content = aes.decrypt(b"PARSE-AU" + packet[:4], packet[4:], None)
                offset = struct.unpack_from("<I", content)[0]
                if offset != len(audio) or len(content) <= 4 or len(audio) + len(content) - 4 > size:
                    raise RuntimeError("Bluetooth audio sequence or length mismatch")
                audio.extend(content[4:]); last_counter = count
                percent = len(audio) * 100 // size
                if percent >= next_progress:
                    print(f"BLE_PROGRESS {percent}", flush=True); next_progress += 25
                if len(audio) == size:
                    complete.set()
            except Exception as exc:
                stream_errors.append(type(exc).__name__); complete.set()
        await client.start_notify(AUDIO, notification)
        await rpc(b"\x08")
        await asyncio.wait_for(complete.wait(), timeout=60)
        await client.stop_notify(AUDIO)
        if stream_errors:
            raise RuntimeError("Bluetooth stream integrity check failed: " + stream_errors[0])
        if hashlib.sha256(audio).digest() != expected_hash:
            raise RuntimeError("Bluetooth microphone SHA-256 verification failed")
        with wave.open(io.BytesIO(audio), "rb") as wav:
            if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
                raise RuntimeError("Unexpected Bluetooth audio format")
            seconds = wav.getnframes() / 16000
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(audio)
        report = {"transport": "Bluetooth LE", "encrypted": True, "checksum_verified": True,
            "session_authorization": "Ephemeral key over physical USB; expires after 3 minutes",
            "bytes": size, "seconds": seconds, "sha256": expected_hash.hex(),
            "transfer_seconds": round(time.monotonic() - transfer_started, 2),
            "tampered_request_rejected": True, "replayed_request_rejected": True,
            "file": str(args.output.resolve())}
        if args.reply_wav:
            from esp32_ble_speaker import send_wav
            reply = args.reply_wav.read_bytes()
            report["speaker_playback"] = await send_wav(
                rpc, reply, chunk_size=min(200, client.mtu_size - 28),
                progress=lambda value: print(value, flush=True))
        args.output.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reply-wav", type=Path)
    parser.add_argument("--play-reference", type=Path)
    args = parser.parse_args()
    port = serial.Serial()
    port.port, port.baudrate, port.timeout = args.port, 115200, .1
    port.dtr = port.rts = False
    port.open()
    stop = threading.Event()
    try:
        ready = time.monotonic() + 2.5
        while time.monotonic() < ready:
            port.read(port.in_waiting or 1)
        port.reset_input_buffer()
        port.write(b"ble\n"); port.flush()
        deadline, key = time.monotonic() + 8, None
        while time.monotonic() < deadline:
            line = port.readline().decode(errors="replace").strip()
            if line.startswith("BLE_ARM "):
                value = json.loads(line[8:])
                key = bytes.fromhex(value["key"])
                if len(key) != 32 or value["service"] != SERVICE:
                    raise RuntimeError("Invalid USB Bluetooth session handoff")
                break
        if key is None:
            raise RuntimeError("ESP32 did not provide a Bluetooth session; check installed firmware")
        print("BLE_ARMED private session authorized over USB", flush=True)

        def monitor():
            while not stop.is_set():
                try:
                    line = port.readline().decode(errors="replace").strip()
                    if line.startswith(("MIC_COUNTDOWN", "MIC_RECORDING", "MIC_STOPPED", "MIC_LEVEL", "BLE_TTS_RECEIVED")):
                        print(line, flush=True)
                    if line.startswith("MIC_RECORDING") and args.play_reference:
                        subprocess.Popen(["/usr/bin/afplay", str(args.play_reference.resolve())],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except serial.SerialException:
                    break
        thread = threading.Thread(target=monitor, daemon=True)
        thread.start()
        asyncio.run(exercise(args, key))
    finally:
        stop.set()
        port.close()


if __name__ == "__main__":
    main()
