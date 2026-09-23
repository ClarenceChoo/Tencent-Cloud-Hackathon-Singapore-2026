# Developer checks

These tools exercise implementation contracts with fictional data. The product voice client remains the ESP32 cardholder.

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
