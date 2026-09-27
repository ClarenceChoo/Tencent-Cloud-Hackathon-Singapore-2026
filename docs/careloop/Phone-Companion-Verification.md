# Phone companion verification ledger

Status: **in development; the complete PRD is not accepted**. Updated 27 September 2026.

The native implementation is under `mobile/`. The original website remains the caregiver/owner dashboard. No native microphone, physical-phone, live-provider, notification-delivery or performance claim is established by automated fixtures or Metro export.

## Evidence collected

- Backend: **93 tests pass in full on SQLite and isolated PostgreSQL 15.14** after the routing changes. The original 60 tests remain included; protocol fixtures now explicitly select their baseline companion and create logical reminder occurrences.
- Routing tests cover generation compare-and-set races, owner/CSRF/patient boundaries, pendant power-off acknowledgement, phone cleanup before switching (including revoked phones), no automatic selection, queued reroute with the same occurrence/dose and expiry, no replay after download/start/completion/interruption/unknown/failure, stale audio/context/ACK rejection, exact ACK retries and switch/plan changes during speech generation. Slow speech generation holds no write lock. Native operating-system behavior is not established by these server fixtures.
- Migration tests upgrade an actual populated pre-Alembic schema, preserve a note and bindings, select only a single unambiguous existing device, reject an incomplete schema, inject failure after DDL and verify transaction rollback, then recover. Populated reminder/check-in migration preserves IDs, audio, acknowledgements and playback history; old download uncertainty is conservatively retained. Downgrade refuses to discard multiple delivery attempts. Earlier identity downgrade preserves care and revokes phone credentials before losing the device-type field.
- Phone identity tests exercise exact enrollment retries, two concurrent registrations, simultaneous owner approvals, expiry, CSRF, caregiver/other-patient denial, credential/code separation, capability checks, TLS requirement, rate limits and revocation.
- Audio tests invoke installed FFmpeg/FFprobe to convert actual AAC in M4A into canonical PCM WAV. They reject malformed, mismatched, overlong and video input, and unavailable decoding. The speech provider inside these tests is explicitly a fixture.
- Fixture phone flow: encoded audio → shared worker → unsaved proposal → authenticated speech assets → explicit concurrent confirmation → one committed note → permitted caregiver visibility. Another caregiver does not see the unshared note. Recovery uses the original upload digest and installation-scoped idempotency key.
- Correction and cancellation invalidate the old proposal. Another phone, even bound to the same patient, cannot confirm that phone's proposal or use its context. Phone-only operations reject pendant credentials.
- Dashboard: **14 tests and the production build pass**. Owner selection includes generation checking and physical power-off acknowledgement; switching away from a phone directs cleanup on that phone. Caregiver controls stay hidden.
- Native: pinned Expo 57.0.25 / React Native 0.86.3 / React 19.2.3; TypeScript and five transport/audio/operation-quiescence tests pass. Expo prebuild generates both native projects. Metro exports Android and iOS Hermes bundles. **These are not installable APK/IPA build results.**
- Generated configuration was inspected: microphone permission is present, background audio modes are absent, and Android backup is disabled. The debug manifest allows local Metro transport; the companion's service client only accepts HTTPS origins and does not put credentials in URLs.

## Requirement audit

| Requirement | Current implementation/evidence | Remaining proof/work |
|---|---|---|
| P01 Native builds | Native React Native source, pinned dependencies, both prebuilds and bundles | Compile/sign/install each platform; native screenshots and test recordings |
| P02 Enrollment | Hash-only credential storage server-side; owner approval; expiry/race/revocation tests; SecureStore adapter | Real Keychain/Keystore/reinstall validation; operational abuse testing |
| P03 Deliberate capture | Real expo-audio recorder, hold/tap controls, permission gating, 19-second JS/19.5-second native cap, cancellation on app state/blur | Model-based lifecycle tests and both-phone permission/call/lock/interruption evidence |
| P04 Transport/recovery | Bounded native AAC normalization, shared worker, original digest, receipt lookup, protected pending identifiers | Actual native format/receipt-loss/background/resume tests; automatic resume reconciliation refinement |
| P05 Playback/confirmation | Authenticated ordered clips, bounded WAV validation, stop/repeat; shared confirm/revise/cancel and spoken read-back/Saved routes | Physical audibility, ordered playback and interruption tests; cached response/asset freshness and full native callback race review; server tests now invalidate older phone read-backs and reject late older proposals |
| P06 Medication parity | Checked plan and dose state consumption; shared interpreter unchanged | Native complete medication explanation/report journeys and reminder delivery |
| P07 Tracking/prevention | Readings/tasks shown; same shared proposal/confirmation pipeline | Native BP/provenance/task-transition journeys; source labels across all dashboard records |
| P08 Support/check-ins | Current support/follow-up states consumed; shared voice intents preserved | Native complete journeys, check-in reminder delivery and update notifications |
| P09 Dashboard/preparation | Same confirmed records/grants; fixture visibility test; authenticated dashboard link | Actual already-open caregiver browser test for phone; summary review/share demo |
| P10 Active companion | Explicit selection, occurrence/attempt migration, generation fencing, atomic owner switch, dashboard control, restricted phone quiescence and conservative replay handling; SQLite/PostgreSQL races pass | Native foreground reminder receiver and durable playback ledger; handoff across notifications engine and actual phones/pendant |
| P11 Background alerts | Native notifications dependency/configuration present only | Local generic schedules, push adapter/registration, permission states, route cancellation, duplicate suppression, per-OS acceptance |
| P12 Presence/provenance | Device type and phone names exposed; native note/reading/dose source metadata | Foreground/background/permissions status, dashboard provenance for all records |
| P13 Failure/privacy | Distinct API errors, bounded private cache cleanup, protected pending state, reinstall warning and unpair | Lost receipt, stop-during-prepare, audio focus, app kill/resume and stale callback tests; both-platform cleanup proof |
| P14 Delivery/compatibility | Real migrations, legacy regressions, dependency locks, deployment FFmpeg and route-specific size limit | Final documentation, full regression/browser/protocol runs, release evidence and PR acceptance |

## Acceptance gates

E01 is partial: 93 backend regressions on both databases and 14 dashboard tests/build pass after routing work. Native bundle exports pass for both platforms. Full browser/firmware protocol/native integration and on-device evidence remain.

E02/E03 have automated SQLite/PostgreSQL evidence; deployment migration rehearsal and physical identity tests remain.

E04–E10 are **not accepted**. No physical phone or live speech provider has been exercised. No one-hour run, 30-event dashboard latency sample or 30-turn live speech sample has been collected.

E11 is in progress. This ledger and setup guide are maintained with the build. The requested actual demo remains outstanding.

## External dependencies and known engineering work

- The host has Command Line Tools but no full Xcode, iOS Simulator tools, Android SDK/adb or Android Studio. Java is present. Do not treat prebuild or Metro export as a native build.
- Test phones, signing/install route, reachable HTTPS service, live speech provider and push credentials have not been supplied/verified. Credentials belong in secret configuration, not this repository.
- Independent implementation continues: native reminder playback/ledger, notification scheduling/push, lifecycle tests, full native care journeys and provenance. These are not blocked by missing devices.
- `npm audit` reports 10 moderate transitive native-tooling advisories rooted in `uuid <11.1.1` through `xcode`/Expo tooling (GHSA-w5hq-g745-h8pq). The app uses `expo-crypto` for credentials. Do not apply npm's suggested downgrade to Expo 46; resolve compatibility during release hardening. Existing dashboard dependencies also report advisories and need a scoped review before release.
- Automatic notifications must remain generic until foreground synchronization proves route, plan and occurrence validity. No background notification feature is claimed by this checkpoint.
