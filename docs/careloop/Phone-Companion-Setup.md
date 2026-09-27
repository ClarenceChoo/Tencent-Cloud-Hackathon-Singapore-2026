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

## Care sources and spoken status

The phone home response and the caregiver dashboard expose a `provenance` object on medication reports, notes, measurements, preventive tasks, support requests and follow-ups. It identifies a confirmed phone, cardholder or dashboard source, with the originating turn/proposal and confirmation time where available. Missing evidence is `unknown`; it is not inferred to be a dashboard action. Record visibility is checked before provenance is assembled. Device credentials, raw transcripts and recipient emails are not part of this metadata.

Preventive tasks retain their clinical `source` separately from the recording channel. Their `transitions` preserve appointment and completion dates; dose `report_history` and follow-up `resolutions` retain each confirmation source. The phone response includes up to 20 history entries per record with `history_truncated` when older entries are omitted. The native screen shows the latest three updates; the dashboard expands the history. A reading entered by phone is still labelled with its reported external measurement source and timing.

For support and follow-up status questions, the interpreter identifies a record using `support_status` or `followup_status`. The backend renders the answer from the patient's stored acknowledgement/resolution/outcome fields and ignores model-written status prose. An unknown or foreign record requires clarification. Status is rechecked after speech generation, and newly generated status audio returns 410 if its record has changed before retrieval. This does not establish freshness for an audio file already downloaded to a phone; native playback freshness remains an acceptance item.

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

The supplied Compose stack exposes only Caddy on host ports 80/443. Its private backend sets `FORWARDED_ALLOW_IPS=*` so Uvicorn correctly sees HTTPS and the client address forwarded by that trusted proxy. If changing the network layout or exposing the backend directly, replace that wildcard with the trusted proxy address/range; never trust forwarded headers from arbitrary public clients.
