# CareLoop verification and remaining acceptance work

This document separates executable software evidence from target-device acceptance. The complete PRD definition of done has **not** been met. No physical device, live speech account, deployment domain, measured battery/acoustics or intended-user trial has been supplied for these checks.

## Recorded results — 23 September 2026, Singapore time

- Backend: **42 tests passed**, using SQLite and mocked provider calls.
- Dashboard: production build passed; **5 tests passed**, covering errors, date handling, confirmation and separation of scheduled doses from actual medication reports.
- Main browser scenario: **10 checks passed** against the running React/FastAPI application. One externally committed note appeared after **787 ms** in that local run. This is one observation, not the PRD's 30-event p95 latency result.
- Focused browser scenario: **4 checks passed** for profile preferences, a separately created pending proposal, checked medication-plan revision, and device claim/revocation. The last check used a fictional credential against the API, not a physical cardholder.
- Firmware: ESP-IDF **v5.4.2** successfully built the ESP32-S3 application, **1,496,032 bytes**; native core tests passed. Image SHA-256: `27ac66f5a39bdf6912c975e47a80575a28063f67105357395591a4196e3e1c04`.
- Desktop and mobile screenshots were inspected. Provider credentials, device credentials, local databases, screenshots and build products remain outside Git.

## Reproducible checks

| Check | Evidence / command | Scope |
|---|---|---|
| Backend behavior | `cd backend && uv sync --frozen --extra test && uv run pytest` | Auth/CSRF, access grants, private records, proposals, corrections, plan versions, summary provenance/revocation, device transport, scheduler and provider adapters |
| Dashboard build and UI tests | `cd frontend && npm ci && npm run build && npm test` | TypeScript/build and explicit confirmation UI safeguards |
| Real browser integration | `node tools/browser_smoke.cjs` after fictional seed and local servers | Actual React → HTTP → FastAPI → SQLite workflows; results under ignored `runtime/browser-evidence.json` |
| Settings and device access | `node tools/browser_settings.cjs` after the main browser scenario; see [tool instructions](../../tools/README.md) | Profile, pending proposal, checked plan edit and optional fictional credential claim/revoke; results under `runtime/browser-settings-evidence.json` |
| Firmware host tests | `make -C firmware/components/careloop_core/test test` | WAV format, sample conversion, protocol bounds, retry/ledger and reply-path helpers |
| Target compilation | ESP-IDF v5.4.2, ESP32-S3, pinned WebSocket component | Builds a binary; does not establish pin compatibility, microphone behavior or physical operation |
| Deployment configuration | YAML parsed; only the web service exposes host ports | Docker build/run and real public HTTPS/WSS remain unexecuted |

Provider tests use synthetic fixtures and mocked network responses. They do not prove access to Tencent services, language/accent accuracy, model interpretation accuracy, speech intelligibility or provider processing location. The browser check uses an explicit fictional database and no live AI. Firmware build details and the current image hash are in [firmware README](../../firmware/README.md).

## Requirement coverage and proof still needed

| PRD requirement | Implemented evidence | Target acceptance still needed |
|---|---|---|
| R01: device claim/revoke | Authenticated one-use claim, binding and revoke API tests | Claim a flashed device; verify revocation closes its actual socket |
| R02: deliberate recording | Firmware state/format helpers and ESP32 build; RX stopped outside capture | Measure cue latency; observe mic clocks/recording during idle/playback; test switch bounce, release and 20s cap |
| R03: confirmed health notes | Immutable proposals, revised read-back, idempotent commit; UI/API scenario | Spoken note, correction and confirmation on the cardholder |
| R04: checked plan | Versioned sourced plan, checked activation, old-command cancellation | Validate entered demo label and on-device response to a changed plan |
| R05: reminders | Durable scheduler/outbox, expiry/version gates, separate playback ACK | Connected idle playback within 10s; disconnect/reconnect and stale command trial |
| R06: medication reports | Named scheduled occurrence, explicit proposal/confirmation, separate report state | Live speech tests for two medicines, ambiguity, taken/skipped/not-yet/uncertain and silence |
| R07: medication explanations | Retrieves checked source text; bounded sequential speech assets | Live account/provider and audible explanation of reviewed demo content |
| R08: support/follow-up | Selected-recipient sharing/acknowledgement, explicit human outcome, private follow-ups, configured calling route | Voice request and later spoken acknowledgement/outcome without invented delivery claims |
| R09: dashboard | API session/permissions, quiet refresh, desktop/mobile workflows | Actual target phone/hotspot and p95 commit-to-display measurement across 30 events |
| R10: preventive care | Confirmed planned/due/arranged/completed/declined/discussion state changes | Complete the voice-led due → arranged → completed scenario |
| R11: failures/retention | Idempotent recovery, transient audio deletion, note/share revocation, local spoken prompt assets | Interrupt Wi-Fi/upload/response/power on the real device; listen to each failure prompt |
| R12: companion | Chosen name/language context and opt-in daily greeting scheduler | Intended-user assessment of language, intelligibility, button control and respectful phrasing |
| R17: reported measurements | External BP provenance, read-back correction, supersession/history | Ambiguous numbers and spoken correction tests; never infer a device measurement |
| R18: visit preparation | Source-linked editable summaries, omission, explicit review/share, invalidation and revocation | Review a complete appointment report with the intended user |
| R19: shared confirmation policy | Same immutable proposal transaction for all care facts; duplicate/retry tests | Lost acknowledgement immediately after actual device confirmation; no second record |

P1/P2 items (tap mode, additional language/family voices, durable offline queue, battery optimisation, measurement imports and clinical integrations) remain outside this first build as specified by the PRD.

## External dependencies and submission evidence

- Supplier handoff: exact board/PSRAM, pin map, power diagram, motor driver, enclosure/card fit, USB access and diagnostics source. Default firmware pins are unassigned; no wiring is guessed.
- Assembled cardholder: required for flashing, acoustic tests, one-hour power run, 30-turn latency and failure trials, and five-user formative testing. No ESP32 USB serial port was visible during the current workstation check.
- Cloud account: configured ASR/TTS/LLM access, HTTPS domain and Tencent deployment target. Secrets belong in local/server configuration, not chat or Git.
- Docker runtime: needed to validate the provided container stack and PostgreSQL deployment path.
- Competition tool evidence: the PRD requires actual CodeBuddy or WorkBuddy use, development history and at least three reviewed screenshots. Access to the installed WorkBuddy app was not approved in this session. No such evidence has been fabricated; this gate remains outstanding.

Do not describe this repository as a completed clinical product, a hardware-validated prototype or a completed hackathon submission until the relevant evidence above exists.
