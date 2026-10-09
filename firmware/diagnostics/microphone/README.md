# ESP32 microphone and laptop relay bench

This diagnostic captures the **INMP441 on the ESP32**, never the laptop microphone. It records exactly six seconds after a three-second countdown and otherwise leaves capture idle. The confirmed board has 16 MB flash, 8 MB Octal PSRAM, and UART0 at 115200 through a WCH USB bridge.

The 9 October 2026 bench wiring is SCK → GPIO 4, WS → GPIO 5, SD → GPIO 6, and L/R → GND (left). Use 3.3 V and common ground for the microphone. The previously confirmed MAX98357A enable on GPIO 17 is held low. No speaker output is attempted by this microphone diagnostic.

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

## Transport checks

`tools/esp32_ble_relay.py` uses Bleak, pyserial and cryptography. A fresh 256-bit key is generated on the board and handed over the physical USB link. BLE commands and audio use AES-GCM with separate nonce namespaces and counters. Requests must advance the counter. The helper checks both tampered-request and replay rejection, then verifies the complete microphone WAV with SHA-256. Audio notifications use a separate characteristic from command responses, which avoids macOS read/notification ambiguity.

`--reply-wav /path/to/reply.wav` also transfers a 16 kHz mono WAV back to ESP32 memory and asks the board to verify its hash and format. It does not play the speaker. This optional path is separate from laptop text-to-speech playback.

The same image accepts `record` over USB. `tools/esp32_bench.py record --port PORT --output clip.wav` retrieves a base64-framed WAV and checks its size/hash. The helper waits for board startup because opening this WCH serial port can reset the ESP32. The firmware yields between UART frames to avoid starving the idle task.

Omitting `sdkconfig.bluetooth` builds the earlier optional Wi-Fi probe instead. Its `net` command accepts private credentials over USB, uses certificate-verified HTTPS to check the public Parse page and private device route, and disconnects afterward. It stores credentials only in RAM. A successful public page request would prove reachability, not pairing with the hosted dashboard; the current hosted Sites app has no hardware token API or text-to-speech endpoint.
