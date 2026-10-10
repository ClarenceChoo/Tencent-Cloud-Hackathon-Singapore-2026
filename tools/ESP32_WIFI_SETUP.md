# ESP32 microphone → iPhone hotspot → Parse

Use the existing [Parse dashboard → Phone & voice](https://parse-shared-voice.iians0n.chatgpt.site/?view=voice). The ESP32 connects directly to Parse through a 2.4 GHz hotspot. After the one-time USB setup, the laptop relay can be closed; the dashboard also works in Safari on the iPhone.

This release targets the previously confirmed **ESP32-S3 N16R8** board and **INMP441** microphone: SCK → GPIO 4, WS → GPIO 5, SD → GPIO 6, L/R → GND, 3.3 V and common ground. The amplifier's known enable pin, GPIO 17, stays low. Spoken replies play from the dashboard; speaker playback on the ESP32 remains unverified. This Wi-Fi image replaces the earlier Bluetooth diagnostic image. Both source versions remain in the repository.

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

- **Hotspot unavailable:** keep the board powered. It reconnects to the saved network automatically. Keep the iPhone hotspot screen open and Maximise Compatibility enabled during connection.
- **Name or password changed:** open the Wi-Fi connection settings, reconnect USB and update the hotspot. An existing pairing is preserved when the connected board belongs to that room.
- **Upload interrupted:** the board retains the same clip in RAM for **Retry sending this clip**. It uses the same recording ID and chunk bytes so a lost acknowledgment does not create another recording. A power loss clears the unsent audio; record again after restarting. Pending command receipts survive restart so an old capture command is not performed twice.
- **Pairing expired or revoked:** perform the USB connection and code comparison again. The cloud rejects an expired/revoked device credential.
- **USB port unavailable:** close serial monitors and the relay. If the firmware installer cannot enter download mode, hold BOOT, tap RESET, release BOOT, and choose the port again. Firmware installation accepts ESP32-S3 with 16 MB flash and the expected simple factory layout; different or secured boards require their existing firmware workflow.
- **Wrong board connected:** leave it alone. Software tests and web preview never require selecting, resetting or flashing a board. Select the intended microphone board only when ready to install.

## Development and release

The direct mode is enabled by `firmware/sdkconfig.parse-wifi-esp32s3-n16r8`; the legacy application remains the default without that overlay. Build with ESP-IDF v5.4.2 from a path without spaces. Combine the firmware defaults, `sdkconfig.esp32s3-n16r8-uart`, and the dedicated Wi-Fi overlay. The release uses `partitions.esp32s3-n16r8.csv`: NVS at `0x9000`, PHY at `0xf000`, factory app at `0x10000` with a 2 MiB allocation.

Package an already-built image without opening any hardware:

```sh
python3 tools/package_esp32_wifi.py \
  --build-dir /absolute/no-space/build-parse-wifi \
  --site-dir /absolute/path/to/parse-shared-voice
```

The packager checks the target, pin settings and partition layout, then emits three credential-free binaries and a manifest with SHA-256 and MD5 hashes under `public/firmware/parse-wifi-1/`. The installer verifies downloads with SHA-256 and each flash write using the ROM stub's MD5 result. It never erases the whole flash or writes eFuses. The vendored Espressif installer and dependency licenses are recorded in `public/firmware/VENDOR.md`.

Cloud implementation and isolated checks live in the shared Site source and public companion bridge. The device API lives under `/api/voice/device`; it uses an independently generated device bearer credential bound to one room. Phone cookies and owner dashboard sessions keep their existing roles. Tests use synthetic providers and temporary local databases. A physical hotspot, microphone and browser USB smoke test remains necessary on the intended board before calling the hardware verified.
