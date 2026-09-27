# Parse phone companion — development setup

This is an implementation in progress against [the full PRD](Phone-Companion-PRD.md). Read the [verification ledger](Phone-Companion-Verification.md) before using the build in a demonstration. Source now includes foreground voice/reminders, explicit reminder routing, generic local alerts and an Expo push adapter. Native builds, delivery on real phones and the complete acceptance gates remain unverified.

## Backend and database

From `backend/`:

```sh
uv sync --frozen --extra test
uv run python -m app.migrate
uv run python -m pytest
```

`CARELOOP_DATABASE_URL` selects the same existing care database used by the dashboard. On startup, the API also runs the versioned upgrade under a database lock. Existing databases are adopted only after their legacy tables/columns pass the schema manifest check. There is no reset/reseed step. Back up an existing deployment first and rehearse the upgrade against its copy. Restore the backup if an operator requires a complete rollback; Alembic downgrade deliberately revokes phone credentials while preserving care records.

Install FFmpeg and FFprobe on a local backend. The container installs them from its Debian repository and includes the migrations directory. The phone adapter accepts AAC in M4A with `Content-Type: audio/mp4`, or canonical WAV. The pendant endpoint still accepts only canonical WAV. The proxy permits up to 2 MiB only on `/v1/phone/turns`; other requests retain their prior cap. Decoder subprocesses use format/protocol allowlists, disabled external data references, CPU/time/file/memory limits and a two-conversion concurrency bound.

Use the existing HTTPS deployment and provider configuration in [the deployment guide](../../deploy/README.md) and [PROVIDERS.md](PROVIDERS.md). A phone cannot reach a laptop using `127.0.0.1`. The native service field requires an HTTPS origin. It never accepts credentials, query strings or paths in the service address. Enrollment rejects HTTP outside automated testing.

The enrollment limiter is bounded and local to the API process. The supported deployment currently uses one worker. A scaled deployment needs a shared limiter before increasing worker count.

## Native development builds

From `mobile/`:

```sh
npm ci
npm run typecheck
npm test
EXPO_NO_TELEMETRY=1 npx expo install --check
EXPO_NO_TELEMETRY=1 npm run prebuild
npm run ios
# Or, with Android SDK/platform tools and a configured emulator/device:
npm run android
```

iOS requires full Xcode and the appropriate simulator/device signing setup. Android requires an SDK/toolchain compatible with the generated React Native Gradle configuration. Java alone is insufficient. No paid cloud build account is required by these commands. Expo Go is not the release verification environment.

`app.config.ts` and the locked dependencies generate `ios/` and `android/`; those generated directories are ignored. Keep native changes in config plugins/configuration so regeneration remains reproducible. The application identifiers are currently `sg.parse.companion` and may be changed before signing if the team needs a different namespace.

For a build-independent bundle check:

```sh
EXPO_NO_TELEMETRY=1 CI=1 npx expo export --platform all --max-workers 2
```

This produces Hermes JavaScript bundles, not an installable application. Use `npm start` for the development client after installing a native development build.

## Pair and exercise the foreground flow

1. Open the native app and enter the Parse HTTPS origin. It generates a random 32-byte installation credential and keeps it in SecureStore. The screen shows a different ten-minute possession code.
2. Sign into the existing owner dashboard, open Settings, select **Parse phone app**, and approve that code for the intended patient. A device token cannot sign into the owner dashboard.
3. Return to the native app. It polls the enrollment using its own credential and loads the same care record. Choose the microphone permission only when starting a recording.
4. Hold the talk control, speak, and release. The accessible tap switch provides start/stop taps. The recorder is capped below the server's 20-second limit. It does not request background recording or continuous listening.
5. Listen to the read-back and sharing choice. Speak a correction or use **Confirm and save**. The spoken Saved message is fetched only after a server commitment. Observe the existing caregiver dashboard under the appropriate account.
6. If acknowledgement is lost, reopening the paired app automatically queries the original installation/idempotency key. While foregrounded and idle, it retries unresolved results without another upload or confirmation. Recovery refreshes the care view before clearing its protected identifiers. Automatically recovered replies appear as text; use **Repeat spoken reply** to hear current, unexpired audio, or **Recover response** for an immediate deliberate check. Captured files are removed on receipt/cancellation/failure or the 60-second unsent limit, with an orphan sweep at launch. No durable voice archive is created. Discarding recovery does not cancel a recording already received by the server; check the current care details before recording the same information again.
7. Use the medicine, care and recent-activity sections to inspect the checked plan and recorded outcomes. Visit summaries and plan administration open the existing dashboard and require its normal login.

Only one deliberate voice interaction should run at a time. Until the routing and notifications gates are completed, this development checkpoint does not replace the pendant's background reminders.

## Accessible interaction and app-level recovery

The phone reads the saved hold/tap preference and the native screen-reader state before enabling talk. While a screen reader is on, the talk control uses tap-to-start/tap-to-send so accessibility activation cannot become an accidental short hold. Turning a screen reader on or off during recording cancels that capture instead of sending it with a changed gesture. The last explicit user preference is stored separately from the installation identity and remains available after re-pairing. A failed settings read defaults to tap with an explanation; a failed write reports that the current choice was not saved.

Clinical captions start at 18 logical units. The talk surface uses a minimum height with padding rather than a fixed height, and the settings/header rows and tabs can wrap. Buttons expose their disabled state, the talk control describes its gesture, and tap recording has a matching visible listening prompt. These source changes and adapter fixtures do not establish real VoiceOver/TalkBack behavior or largest-font fit; both still need inspection on iOS and Android.

Read-back replay and links to phone settings/the dashboard wait for verified audio stop before starting the next action. App actions are serialized and tied to the current installation. Concurrent home refreshes apply only the newest request's result. If the server denies phone access, the app immediately hides care/proposal screens, blocks capture and stops using care APIs; local audio, notification and ledger cleanup is drained separately. Cleanup failure leaves a **Retry local cleanup** action and does not restore patient details. The old reminder cleanup action remains available after the API is disconnected, so retry still drains its pending work before restricted server quiescence. Starting a new pairing remains disabled until this cleanup succeeds.

## Audio interruption and cleanup

Recording monitors native pause/reset state every 200 ms while active and checks microphone permission at most once per second. Focus loss, cancellation and an installation change discard the current capture. Setup/stop failures remove partial files. The JavaScript deadline is 19 seconds with a separate 19.5-second native ceiling; both remain below the server's 20-second maximum. A paused native recorder is cancelled rather than treated as a completed user utterance.

Replies use private cache files, one clip at a time. The player waits for readiness, checks the current authenticated asset and then obtains any reminder-start authorization. It rejects expired/invalid envelopes, retains the 1–20 clip/120-second limits and releases/deletes every clip on completion or interruption. Downloads are streamed with a 768 KiB client limit and a 30-second total transfer timeout. Stop halts local playback immediately and drains admitted start/ledger writes before a device handoff. If cleanup fails, **Retry stop** keeps new voice operations disabled until cleanup is verified.

`npm test` runs 25 pure unit tests and 64 app/React-hook/HTTP-adapter tests. `npm run test:adapters` runs only the latter. Thirteen of the adapter tests mount the production app with its real voice/reminder hooks and protected-storage code against controlled OS/storage/API ports. They cover capture → unsaved proposal → explicit confirmation, cleanup failures, stale responses, screen-reader gesture changes and restored identity. The other hook tests execute the production React hooks against controlled native module adapters; they do not exercise a phone microphone, native decoder, operating-system audio focus or Keychain/Keystore. Run the physical-platform checklist in the PRD before accepting those behaviors.

## Care sources and spoken status

The phone home response and the caregiver dashboard expose a `provenance` object on medication reports, notes, measurements, preventive tasks, support requests and follow-ups. It identifies a confirmed phone, cardholder or dashboard source, with the originating turn/proposal and confirmation time where available. Missing evidence is `unknown`; it is not inferred to be a dashboard action. Record visibility is checked before provenance is assembled. Device credentials, raw transcripts and recipient emails are not part of this metadata.

Preventive tasks retain their clinical `source` separately from the recording channel. Their `transitions` preserve appointment and completion dates; dose `report_history` and follow-up `resolutions` retain each confirmation source. The phone response includes up to 20 history entries per record with `history_truncated` when older entries are omitted. The native screen shows the latest three updates; the dashboard expands the history. A reading entered by phone is still labelled with its reported external measurement source and timing.

For support and follow-up status questions, the interpreter identifies a record using `support_status` or `followup_status`. The backend renders the answer from the patient's stored acknowledgement/resolution/outcome fields and ignores model-written status prose. An unknown or foreign record requires clarification. Status is rechecked after speech generation, and newly generated status audio returns 410 if its record has changed before retrieval. The native player revalidates a downloaded clip with authenticated HEAD when loading completes and once per second during playback. Failed checks stop the sequence; a five-second check timeout bounds an unresponsive service. This reduces stale playback but cannot guarantee instantaneous remote cancellation. Physical interruption and freshness behavior still require device verification.

## Select the reminder companion

In the owner dashboard, Settings → Reminder companion selects exactly one paired phone or cardholder. Pairing alone does not select a new device. Existing databases backfill only an unambiguous single device; ambiguous installations start paused.

Before switching away from a cardholder, physically power it off and acknowledge this in the dashboard. The legacy firmware can hold downloaded speech that the server cannot stop remotely. Before switching away from a phone, use **Settings → Pause reminders** on that phone. The app stops admitted audio operations, disables recording, cancels and verifies removal of scheduled native alerts, then attests cleanup to the server. The server deactivates only that installation. Owner revocation does not pretend to stop already downloaded audio; the revoked phone can still use the restricted cleanup endpoint, which exposes no care records.

`PUT /v1/app/patients/{id}/active-companion` accepts `device_id`, `expected_generation` and `other_pendants_powered_off` through normal owner session/CSRF authorization. A stale generation returns 409. `POST /v1/phone/quiesce` accepts `playback_stopped: true` and `local_alerts_cleared: true` using the phone credential. Client code must perform and await those actions before sending this acknowledgement.

One logical occurrence retains all per-device attempts. Only an unplayed, route-cancelled attempt may be requeued to a new generation within the original expiry. Downloaded/started/unknown/interrupted/completed delivery does not silently replay on a replacement. Neither playback nor a switch confirms medication taken. The dashboard API exposes attempt history separately from dose state.

The database upgrade `0003_reminder_routes` preserves old command and acknowledgement identities. Since the previous build did not record downloads, old non-preparing attempts are treated as potentially heard. Downgrading after multiple attempts exist is rejected rather than dropping history; restore a pre-upgrade backup if a full rollback is required.

While the selected phone is open and idle, it polls for current reminders, rechecks their route and expiry, and records playback state in SecureStore before starting speech. A reserved or started reminder is not replayed after an uncertain interruption. Only actual native playback completion creates a completion acknowledgement; neither notifications nor playback confirm a dose. On foreground synchronization, the app also retries unsettled acknowledgement entries independently of the server's pending queue, using each stored retry identity. Completed entries send completion; uncertain entries send interruption. Historical terminal evidence can reconcile an expired or old-route attempt only if the server previously authorized that phone's playback start. It cannot authorize fresh playback, overwrite a conflicting terminal state, or confirm a dose. Unpair/handoff waits for active ledger writes before clearing local state. Use this for development validation until the ledger's device and notification gates pass.

## Native alerts and push configuration

In the phone's Settings, choose **Enable alerts** to request notification permission. The app schedules generic medication/check-in alerts for the next 24 hours, capped at 60 pending alerts. A shortened coverage window is reported if the cap is reached. Schedules refresh while the app is open; reopening refreshes care state before any spoken reminder. Local alerts do not require an Expo push project. Android channel settings, Focus/Do Not Disturb, battery restrictions and OS scheduling can suppress or delay alerts. Exact delivery time is not guaranteed.

Both local alerts and push hints use only `Parse` and `Open Parse to check your care schedule.` They contain opaque identifiers, never medication names, symptoms or clinical text. Notification scheduling/opening evidence is separate from audio playback and dose reports. Opening a stale alert fetches current state rather than playing cached speech. Permission denial cancels local alerts during synchronization and disables the server's push registration; a disconnected phone cannot instantly learn about a server-side revocation.

For remote push in a native development/release build:

1. Copy `mobile/.env.example` to an ignored local environment file. Set `EXPO_PUBLIC_EAS_PROJECT_ID` to the public UUID of the team's Expo project before building. For Android, set `PARSE_GOOGLE_SERVICES_FILE` to the local Firebase native configuration path. Keep private configuration and signing credentials out of Git.
2. Configure the project's APNs credentials for iOS and FCM credentials for Android, matching `sg.parse.companion` (or the team's chosen application identifier). Follow the [Expo push setup guide](https://docs.expo.dev/push-notifications/push-notifications-setup/). Native credentials/configuration changes require rebuilding the app.
3. Enable `CARELOOP_EXPO_PUSH_ENABLED=true` in the backend's secret environment. If the Expo project uses enhanced push security, also set `CARELOOP_EXPO_PUSH_ACCESS_TOKEN`. The server scheduler must be enabled. Compose forwards these variables; the defaults send no push traffic.
4. Open the paired phone, select it as the reminder companion, and choose **Enable alerts**. Registration is bound to its installation credential. Verify registration and then test actual delivery on each platform; successful registration alone is not delivery evidence.

The phone reads its stored push-registration status when it opens. Permission reporting precedes token registration. Token acquisition runs separately from local scheduling and foreground reminders, times out after ten seconds, and ignores results from a paused or replaced installation. A native token-refresh event is passed directly to Expo; it does not recursively fetch another native token inside the listener. Routine polling reads current registration state without repeatedly registering a disabled token. Enable alerts, foreground resume and a new native token can request a fresh registration; transient failures wait at least 30 seconds before retrying while open.

The registration write includes the previously read registration version and companion routing generation. A delayed request cannot overwrite a newer token, a permission-denial invalidation or a completed device handoff. Pause drains token writes along with alert scheduling and playback acknowledgements; backend quiescence disables push and cancels its pending hints. Permission denial clears local alerts even while offline. Until the server confirms the change, the phone says so. Deploy the updated API and native client together because the draft registration endpoint now requires these counters.

The dashboard's Care update alerts field reports push registration separately from foreground presence and local schedule coverage. Registration is not evidence that a notification was delivered or seen.

The server queues generic hints when the selected phone's plan, profile, support or follow-up state changes. It sends through Expo over HTTPS, retries transient failures at most five times with a stable collapse identifier, and checks tickets/receipts. `DeviceNotRegistered` disables the token. A provider-accepted receipt does not prove that the phone displayed an alert. See [Expo send/receipt semantics](https://docs.expo.dev/push-notifications/sending-notifications/).

Migration `0004_phone_notifications` adds private phone presence/registration state, separate notification evidence, a durable push outbox and context guards for newly generated speech. Existing care records and routing history remain intact. Dashboard presence distinguishes a recent foreground report from reported background-alert capability; it does not claim a persistent background connection or guaranteed delivery.

## Identity, permissions and removal

Unpair stops audio and clears local alerts, completes server quiescence for a bound phone, then sends revocation before clearing the local identity. If the phone is offline, revocation cannot be claimed; the care-space owner can revoke it from the dashboard. Uninstall alone does not revoke server access.

SecureStore uses a device-only Keychain accessibility class, and Android backups are disabled. iOS Keychain entries can survive uninstall. An absent local installation marker with an existing secure identity triggers a re-pair warning; the owner should revoke the old installation. Backup/reinstall behavior still needs physical-platform verification.

Microphone permission, OS audio focus, device volume and notification settings are separate. Permission denial must not be presented as a server failure. The dashboard shows the last reported permissions and schedule coverage; physical-platform behavior remains part of acceptance testing.

## Verification commands

```sh
# Repository root; creates and removes an isolated PostgreSQL test cluster:
python3 tools/postgres_test.py
# Dashboard:
cd frontend
npm ci
npm test
npm run build
```

Use only fictional profiles for automated fixtures. Provider fixtures are not a substitute for the final real-microphone → live-provider → confirmation → caregiver demo.

### Phone-to-dashboard browser verification

The browser harness runs the production dashboard with three separate browser sessions and a disposable loopback backend. It enrolls a phone through the real owner UI, submits AAC/M4A through the phone endpoint, corrects and confirms a note, checks recipient privacy, removes sharing, revokes and regrants access, and measures 30 subsequent confirmations without reloading the caregiver page. It also verifies server-invalidated browser sessions and phone revocation. Speech is a hash-matched fixture using encoded tones, not a microphone or live interpretation service.

Install the locked browser-test dependency with `npm ci --prefix tools` and have Chrome installed, or set `CARELOOP_BROWSER_EXECUTABLE` to a Chromium executable. FFmpeg/FFprobe and the backend environment must already be available. From the repository root, start the fixture in a separate terminal:

```sh
backend/.venv/bin/python tools/phone_browser_fixture.py \
  --data-dir runtime/phone-browser --port 8003 --web-port 5175
```

Wait for `Phone/browser fixture ready`. The data directory must be **new** and inside this repository's ignored `runtime/` folder. The fixture refuses an existing directory and binds only to `127.0.0.1`. It creates fictional `.invalid` accounts and never touches the configured application database. Do not deploy this test entry point.

In another terminal:

```sh
cd frontend
npm run build
CARELOOP_API_TARGET=http://127.0.0.1:8003 npm run preview -- --port 5175 --strictPort
```

Then, from the repository root:

```sh
PARSE_PHONE_FIXTURE_DIR=runtime/phone-browser node tools/browser_phone.cjs
```

An existing Playwright installation can be selected with `PLAYWRIGHT_MODULE` pointing to its module directory. The report and screenshots are written inside the fixture directory. Reports include individual results, all 30 timing samples, browser/Node/platform versions, the starting commit, whether the working tree was dirty, and SHA-256 hashes of the relevant dashboard and harness sources. They contain no installation credential. Use a fresh directory for each run and stop the two local servers afterwards.

The latency metric starts when the confirmation audio upload is sent and ends when its confirmed heading is visible in the already-open caregiver page. It includes local normalization and scripted processing, so it is not a measurement of real speech or a deployed phone network. The PRD's physical-phone/live-provider and one-hour evidence remains separate.

The dashboard now removes its entire care view and open dialogs when a refresh returns 401 or 403, and asks the user to sign in again. Late responses from the old view cannot restore records in the new session. Temporary network/server failures preserve the last loaded data with a connection warning; the next successful poll updates it. Revoking an entire grant removes prior explicit note sharing, so regranting dashboard access alone does not reshare old notes.

The supplied Compose stack exposes only Caddy on host ports 80/443. Its private backend sets `FORWARDED_ALLOW_IPS=*` so Uvicorn correctly sees HTTPS and the client address forwarded by that trusted proxy. If changing the network layout or exposing the backend directly, replace that wildcard with the trusted proxy address/range; never trust forwarded headers from arbitrary public clients.
