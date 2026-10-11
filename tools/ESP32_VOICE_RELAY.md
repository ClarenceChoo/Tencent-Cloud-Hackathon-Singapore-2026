# One Parse dashboard

Use **[Parse → Phone & voice](https://parse-shared-voice.iians0n.chatgpt.site/?view=voice)**
for the ESP32 recording button, spectrogram, waveform, recording playback,
transcript, spoken reply, and review of proposed care updates. The phone's QR
companion remains available for phone recording; it is not another dashboard.

The laptop runs a small background relay because it owns the Bluetooth connection.
Install the backend dependencies with `uv sync --frozen --extra test` from `backend/`, then install the relay dependencies from the repository root:

```sh
uv pip install --python backend/.venv/bin/python -r tools/esp32-requirements.txt
```

FFmpeg must be on `PATH` for spoken replies. Set the approved OpenAI key in the ignored `backend/.env` file using the blank fields in `backend/.env.example`. The hosted service handles transcription and intent; the local key is used to synthesize the reply.

From the repository root, start the relay when the original microphone board is ready:

```sh
backend/.venv/bin/python tools/esp32_audio_dashboard.py --transport bluetooth --serial-port YOUR_ESP32_PORT --serial-python backend/.venv/bin/python
```

Use the actual port for that ESP32 if it changes. Do not select another board's
port. USB supplies power and a fresh Bluetooth session key; audio transfers over
Bluetooth. No ESP32 Wi-Fi configuration is required. Leave the process running;
its local page can remain closed. This command does not record on startup.

Pairing is approved for 24 hours:

1. Open **Phone & voice** in Parse and choose **Connect ESP32**.
2. Choose **Connect this laptop** to open the local pairing helper once.
3. Compare the six-digit code on both pages and approve it on Parse.
4. Return to Parse. When the laptop and ESP32 are ready, choose **Record & send**.
5. Speak after the three-second countdown. Capture stops after six seconds.
6. Inspect the signal and transcript, play the reply, and review any care proposal.

The spectrogram appears after the completed clip transfers. Its levels use the
original PCM; the waveform scales its amplitude for visibility. A prepared care
proposal still requires explicit confirmation before saving.

For the speaker wiring in the 10 October hardware handover, build the microphone
Bluetooth firmware with `sdkconfig.speaker-handover`, then add
`--speaker-output esp32` to the relay command. Each new spoken reply goes back over
Bluetooth and plays through the MAX98357A. The microphone stays idle during
playback. The browser audio player remains a laptop copy. A speaker failure is
reported separately and does not resend the recording or repeat a care action.
This bench playback supports canonical 16 kHz mono PCM16 WAV clips up to 20 seconds;
longer replies remain available in the dashboard player. Without the flag, replies
are available through that player as before.

**11 October bench status:** tones were audible, but returned speech was distorted,
including with Bluetooth disabled. The same source speech was clear on the laptop.
Keep laptop playback as the default while that fault remains unresolved. A 6.35-second
reply took about 69 seconds to transfer and play on the ESP32. Testing is paused and
the local relay has been stopped; see the [session handover](../docs/careloop/ESP32-Voice-Handover-2026-10-11.md)
for the saved state and the next checks when testing resumes.

## Connection and retry behavior

The relay polls outward to Parse; the hosted page does not need direct access to
localhost. It reports a heartbeat, and the Record button stays disabled when that
heartbeat is stale or the configured USB port is absent. Pairing alone does not
mean the relay is online.

A dashboard click creates a 20-second request. The laptop claims it once and
writes a private receipt before starting the microphone. Lost responses and
restarts cannot repeat an already-started capture. An interrupted request needs
a fresh click. Only one request per connection may be active.

**Retry sending this clip** resends the existing recording, with its original ID,
and reuses the cached transcription/interpretation. It does not record again.
The relay stores the upload receipts and pairing cookie inside the ignored runtime
folder. The cloud service token stays on the hosted bridge. Neither service
credentials nor OpenAI keys go to the ESP32 or the browser. Disconnecting in Parse
revokes the relay's access.

The optional local diagnostics/setup page is `http://127.0.0.1:8768/`. It is no
longer needed for everyday recording. There is no startup service installation;
close the relay process to take it offline.

INMP441 wiring: SCK=GPIO4, WS=GPIO5, SD=GPIO6, L/R=GND.

MAX98357A handover wiring: BCLK=GPIO7, LRC/WS=GPIO15, DIN=GPIO16,
SD/EN=3V3, VIN=3V3, with a common ESP32 ground. Speaker leads go to the
amplifier's two output terminals.

## Software-only verification

```sh
backend/.venv/bin/python -m unittest discover -s tools -p 'test_parse_*py'
backend/.venv/bin/python -m unittest discover -s tools -p 'test_esp32_*py'
cd sites/parse-shared-voice
node scripts/verify-esp32-relay.mjs
node scripts/verify-microphone-analysis.mjs
```

These checks use isolated storage, generated tones, and mocked provider calls.
They cover pairing, owner access, stale heartbeats, command expiry/claims,
restart safety, reply playback authorization, upload retries, proposal review,
and calibrated audio analysis. They do not access a board.
