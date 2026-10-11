#!/usr/bin/env python3
"""Send one speech WAV over encrypted Bluetooth and wait for ESP32 playback.

USB supplies a fresh, three-minute session key. This command never records the
microphone and never plays audio on the laptop.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import struct
import threading
import time

from bleak import BleakClient, BleakScanner
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import serial

SERVICE = "91bad492-b950-4226-aa2b-4ede9fa42f59"
RPC = "0d563a58-196a-48ce-ace2-dfec78acc814"


def validate_wav(wav):
    """Match the firmware's bounded, canonical PCM WAV format before any I/O."""
    if not 9644 <= len(wav) <= 640044:
        raise ValueError("Speaker WAV must contain 0.3–20 seconds of audio")
    header = struct.unpack_from("<4sI4s4sIHHIIHH4sI", wav)
    expected = (b"RIFF", len(wav) - 8, b"WAVE", b"fmt ", 16, 1, 1,
                16000, 32000, 2, 16, b"data", len(wav) - 44)
    if header != expected or (len(wav) - 44) % 2:
        raise ValueError("Speaker WAV must be canonical mono 16 kHz PCM16")
    return (len(wav) - 44) / 32000


async def send_wav(rpc, wav, *, chunk_size=200, timeout=140, poll=.15, progress=None):
    seconds = validate_wav(wav)
    if not 1 <= chunk_size <= 231:
        raise ValueError("Invalid Bluetooth speaker chunk size")
    digest = hashlib.sha256(wav).digest()
    started = time.monotonic()

    async def status():
        value = await rpc(b"\x09")
        if len(value) != 6 or value[0] != 1:
            raise RuntimeError("ESP32 speaker playback is not enabled in this firmware")
        state, error = value[1], struct.unpack_from("<I", value, 2)[0]
        if state > 5:
            raise RuntimeError("Invalid ESP32 speaker status")
        return state, error

    async def transfer():
        state, _ = await status()
        if state in (2, 3):
            raise RuntimeError("ESP32 speaker is already busy")
        await rpc(b"\x05" + struct.pack("<I", len(wav)) + digest)
        next_progress = 25
        for offset in range(0, len(wav), chunk_size):
            chunk = wav[offset:offset + chunk_size]
            # Each write is acknowledged by ATT. The final authenticated digest
            # also verifies acceptance, order and completeness of every chunk.
            await rpc(b"\x06" + struct.pack("<I", offset) + chunk, read_reply=False)
            percent = (offset + len(chunk)) * 100 // len(wav)
            if percent >= next_progress:
                if progress:
                    progress(f"BLE_SPEAKER_PROGRESS {percent}")
                next_progress += 25
        received = await rpc(b"\x07")
        if received != digest:
            raise RuntimeError("ESP32 reply SHA-256 verification failed")
        if progress:
            progress("BLE_SPEAKER_PLAYING checksum verified; waiting for playback")
        while True:
            state, error = await status()
            if state == 4 and error == 0:
                return
            if state == 5 or error:
                raise RuntimeError(f"ESP32 speaker driver failed (0x{error:x})")
            if state not in (2, 3):
                raise RuntimeError("ESP32 lost the queued speaker playback")
            await asyncio.sleep(poll)

    try:
        await asyncio.wait_for(transfer(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        raise RuntimeError("ESP32 speaker transfer or playback timed out") from exc
    return {"transport": "Bluetooth LE", "encrypted": True,
            "bytes": len(wav), "seconds": seconds, "sha256": digest.hex(),
            "checksum_verified_on_esp32": True, "speaker_driver_completed": True,
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "audibility": "Requires a listening check"}


async def exercise(wav, key):
    device = await BleakScanner.find_device_by_filter(
        lambda _dev, ad: SERVICE in [value.lower() for value in ad.service_uuids], timeout=15)
    if not device:
        raise RuntimeError("Parse Bluetooth advertisement not found")
    aes, counter = AESGCM(key), 0
    async with BleakClient(device, timeout=20) as client:
        async def rpc(payload, *, read_reply=True):
            nonlocal counter
            counter += 1
            sequence = struct.pack("<I", counter)
            packet = sequence + aes.encrypt(b"PARSE-RX" + sequence, payload, None)
            await client.write_gatt_char(RPC, packet, response=True)
            if not read_reply:
                return b""
            received = bytes(await client.read_gatt_char(RPC))
            if len(received) < 21 or received[:4] != sequence:
                raise RuntimeError("Bluetooth response sequence mismatch")
            response = aes.decrypt(b"PARSE-TX" + sequence, received[4:], None)
            if not response or response[0]:
                raise RuntimeError("ESP32 rejected Bluetooth speaker command")
            return response[1:]

        if await rpc(b"\x01") != b"Parse ESP32-S3 BLE v1":
            raise RuntimeError("Unexpected Bluetooth firmware identity")
        chunk_size = min(200, client.mtu_size - 28)
        print("BLE_SPEAKER_CONNECTED authenticated encrypted session", flush=True)
        return await send_wav(rpc, wav, chunk_size=chunk_size,
                              progress=lambda value: print(value, flush=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    wav = args.input.read_bytes()
    validate_wav(wav)
    port = serial.Serial()
    port.port, port.baudrate, port.timeout = args.port, 115200, .1
    port.dtr = port.rts = False
    stop, monitor_thread = threading.Event(), None
    brownouts = []
    port.open()
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
            raise RuntimeError("ESP32 did not provide a Bluetooth session; check firmware")
        print("BLE_SPEAKER_ARMED private session authorized over USB", flush=True)

        def monitor():
            while not stop.is_set():
                try:
                    line = port.readline().decode(errors="replace").strip()
                    if line.startswith(("BLE_TTS_RECEIVED", "BLE_TTS_PLAYBACK")):
                        print(line, flush=True)
                    if "brownout" in line.lower():
                        brownouts.append(True)
                except serial.SerialException:
                    break

        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        report = asyncio.run(exercise(wav, key))
        report["brownout_events"] = len(brownouts)
        if brownouts:
            raise RuntimeError("ESP32 reported a power reset during the speaker test")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2), flush=True)
    finally:
        stop.set()
        if monitor_thread:
            monitor_thread.join(timeout=.5)
        port.close()


if __name__ == "__main__":
    main()
