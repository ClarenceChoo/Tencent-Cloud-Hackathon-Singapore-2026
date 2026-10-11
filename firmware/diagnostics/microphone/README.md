# ESP32 microphone and laptop relay bench

This diagnostic captures the **INMP441 on the ESP32**, never the laptop microphone. It records exactly six seconds after a three-second countdown and otherwise leaves capture idle. The confirmed board has 16 MB flash, 8 MB Octal PSRAM, and UART0 at 115200 through a WCH USB bridge.

The microphone wiring is SCK → GPIO 4, WS → GPIO 5, SD → GPIO 6, and L/R → GND (left). Use 3.3 V and common ground for the microphone. The 10 October CareLoop hardware handover supersedes the older GPIO 17 amplifier-enable assumption: MAX98357A SD/EN is tied to 3V3, with BCLK → GPIO 7, LRC/WS → GPIO 15, and DIN → GPIO 16. The user heard the tone test with this configuration on 11 October. Speaker output is opt-in through `sdkconfig.speaker-handover`; the older microphone-only overlay still holds GPIO 17 low.

The receiver clocks two 32-bit Philips I²S slots at 16 kHz, giving the INMP441 its required 64 clocks per stereo frame. It selects the left sample, converts the signed 24-bit input to 16-bit PCM, and writes a mono WAV. See the [TDK INMP441 datasheet](https://invensense.tdk.com/wp-content/uploads/2015/02/INMP441.pdf).

## Dashboard

From the repository root, with the backend dependencies and the serial/Bluetooth tools available:

```sh
backend/.venv/bin/python tools/esp32_audio_dashboard.py \
  --transport bluetooth \
  --serial-port /dev/cu.usbmodem5CE52139521 \
  --serial-python backend/.venv/bin/python
```

Open **http://127.0.0.1:8768**. The server listens only on loopback. Use **Record 6 seconds**, speak near the INMP441, and clap once. The spectrogram and waveform update after the complete WAV arrives. They do not claim to show continuous live audio. Measured RMS and peak use the original signal; the listening copy has its DC offset removed and gain capped at 40×. Changing the spectrogram floor changes only the display.

The shared [Parse → Phone & voice](https://parse-shared-voice.iians0n.chatgpt.site/?view=voice) workspace now provides **Record & send**, the spectrogram, transcript, reply, and proposed care update. Follow the [relay setup guide](../../../tools/ESP32_VOICE_RELAY.md) after building this firmware. The local page remains available for setup and diagnostics. A care proposal requires separate dashboard confirmation before saving.

The Bluetooth version still uses USB for power and for handing a fresh session key to the laptop. Capture commands and the WAV then cross Bluetooth LE. This establishes an audio relay, not battery-powered operation or a persistent wireless pairing. No Wi-Fi setup is needed. Bluetooth sessions expire after three minutes; nothing records automatically. The Mac must permit Bluetooth access to the process running the relay.

## Build

Build the source from a path without spaces using ESP-IDF v5.4.2. The settings in `sdkconfig.bench-confirmed` describe this specific bench; change them only to match verified physical wiring. GPIO defaults are disabled without this explicit overlay.

```sh
idf.py -C /absolute/no-space/firmware/diagnostics/microphone \
  -B /absolute/no-space/firmware/diagnostics/microphone/build-ble \
  -D SDKCONFIG=/absolute/no-space/mic-ble.sdkconfig \
  -D SDKCONFIG_DEFAULTS='/absolute/no-space/firmware/sdkconfig.esp32s3-n16r8-uart;/absolute/no-space/firmware/diagnostics/microphone/sdkconfig.defaults;/absolute/no-space/firmware/diagnostics/microphone/sdkconfig.bench-confirmed;/absolute/no-space/firmware/diagnostics/microphone/sdkconfig.bluetooth' \
  build
```

The bench retains a 1 MiB factory app partition at `0x10000`. Verify the image fits and the partition table matches before any application-only update. The saved bench runtime contains the binaries, their hashes and the original private flash-region backup. Do not publish that backup or private configuration files.

For the confirmed handover speaker wiring, append `sdkconfig.speaker-handover` after `sdkconfig.bluetooth` in `SDKCONFIG_DEFAULTS`, and use a fresh SDKCONFIG file so existing settings do not override the overlay. It sets amplifier enable to `-1` and initializes a separate I²S TX channel on GPIO 7/15/16. The board remains silent until an authenticated playback request arrives.

## Transport checks

`tools/esp32_ble_relay.py` uses Bleak, pyserial and cryptography. A fresh 256-bit key is generated on the board and handed over the physical USB link. BLE commands and audio use AES-GCM with separate nonce namespaces and counters. Requests must advance the counter. The helper checks both tampered-request and replay rejection, then verifies the complete microphone WAV with SHA-256. Audio notifications use a separate characteristic from command responses, which avoids macOS read/notification ambiguity.

With the speaker overlay, `--reply-wav /path/to/reply.wav` transfers a speech WAV back after microphone capture, verifies its hash and format, and waits for speaker playback to finish. For a speaker-only check without recording, use:

```sh
python tools/esp32_ble_speaker.py --port YOUR_ESP32_PORT \
  --input /path/to/reply.wav --report /path/to/playback-report.json
```

Audio must be a canonical 44-byte-header, 16 kHz mono PCM16 WAV, between 0.3 and 20 seconds. Incoming chunks must be contiguous; the complete file must match its declared SHA-256 before playback is queued. I²S writes run outside the Bluetooth callback, place PCM16 in the upper half of both 32-bit output slots, and reduce peaks above 8000/32767 without increasing quieter recordings. Recording is blocked while receiving or playing a reply. Session expiry aborts playback. Command 9 reports speaker capability, state and driver error separately from transfer success. A successful driver report still needs a human listening check to establish audibility.

The 11 October speech test verified encrypted delivery and driver completion, but the user reported buzzing/distortion with 16-bit output slots at both the original and one-quarter amplitude. The subsequent 32-bit-slot playback also passed the digital checks and still sounded distorted. Clear speech is not yet verified; the laptop audio player remains the everyday output. The measured 203,244-byte return transfer and 6.35-second playback took approximately 69 seconds together, so the current acknowledged-write transport also needs throughput work before it can provide prompt spoken replies.

A temporary offline build then played the identical quiet WAV with Bluetooth disabled and no Wi-Fi initialization. The driver completed in 6,509 ms, including 160 ms of padding, with no brownout report; the user still heard buzzing/distortion. The original WAV was subsequently played on the laptop and the user confirmed clear speech. Active Bluetooth and the source recording therefore do not explain the distortion. The exact cause in the ESP32-to-speaker path remains unconfirmed. The next physical check is the ESP32-to-breadboard common ground, including any split rail sections. Bluetooth firmware and the paired laptop relay were restored after this comparison.

Testing was then paused at the user's request and the idle laptop relay stopped. The Bluetooth firmware remains installed; no recording or playback starts automatically. See the [11 October session handover](../../../docs/careloop/ESP32-Voice-Handover-2026-10-11.md) for the saved state and software checks.

The laptop relay's `--speaker-output esp32` option sends new Parse replies back automatically and preserves the dashboard audio player as a laptop copy. Failed or unsupported playback leaves the already-saved Parse response intact. The default remains laptop playback, including on boards with the speaker overlay, while clear speech remains unverified.

The same image accepts `record` over USB. `tools/esp32_bench.py record --port PORT --output clip.wav` retrieves a base64-framed WAV and checks its size/hash. The helper waits for board startup because opening this WCH serial port can reset the ESP32. The firmware yields between UART frames to avoid starving the idle task.

Omitting `sdkconfig.bluetooth` builds the earlier optional Wi-Fi probe instead. Its `net` command accepts private credentials over USB, uses certificate-verified HTTPS to check the public Parse page and private device route, and disconnects afterward. It stores credentials only in RAM. A successful public page request would prove reachability, not pairing with the hosted dashboard; the current hosted Sites app has no hardware token API or text-to-speech endpoint.
