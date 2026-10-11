# ESP32 microphone → iPhone hotspot → Parse

Use the existing [Parse dashboard → Phone & voice](https://parse-shared-voice.iians0n.chatgpt.site/?view=voice). Direct Wi-Fi mode is designed to connect the ESP32 to Parse through a 2.4 GHz hotspot. After successful setup, the laptop relay can be closed; the dashboard also works in Safari on the iPhone.

**11 October bench status:** the USB setup handshake worked, but hotspot connection attempts repeatedly produced brownout resets. Direct Wi-Fi recording to Parse has not passed a physical end-to-end test. Testing is paused; Bluetooth firmware has been restored and the laptop relay stopped for the day. Continue with the [Bluetooth relay](ESP32_VOICE_RELAY.md) when testing resumes. The [session handover](../docs/careloop/ESP32-Voice-Handover-2026-10-11.md) records the remaining checks.

This release targets the previously confirmed **ESP32-S3 N16R8** board and **INMP441** microphone: SCK → GPIO 4, WS → GPIO 5, SD → GPIO 6, L/R → GND, 3.3 V and common ground. The Wi-Fi profile holds the former amplifier-enable GPIO 17 low; that does not disable an amplifier whose SD/EN is wired directly to 3V3 as in the updated hardware handover. This image does not drive speaker audio. Spoken replies play from the dashboard. The Wi-Fi image replaces the Bluetooth diagnostic image. Both source versions remain in the repository.

## One-time setup

1. On the iPhone, open **Settings → Personal Hotspot**. Enable **Allow Others to Join** and **Maximise Compatibility**. Leave that screen open while connecting. The Wi-Fi network name is the iPhone's name under **Settings → General → About → Name**.
2. On a computer, open Parse in **Chrome or Edge**, sign in, then open **Phone & voice → Wi-Fi · iPhone hotspot**. Connect only the original microphone board by a USB data cable. Close any terminal serial monitor or laptop relay holding its port.
3. Expand **First time installing the firmware?** and confirm the board model. Choose the board and prepare its backup. Download the backup, confirm that it is saved, then choose **Install Parse Wi-Fi**. Keep USB connected until verification finishes. This step replaces the program and partition table, preserving the existing NVS region. The backup covers the affected first `0x210000` bytes and stays on the computer; it is never uploaded.
4. Choose **Choose ESP32 USB port**. The dashboard checks for Parse Wi-Fi firmware before sending credentials. Enter the exact hotspot name and password, then choose **Save hotspot & connect**. Credentials travel only to the selected USB device and are saved in its NVS; they are not sent to Parse or stored in browser storage. NVS is not encrypted in this development image.
5. Compare the dashboard's six-digit code with the code read from the connected board. Choose **Codes match — connect ESP32**. Wait for **Ready to record**. Pairing lasts 30 days and can be revoked in this dashboard.

After setup, the board only needs power and the hotspot. A USB power adapter or suitable power bank can replace the laptop. Opening Parse in iPhone Safari is sufficient for recording, listening and reviewing; Safari does not perform the USB installation step.

## Record and use dashboard tools

Choose **Record & send**, wait for the three-second countdown, then speak for six seconds. The microphone otherwise stays idle. The device uploads six short WAV segments to Parse. The waveform, spectrogram, transcript and response appear in the same voice workspace once received; this is a completed-clip spectrogram, not continuous live monitoring.

Parse transcribes the audio and sends the transcript through the existing intent and tool-calling pipeline. It can prepare a care note, support request or follow-up, retrieve permitted care information, or ask for missing details. A prepared care update still requires **Review** and explicit dashboard confirmation to save. A connection or upload retry does not bypass that review.

The cloud can also synthesize Parse's response for the dashboard's audio player. A speech-service failure does not discard the transcript or prepared proposal. End-to-end timing depends on mobile connectivity and provider response time; it is not a hard real-time stream.

## Recovery

### Optional held talk button

The 10 October hardware handover uses **GPIO 18**, and its button check was not
repeated on 11 October. The GPIO 8 overlay below is an earlier, untested proposal
for a different jumper arrangement, not the handover wiring. For the handover
arrangement, configure `CONFIG_CARELOOP_PTT_GPIO=18` instead. Physical button
testing was deferred; the documented behavior below has software-test coverage.

The dashboard installer image leaves the physical button disabled. For the bench
build with `firmware/sdkconfig.parse-wifi-jumper` applied after the Wi-Fi profile,
connect a normally open button between **GPIO 8 (IO8)** and **GND**. Two loose
jumper ends can simulate it: one wire goes to IO8 and the other to ground. Touch
only those two free ends together while speaking, then separate them to send.
Never use 3V3, 5V, or the eighth header position in place of the GPIO 8 label.

The input uses an internal pull-up and a 40 ms press debounce. Keep it held for
at least one second; recording stops on release or at 20 seconds, then uploads
through the existing Parse pairing. The first 200 ms of microphone startup is
discarded, and only the INMP441 left channel is recorded. A retained unsent clip
must be retried from the dashboard before another capture. Dashboard recording
continues to work with this build. USB `wifi_status` includes the configured
`pttGpio`, current `talkPressed`, `wifiConnected`, and connected signal strength.

### Connection and upload recovery

- **Hotspot unavailable:** keep the board powered. It reconnects to the saved network automatically. Keep the iPhone hotspot screen open and Maximise Compatibility enabled during connection.
- **Name or password changed:** open the Wi-Fi connection settings, reconnect USB and update the hotspot. An existing pairing is preserved when the connected board belongs to that room.
- **Upload interrupted:** the board retains the same clip in RAM for **Retry sending this clip**. It uses the same recording ID and chunk bytes so a lost acknowledgment does not create another recording. A power loss clears the unsent audio; record again after restarting. Pending command receipts survive restart so an old capture command is not performed twice.
- **Pairing expired or revoked:** perform the USB connection and code comparison again. The cloud rejects an expired/revoked device credential.
- **USB port unavailable:** close serial monitors and the relay. If the firmware installer cannot enter download mode, hold BOOT, tap RESET, release BOOT, and choose the port again. Firmware installation accepts ESP32-S3 with 16 MB flash and the expected simple factory layout; different or secured boards require their existing firmware workflow.
- **Wrong board connected:** leave it alone. Software tests and web preview never require selecting, resetting or flashing a board. Select the intended microphone board only when ready to install.

## Development and release

The direct mode is enabled by `firmware/sdkconfig.parse-wifi-esp32s3-n16r8`; the legacy application remains the default without that overlay. Build with ESP-IDF v5.4.2 from a path without spaces. Combine the firmware defaults, `sdkconfig.esp32s3-n16r8-uart`, and the dedicated Wi-Fi overlay. The release uses `partitions.esp32s3-n16r8.csv`: NVS at `0x9000`, PHY at `0xf000`, factory app at `0x10000` with a 2 MiB allocation.

The 11 October serial-command and held-capture fixes are saved as source changes.
The hosted installer binaries have not been repackaged or republished with those fixes.

Package an already-built image without opening any hardware:

```sh
python3 tools/package_esp32_wifi.py \
  --build-dir /absolute/no-space/build-parse-wifi \
  --site-dir /absolute/path/to/parse-shared-voice
```

The packager checks the target, pin settings and partition layout, then emits three credential-free binaries and a manifest with SHA-256 and MD5 hashes under `public/firmware/parse-wifi-1/`. The installer verifies downloads with SHA-256 and each flash write using the ROM stub's MD5 result. It never erases the whole flash or writes eFuses. The vendored Espressif installer and dependency licenses are recorded in `public/firmware/VENDOR.md`.

Cloud implementation and isolated checks live in the shared Site source and public companion bridge. The device API lives under `/api/voice/device`; it uses an independently generated device bearer credential bound to one room. Phone cookies and owner dashboard sessions keep their existing roles. Tests use synthetic providers and temporary local databases. A physical hotspot, microphone and browser USB smoke test remains necessary on the intended board before calling the hardware verified.
