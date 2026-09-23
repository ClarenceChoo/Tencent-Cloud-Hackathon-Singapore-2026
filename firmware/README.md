# CareLoop ESP32-S3 firmware

This is the ESP-IDF firmware for the rear electronics module of the CareLoop cardholder. It captures deliberate push-to-talk audio, sends a complete WAV turn to the CareLoop backend, receives authenticated WSS events, and plays approved WAV replies/reminders. It contains no local speech recognition, medical reasoning, or treatment logic.

## Version and reproducibility

The project pins **ESP-IDF v5.4.2** and `espressif/esp_websocket_client` **1.4.0** in [idf_component.yml](idf_component.yml). Espressif lists v5.4.2 as a stable ESP32-S3 release in its [official getting-started guide](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/get-started/). Its factory-only partition table needs roughly 1.7 MiB for the application and therefore requires a board with at least 2 MiB flash; production flash capacity still requires supplier confirmation. Use a checkout/tag exactly matching `v5.4.2`, install its ESP32-S3 tools, source `export.sh`, then:

```sh
cd firmware
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/cu.usbmodemXXXX flash monitor
```

The component manager downloads the pinned WebSocket dependency on the first build. This repository deliberately contains no Wi-Fi password, backend address, device token, certificate override, or fixed GPIO map.

Run pure host logic tests without ESP-IDF:

```sh
make -C components/careloop_core/test test
```

## Before flashing hardware

The defaults set every supplier-dependent GPIO to `-1`. In that state the button, microphone, speaker, and haptic driver remain inert. They also do not assume a PSRAM type or CPU frequency. Copy [sdkconfig.careloop.example](sdkconfig.careloop.example) privately and configure actual values through `idf.py menuconfig` only after the supplier signs off the board revision, PSRAM arrangement, power diagram, INMP441 left/right selection, MAX98357A wiring, button polarity, and motor-driver polarity. Do not copy a pin map from another ESP32-S3 board.

The microphone is 16 kHz signed PCM input read in 32-bit I²S slots. INMP441's signed 24-bit left-aligned sample is arithmetic-shifted to signed 16-bit PCM before the WAV is formed. Capture writes a standard 44-byte RIFF/WAV header and permits 0.3–20 seconds. A full 20-second capture is allocated only from external PSRAM; if PSRAM is absent or not enabled for the delivered board, capture fails loudly rather than exhausting normal application heap. The amplifier is forced off during capture; it is enabled only for playback. A physical press during playback stops it.

While an accepted turn is still processing, a new press produces three short haptic pulses and waits for release. This prevents overwriting the outstanding turn without incorrectly saying that its recording was not received.

## Setup and secrets

On a device with no saved Wi-Fi/backend configuration, the firmware starts a WPA2 SoftAP named `CareLoop-XXXX` for ten minutes and exposes a small local form at `http://192.168.4.1/`. Its per-device setup password is generated once in NVS. Put this password on the physical device label during manufacturing or provision it over the trusted USB/recovery workflow; it is intentionally never written to the serial log.

The setup page accepts Wi-Fi details and an `https://` backend hostname (for example `https://care.example`, with no path). Device credentials are a separate, revocable backend token and must be provisioned through a trusted USB flow, not committed here. Create an NVS CSV outside this repository, generate a NVS partition with the matching ESP-IDF `nvs_partition_gen.py` tool, and write the `nvs` partition using the matching `parttool.py`. Required namespace/keys are:

| namespace | key | type |
|---|---|---|
| `careloop` | `ssid`, `pass`, `backend`, `setup_pw` | string |
| `careloop` | `token` | string |

The firmware refuses audio uploads/WSS when the token is absent. It uses Espressif's certificate bundle for HTTPS and WSS and never enables certificate or hostname verification bypasses. Synchronised time is required before reminder expiry is trusted.

## Backend device contract expected

`POST /v1/device/turns` receives `audio/wav` with `Authorization: Bearer`, a UUID `Idempotency-Key`, and optional `X-Context-Id`. Every retry for one capture reuses the UUID. The implementation accepts a `turn_id` response and awaits a WSS `turn.result` with `payload.context_id`. A response can carry `payload.audio_paths`: an ordered array of 1–20 relative `/v1/device/audio/...` WAV assets, each no longer than 20 seconds, with a total sequence no longer than 120 seconds. Firmware validates every path, keeps the microphone disabled through the full sequence, and treats a button press as interruption of the entire sequence. It retains `audio_path` as the first-asset fallback for compatible servers. It also polls `GET /v1/device/turns/{turn_id}` after an accepted upload. The implemented response is `{turn_id,status,received_at,event,error}`, where `event` is the same complete `turn.result` envelope or null. This lets a lost socket recover the durable result without creating another care record.

For safe reminder playback, `GET /v1/device/pending-commands` must return `current_plan_version` and an array `commands` of the documented full `reminder.play` event envelopes. The firmware refuses reminder playback until a current plan version is known and matches the command. Before playback it persists a small NVS command ledger; redelivered commands are suppressed after reboot. Interrupted/unknown reminders are never automatically replayed. The same endpoint may return `checkins` with full nonclinical `checkin.play` envelopes. Check-ins use the same bounded sequential WAV playback and acknowledgement stages, preserve their `context_id` for a later deliberate turn, and are never marked complete after interruption or failed audio. Relative audio paths are allowlisted to `/v1/device/audio/`; server text cannot redirect a device to another host.

The device sends WSS heartbeats every five seconds and uses the configured base URL only. HTTPS redirects are disabled so the bearer token is never forwarded to another host. HTTP reconciliation bodies and each WSS JSON event are bounded at 16 KiB; fragmented WSS events are reassembled by the component-provided offset before parsing, and overflow fails closed. It retains a capture in RAM while it retries (1, 2, 4, 8 seconds plus bounded jitter); it neither writes voice clips to flash nor creates a new idempotency key on retry. Reviewed fixed local WAV prompts for disconnected, not-sent, receipt-unconfirmed, and low-battery states are embedded in the firmware. They still require playback/acoustic verification on the delivered board.

## Recovery and bench boundary

For normal recovery, enter the supplier-documented ESP32-S3 bootloader (often by holding BOOT while resetting), then run the matching `idf.py -p PORT flash monitor` command above. Preserve the USB data port and the supplier's documented boot/reset procedure in the enclosure design. `idf.py -p PORT erase-flash` removes Wi-Fi, device credentials, and the replay ledger; it is a deliberate factory-reset/recovery action and must be followed by reprovisioning.

ESP-IDF v5.4.2 compiled this project for `esp32s3` on 23 September 2026. The resulting factory image is 0x19a350 bytes, with 0x5cb0 bytes free (1%) in the 0x1a0000-byte factory partition. Its SHA-256 is `d99b441abead910c686a44d7475a29ffe4144e06094b6ca962d2ba69a3e61c5b`. Host tests also pass for WAV validation/conversion, reply-array and single-path fallback selection, terminal-turn recovery status, context-expiry gating, retry/ledger protocol, and interaction-state logic.

Compilation and host tests establish source-level behavior only. This firmware has not been flashed or tested on a cardholder in this workspace. Acoustic intelligibility, motor noise, pin electrical safety, Wi-Fi/card interference, charging, brownouts, and end-to-end physical acceptance require the delivered board and the bench sequence in the integration document.
