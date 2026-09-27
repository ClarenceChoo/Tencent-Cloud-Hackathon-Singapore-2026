# Phone companion verification ledger

Status: **in development; the complete PRD is not accepted**. Updated 27 September 2026.

The native implementation is under `mobile/`. The original website remains the caregiver/owner dashboard. No native microphone, physical-phone, live-provider, notification-delivery or performance claim is established by automated fixtures or Metro export.

## Evidence collected

- Backend: 76 tests are verified on SQLite and isolated PostgreSQL 15.14 (74-test full suite, then the six-test audio module rerun including two added cases). The original 60 tests are included. See `backend/tests/test_phone_identity.py`, `test_migrations.py` and `test_phone_audio.py` for the new assertions.
- Migration tests upgrade an actual populated pre-Alembic schema, preserve a note and bindings, select only a single unambiguous existing device, reject an incomplete schema, inject failure after DDL and verify transaction rollback, then recover. Downgrade preserves care records and revokes phone credentials before losing the device-type field.
- Phone identity tests exercise exact enrollment retries, two concurrent registrations, simultaneous owner approvals, expiry, CSRF, caregiver/other-patient denial, credential/code separation, capability checks, TLS requirement, rate limits and revocation.
- Audio tests invoke installed FFmpeg/FFprobe to convert actual AAC in M4A into canonical PCM WAV. They reject malformed, mismatched, overlong and video input, and unavailable decoding. The speech provider inside these tests is explicitly a fixture.
- Fixture phone flow: encoded audio → shared worker → unsaved proposal → authenticated speech assets → explicit concurrent confirmation → one committed note → permitted caregiver visibility. Another caregiver does not see the unshared note. Recovery uses the original upload digest and installation-scoped idempotency key.
- Correction and cancellation invalidate the old proposal. Another phone, even bound to the same patient, cannot confirm that phone's proposal or use its context. Phone-only operations reject pendant credentials.
- Dashboard: 11 tests and production build pass; phone approval uses the separate owner endpoint and displays phone identity.
- Native: pinned Expo 57.0.25 / React Native 0.86.3 / React 19.2.3; TypeScript and two transport/audio validation tests pass. Expo prebuild generates both native projects. Metro exports Android and iOS Hermes bundles. **These are not installable APK/IPA build results.**
- Generated configuration was inspected: microphone permission is present, background audio modes are absent, and Android backup is disabled. The debug manifest allows local Metro transport; the companion's service client only accepts HTTPS origins and does not put credentials in URLs.

## Requirement audit

| Requirement | Current implementation/evidence | Remaining proof/work |
|---|---|---|
| P01 Native builds | Native React Native source, pinned dependencies, both prebuilds and bundles | Compile/sign/install each platform; native screenshots and test recordings |
| P02 Enrollment | Hash-only credential storage server-side; owner approval; expiry/race/revocation tests; SecureStore adapter | Real Keychain/Keystore/reinstall validation; operational abuse testing |
| P03 Deliberate capture | Real expo-audio recorder, hold/tap controls, permission gating, 19-second JS/19.5-second native cap, cancellation on app state/blur | Model-based lifecycle tests and both-phone permission/call/lock/interruption evidence |
| P04 Transport/recovery | Bounded native AAC normalization, shared worker, original digest, receipt lookup, protected pending identifiers | Actual native format/receipt-loss/background/resume tests; automatic resume reconciliation refinement |
| P05 Playback/confirmation | Authenticated ordered clips, bounded WAV validation, stop/repeat; shared confirm/revise/cancel and spoken read-back/Saved routes | Physical audibility, ordered playback and interruption tests; current-response race review |
| P06 Medication parity | Checked plan and dose state consumption; shared interpreter unchanged | Native complete medication explanation/report journeys and reminder delivery |
| P07 Tracking/prevention | Readings/tasks shown; same shared proposal/confirmation pipeline | Native BP/provenance/task-transition journeys; source labels across all dashboard records |
| P08 Support/check-ins | Current support/follow-up states consumed; shared voice intents preserved | Native complete journeys, check-in reminder delivery and update notifications |
| P09 Dashboard/preparation | Same confirmed records/grants; fixture visibility test; authenticated dashboard link | Actual already-open caregiver browser test for phone; summary review/share demo |
| P10 Active companion | Route schema and safe legacy backfill only | Scheduler still uses legacy device selection. Implement atomic switches, generations, attempt history, quiesce/power-off handoff, pending/audio/ACK fencing, ledger and races before accepting |
| P11 Background alerts | Native notifications dependency/configuration present only | Local generic schedules, push adapter/registration, permission states, route cancellation, duplicate suppression, per-OS acceptance |
| P12 Presence/provenance | Device type and phone names exposed; native note/reading/dose source metadata | Foreground/background/permissions status, active selection UI, dashboard provenance for all records |
| P13 Failure/privacy | Distinct API errors, bounded private cache cleanup, protected pending state, reinstall warning and unpair | Lost receipt, stop-during-prepare, audio focus, app kill/resume and stale callback tests; both-platform cleanup proof |
| P14 Delivery/compatibility | Real migrations, legacy regressions, dependency locks, deployment FFmpeg and route-specific size limit | Final documentation, full regression/browser/protocol runs, release evidence and PR acceptance |

## Acceptance gates

E01 is partial: backend and dashboard automated checks pass, but browser/device-protocol/native integration must be rerun after routing work.

E02/E03 have automated SQLite/PostgreSQL evidence; deployment migration rehearsal and physical identity tests remain.

E04–E10 are **not accepted**. No physical phone or live speech provider has been exercised. No one-hour run, 30-event dashboard latency sample or 30-turn live speech sample has been collected.

E11 is in progress. This ledger and setup guide are maintained with the build. The requested actual demo remains outstanding.

## External dependencies and known engineering work

- The host has Command Line Tools but no full Xcode, iOS Simulator tools, Android SDK/adb or Android Studio. Java is present. Do not treat prebuild or Metro export as a native build.
- Test phones, signing/install route, reachable HTTPS service, live speech provider and push credentials have not been supplied/verified. Credentials belong in secret configuration, not this repository.
- Independent implementation continues: active routing, native notification scheduling/push, lifecycle tests, full native care journeys and provenance. These are not blocked by missing devices.
- `npm audit` reports 10 moderate transitive native-tooling advisories rooted in `uuid <11.1.1` through `xcode`/Expo tooling (GHSA-w5hq-g745-h8pq). The app uses `expo-crypto` for credentials. Do not apply npm's suggested downgrade to Expo 46; resolve compatibility during release hardening. Existing dashboard dependencies also report advisories and need a scoped review before release.
- Automatic notifications must remain generic until foreground synchronization proves route, plan and occurrence validity. No background notification feature is claimed by this checkpoint.
