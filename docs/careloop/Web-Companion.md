# Parse web companion

Parse's browser companion links an older adult's voice interactions to the existing caregiver dashboard. It runs at `/companion`, shares the care backend, and requires no native installation. The native app remains available separately.

## Product flow

Open `/companion` on the same HTTPS service as the dashboard. Choose **Connect this browser**, then ask the owner to approve its one-use code in dashboard Settings. The companion is a separate, patient-scoped installation; its pairing does not sign the user into the administrative dashboard.

Tap to record, speak, and tap to send. Parse uses the existing transcription, interpretation and confirmation pipeline. A proposed update is shown with its read-back and recipient before it can be saved. The user can correct or cancel it. A confirmed, shared update appears in the permitted caregiver's existing timeline. Medicines, reported readings, preventive tasks and support/follow-up details come from the same care database.

The microphone is used only after a deliberate tap and stops when the page is left. Short accidental clips are discarded; the recording control has a 19-second ceiling. Voice replies use authenticated, expiring audio. A browser may require the user to tap Play before allowing sound.

## Browser boundaries

This version supports use while the companion page is open. It does not promise medication alerts or audio while the browser is closed, suspended or locked. Keep the page open for in-page reminders. Background push, offline recordings and physical mobile-browser acceptance remain separate work.

Microphone access requires permission and a secure context: HTTPS in deployment, or a browser-recognized localhost origin for development. Only the companion document enables microphone access in the supplied Caddy policy; the caregiver dashboard still denies it. See [MDN's microphone permission and secure-context documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

Recording format is chosen from supported browser formats. The browser checks support before starting; the server normalizes bounded AAC/M4A or Opus/WebM to the same canonical WAV used by the native companion. This includes streaming WebM without container-duration metadata. See [MediaRecorder format detection](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static).

## Connection and data

The web adapter under `/v1/web` keeps its installation credential in an HttpOnly, SameSite=Strict cookie. It checks origin and CSRF for mutations and forwards only an allowlisted set of operations to the existing phone/device handlers. It does not exchange the installation credential for an owner session. JavaScript storage is limited to recovery and playback identifiers; captured audio and care text are not persisted there.

The owner can revoke the browser from the dashboard. The companion clears patient content when access is denied. Disconnecting stops capture/playback and completes the applicable reminder cleanup before removing the installation. Clearing browser cookies may lose the pairing; it does not itself revoke server access.

## Local UI checks and demo

The local recording fixture is deliberately separate from deployment. It binds only to loopback, creates a new fictional database, and accepts a private, explicitly armed scenario file. Actual browser MediaRecorder bytes pass through the production decoder and care pipeline, but transcription/interpretation are scripted and replies are tones. This verifies browser interaction and record propagation; it does not verify live speech recognition, clinical effectiveness or a physical microphone.

Build the frontend, then start the fixture in a new directory:

```sh
npm --prefix frontend run build
backend/.venv/bin/python tools/web_companion_fixture.py \
  --data-dir runtime/web-companion --port 5190
```

In a second terminal, run the browser checks against that fixture:

```sh
PARSE_WEB_FIXTURE_DIR=runtime/web-companion \
  node tools/browser_web_companion.cjs
```

The runner uses Playwright and Google Chrome. Install the locked tools dependency with `npm ci --prefix tools`, or set `PLAYWRIGHT_MODULE` to an available Playwright module. Reports and recordings remain under ignored `runtime/`; only reviewed, credential-free evidence belongs in source control. Each run needs a fresh fixture because it ends by revoking the browser.

Live use still requires the existing server's speech-provider configuration and a reachable HTTPS address. The supplied local demo never represents its scripted provider as live speech.

## Verified on 29 September 2026

- Backend: 148 tests passed on SQLite and on an isolated PostgreSQL database.
- Frontend: 35 tests passed; production build passed.
- Chrome: 13 browser checks passed with four real MediaRecorder uploads using synthetic microphone input. They cover owner approval, cookie/CSRF boundaries, recording cancellation, authenticated playback, expiry, correction and confirmation, caregiver updates, medication reports, support acknowledgement, private notes, reload, responsive layouts, denied microphone permission and revocation. No browser page errors were recorded.
- The confirmed note appeared in the already-open caregiver timeline without a manual refresh. This is a local functional observation, not a production latency benchmark.
- Layout checks passed at 320, 390, 768 and 1440 pixels. Mobile and caregiver screenshots were visually reviewed. Safari, physical-phone audio and closed-browser delivery were not tested by this web run.

See the [browser evidence](evidence/web-companion-ui-2026-09-29.json), [mobile screenshot](evidence/web-companion-mobile-2026-09-29.png), and [caregiver screenshot](evidence/web-companion-caregiver-2026-09-29.png). Source and served-build hashes are included in the evidence.
