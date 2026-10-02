# Developer checks

These tools exercise implementation contracts with fictional data. Parse has an ESP32 cardholder and a native phone companion under `mobile/`, using the same backend and care records. See the [phone setup guide](../docs/careloop/Phone-Companion-Setup.md) and [verification ledger](../docs/careloop/Phone-Companion-Verification.md) for the platform evidence and remaining acceptance work. Developer fixtures do not establish physical hardware or live speech behavior.

## Software demo

After installing backend and frontend dependencies, run `python3 tools/run_demo.py` from the repository root. This macOS/Linux launcher starts the dashboard at `http://127.0.0.1:5173`, with the backend on port 8001. Both bind only to loopback. Choose alternate ports with `--web-port` and `--api-port`; an occupied port is reported without stopping its existing service.

The launcher uses a separate, persistent fictional database under `runtime/software-demo/`, explicitly disables live providers, and saves one-time seed device credentials to a private file rather than printing them. Ctrl+C stops its service processes and keeps the demo records. This is the software-first workflow; it does not require a cardholder, Docker or cloud account. Use the separate provider/deployment setup when ready to test live voice.

## Resumable WAV transport

`device_harness.py` uses Python's standard library. Export `CARELOOP_DEVICE_TOKEN` securely in your terminal environment, then upload a deliberate 0.3–20 second mono 16-bit PCM WAV at 16 kHz:

```sh
python3 tools/device_harness.py \
  --base-url https://your-backend.example \
  --wav /path/to/fictional-note.wav \
  --state runtime/note-turn.json
```

The tool saves the idempotency key before uploading. Re-run with the **same state file, recording and context** after a lost connection. Once accepted, it polls the turn instead of uploading again. It downloads validated reply assets in order to `runtime/replies/` and prints the server's read-back and confirmation context. Listening or transport acknowledgement does not confirm a care record.

A recovered record outcome remains visible even when its audio has expired or cannot be downloaded. The result separates `status` (such as `committed`) from `reply_status` (`downloaded`, `expired` or `unavailable`), and omits a usable confirmation context when the reply cannot be reviewed. Replies are bounded to 20 clips and 120 seconds total; the tool never follows a redirect with a device credential.

For a separate deliberate confirmation recording, use a **new state file** and the returned context:

```sh
python3 tools/device_harness.py \
  --base-url https://your-backend.example \
  --wav /path/to/yes-save-that.wav \
  --state runtime/confirmation-turn.json \
  --context-id context-returned-by-server
```

The backend must have live providers configured, or an explicit in-process fixture registration in a developer test. An arbitrary WAV is never transcribed by the fixture adapter. This tool cannot create a device or bypass the owner claim. Certificate verification and redirect rejection are always enabled; `--allow-insecure-loopback` permits HTTP only for localhost/loopback tests.

Run its isolated transport checks with Python 3.11 or later:

```sh
python3 -m unittest discover -s tools -p 'test_device_harness.py' -v
```

These tests start a temporary loopback HTTP server using fictional tokens/audio. They cover lost upload acknowledgement, retry identity, resumed polling, expired/unavailable speech, redirect rejection and response limits. They do not call a cloud speech provider or replace the cardholder acceptance tests.

## Real browser scenario

Start the backend against a fresh, explicitly seeded fictional database and run the frontend with `VITE_DEMO_MODE=true`, as described in the repository README. Use Chrome installed locally, then from the repository root:

```sh
npm ci --prefix tools
node tools/browser_smoke.cjs
```

The runner is restricted to a loopback origin. It signs in with fictional seed credentials, creates actual proposals and records through the UI, checks read-back corrections, medication reports, preventive transitions, cross-client refresh, summary sharing/revocation and mobile layout. Output and screenshots go under ignored `runtime/`. It does not exercise live AI, speech intelligibility or hardware.

Optional environment: `CARELOOP_TEST_ORIGIN`, `CARELOOP_BROWSER_EXECUTABLE`, or `PLAYWRIGHT_MODULE` to reuse an installed Playwright runtime. Avoid sharing browser output if you replace fictional data with private content.

After the main scenario, `node tools/browser_settings.cjs` checks saved profile preferences, a pending proposal created by another client, and a reviewed medication-plan revision. It restores profile preferences but leaves the fictional care records and revised plan in the local test database.

To include device claim/revocation, provision a fresh fictional device with the backend admin CLI against that same local database. Save the command's output in a private file under `runtime/` and set `CARELOOP_TEST_DEVICE_FILE` to its path. The runner reads the one-time code and credential without printing them. It verifies authenticated API access before and after dashboard revocation and leaves the test device revoked. This verifies access control only; it does not simulate microphone, speaker, battery or physical Wi-Fi behavior.

`node tools/browser_latency.cjs` measures 30 confirmed fictional-note updates in the already-open dashboard. It records each confirmation-request-start to visible-entry duration, p50, p95 and maximum under `runtime/dashboard-latency.json`, and fails if the local p95 exceeds two seconds. This conservative local baseline includes request/commit time; it does not verify a real phone, cloud deployment or demo network. The same optional browser environment settings apply.

## Browser care-workflow verification

The combined browser runner covers recording receipts and lost responses, guided first use, caregiver Attention, all four capture purposes and typed corrections, reviewed vocabulary conflicts, source-linked questions, summary purposes and printing, permission changes, and responsive layouts. It uses real Chromium, MediaRecorder, upload decoding and same-origin backend transactions with fictional records. Speech recognition/interpretation are scripted, microphone input is synthetic, and replies are tones.

Build the ordinary frontend first. In separate terminals, use a **new** disposable directory for each run:

```sh
npm --prefix frontend run build
backend/.venv/bin/python tools/web_companion_fixture.py --data-dir runtime/web-workflow-check --port 5192
PARSE_WEB_FIXTURE_DIR=runtime/web-workflow-check node tools/browser_web_companion.cjs
```

The fixture snapshots the compiled frontend at startup so later builds cannot change a running check. It also creates a second empty care space for patient-switch checks. The runner saves the parent Git revision, tested source and served-build hashes, credential-free checks, fictional screenshots and a multi-page sample PDF. It deliberately revokes caregiver access and browser pairing at the end. Private fixture metadata, databases, cookies and audio stay in ignored `runtime/`; share only inspected, credential-free evidence. Stop the fixture after checking. These observations do not establish live speech accuracy, physical-phone behavior or background alerts.

## Inert public UI preview

Keep the preview build separate from the ordinary production build:

```sh
VITE_UI_PREVIEW=true npm --prefix frontend run build -- --outDir ../runtime/parse-workflow-preview
npm --prefix frontend run preview -- --outDir ../runtime/parse-workflow-preview --port 5194 --strictPort
PARSE_PREVIEW_BUILD_DIR=runtime/parse-workflow-preview PARSE_PREVIEW_ORIGIN=http://127.0.0.1:5194 PARSE_PREVIEW_DIR=runtime/preview-check node tools/browser_workflow_preview.cjs
```

The preview runner checks landing navigation, fictional care views and source controls, blocked writes, summary controls, the inert companion, narrow layouts and enlarged text. It checks that no `/v1` request, microphone call, print dialog or care-data persistence occurs. The preview is for interface exploration; it supplies no device, account, saved update or token-backed shared record.

## Native Android sequence checks

`android_native_sequence.py` exercises the installed verification package on the dedicated rooted Android emulator. It requires the existing fictional native TLS fixture and its loopback fault proxy; it refuses other packages, origins and an unexpected APK digest. See [the native build guide](../docs/careloop/Phone-Companion-Native-Build.md#native-android-reply-order-and-expiry) for the recorded setup and evidence.

An optional fixture-only `sequence-tone.json` forces the production speech splitter to generate distinct PCM tones. The runner observes protected clip downloads, native playback state and cache hashes, then stalls a freshness request across a shortened reply deadline. It restores the proxy configuration and direct fixture connection in `finally`, and checks that care records, proposals, voice turns, uploads and routing are unchanged. This verifies emulator media behavior, not speech intelligibility or physical audibility. Use a unique `--run-suffix` to retain a second run without overwriting earlier evidence.

## Hardware pairing checks

For a deployed, already-claimed device, run `backend/.venv/bin/python tools/check_hardware_ready.py --base-url https://YOUR-DOMAIN --nvs-file /PRIVATE/device-nvs.csv --require-voice-config`. It checks HTTPS, the bound identity, audio protocol, pending commands and WSS heartbeat acknowledgement. It never uploads audio, creates a care record or prints the credential. Its own temporary heartbeat does update connection status; it is not proof that a physical pendant is connected. `--token-env` is also supported. `--allow-insecure-loopback` permits local HTTP only for explicit tests. Redirects are refused on HTTP and WebSocket connections.

To reproduce the actual browser pairing journey, use a **new** directory under ignored `runtime/`, with backend dependencies installed, `npm ci --prefix frontend`, `npm ci --prefix tools`, and Chrome available. In separate terminals from the repository root:

```sh
backend/.venv/bin/python tools/pairing_fixture_server.py --data-dir runtime/pairing-check
CARELOOP_API_TARGET=http://127.0.0.1:8002 npm --prefix frontend run dev -- --port 5174 --strictPort
CARELOOP_PAIRING_FIXTURE_DIR=runtime/pairing-check node tools/browser_pairing.cjs
```

The server binds only loopback and refuses an existing data directory. The scenario uses synthetic WAVs explicitly registered with the fixture adapter: it does not recognize or synthesize live speech. It checks invalid/valid codes, paired vs online state, a real WebSocket heartbeat, confirmation before saving, exactly-once retry, the permitted caregiver's automatic refresh, read-only device controls, four responsive widths, disconnect and revocation. Private setup files and fictional screenshots stay in the selected directory; only credential-free evidence should be shared. Stop both test servers after the run. A fresh run requires a fresh directory because the test deliberately revokes its device.

`backend/.venv/bin/python -m unittest discover -s tools -p 'test_hardware_ready.py' -v` checks the diagnostic client against a disposable loopback server, including credential rejection, redirect handling and response bounds. It requires permission to bind a local port.
