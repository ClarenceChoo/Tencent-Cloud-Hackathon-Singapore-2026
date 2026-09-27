# Parse native build and installation

The phone source lives in `mobile/`. Generate its Android and iOS projects from the checked-in Expo configuration; the generated directories, SDK downloads, signing files and application binaries stay out of Git. [Acceptance status](Phone-Companion-Verification.md) distinguishes compilation, emulator checks and physical-phone evidence.

## Current Android preview

The current local ARM64 preview is **r6**: `runtime/releases/parse-companion-android-arm64-preview-2026-09-27-r6.apk` (31,320,051 bytes; SHA-256 `808105ffbbf7e0e32aeaee678c04fa3f5322ac5b7088b7340b7a9c07d30492a8`). It includes the recording, receipt-recovery, saved-connection and clock/time-zone reminder fixes described below. Its [artifact/install report](evidence/android-preview-r6-2026-09-27.json) records successful build, signature verification, matching installed digest and a 385 ms cold launch; the [pairing screen](evidence/android-preview-r6-2026-09-27.png) was reviewed and no process-scoped errors were observed. It is a debug-key-signed preview without fixture trust, not a distribution release. The earlier call-interruption and paired large-text checks used r5; clock/time-zone checks use a separate r6 verification APK against the fictional local service.

The sections below retain the earlier checkpoints and their matching evidence; their older APK filenames are historical artifacts.

## Initial verified Android preview

On 27 September 2026, the first ARM64 APK compiled, passed APK signature verification, installed and cold-launched on the Android 16 AOSP emulator without Metro. That binary is 31,316,823 bytes, SHA-256 `51bcb7a7bb8d0e316b34bbfd85b4fb9fe6de61371e42b44895f0a63c93fac221`. A local copy is retained at `runtime/releases/parse-companion-android-arm64-preview-2026-09-27.apk`, with an adjacent checksum file. Binaries and toolchains are not committed or published as a release.

The native checks verified the unpaired screen, no automatic microphone/notification grant, rejection of a non-HTTPS service address, reachable pairing controls at font scale 2.0 and reopening after force-stop. No process-scoped `AndroidRuntime` or `ReactNativeJS` errors were recorded at the end. Visual review corrected the status icons to dark content on the light background. Source TypeScript checking and 25 unit plus 64 app/hook/HTTP-adapter tests also pass; these remain separate from the emulator observations.

[The machine-readable report](evidence/android-native-2026-09-27.json) records the artifact, source hashes, build toolchain, observed checks and limits. It identifies the preceding Git commit plus changed source hashes because the build ran before this evidence was committed. Screenshots show [normal pairing](evidence/android-pairing-2026-09-27.png), [enlarged text](evidence/android-pairing-font200-top-2026-09-27.png), [the reachable enlarged controls](evidence/android-pairing-font200-bottom-2026-09-27.png) and [HTTP rejection](evidence/android-pairing-http-rejected-2026-09-27.png). The unmodified UI hierarchy files are stored alongside them. The app was unpaired throughout; these results do not establish native care journeys or live-service behavior.

## Android toolchain

The 27 September 2026 local build uses macOS/ARM64, Temurin OpenJDK 17.0.20.1+1, Gradle 9.3.1 from the generated wrapper, Android SDK 36, build tools 36.0.0, NDK 27.1.12297006 and CMake 3.22.1. Some native dependencies also request build tools 35.0.0. The app's minimum SDK is 24 and target SDK is 36. These values follow the locked Expo 57 / React Native 0.86 project; inspect the generated Gradle configuration when upgrading dependencies.

Use **JDK 17**, matching the [React Native recommendation](https://reactnative.dev/docs/set-up-your-environment). On this host, Java 25 passed Gradle's configuration check but failed native Prefab/CMake generation with `A restricted method in java.lang.System has been called`. The same step passed after selecting a local JDK 17; no application or dependency patch was needed. The [official Temurin archive](https://github.com/adoptium/temurin17-binaries/releases/tag/jdk-17.0.20.1%2B1), `OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz`, has SHA-256 `196d13ba5f10414bef7f6a05a9b3f00edacb18ebacef2b99485db9e2ee18f0e8`. Extract it under `runtime/android-build/jdk/`; select it only for this shell/build instead of changing the system Java.

An existing Android SDK can be used by setting `ANDROID_HOME`. This project's local verification instead keeps the SDK, Gradle cache and Android user state under ignored `runtime/android-build/`. It does not need a system-wide Android Studio installation.

Download command-line tools from the [official Android download page](https://developer.android.com/studio). The verified Mac ARM archive is `commandlinetools-mac_arm64-15859902_latest.zip`, SHA-256 `835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e`. Place the contents of its `cmdline-tools/` directory under `runtime/android-build/sdk/cmdline-tools/15859902/`, so `bin/sdkmanager` is immediately below that directory. Use the package matching the host architecture on other systems.

From the repository root, install only the required packages and review their license prompts:

```sh
export JAVA_HOME="$PWD/runtime/android-build/jdk/jdk-17.0.20.1+1/Contents/Home"
export ANDROID_HOME="$PWD/runtime/android-build/sdk"
export ANDROID_USER_HOME="$PWD/runtime/android-build/android-user"
export GRADLE_USER_HOME="$PWD/runtime/android-build/gradle"
"$ANDROID_HOME/cmdline-tools/15859902/bin/sdkmanager" \
  --sdk_root="$ANDROID_HOME" --install \
  "platform-tools" "platforms;android-36" \
  "build-tools;36.0.0" "build-tools;35.0.0" \
  "ndk;27.1.12297006" "cmake;3.22.1"
```

Command-line tools 22 still provide `sdkmanager`, although the [current documentation](https://developer.android.com/tools/sdkmanager) marks it deprecated in favor of `android sdk`. The command above records the tool used for this verification; its version check also passed under the selected JDK 17.

## Build an Android preview with bundled JavaScript

Keep the absolute toolchain environment variables from above in the same shell. Starting from the repository root:

```sh
cd mobile
npm ci
CI=1 EXPO_NO_TELEMETRY=1 npm run prebuild -- --platform android
cd android
CI=1 NODE_ENV=production EXPO_NO_TELEMETRY=1 \
  ./gradlew :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --console=plain --max-workers=2
```

The output is `mobile/android/app/build/outputs/apk/release/app-release.apk`. The ARM64 option bounds this local preview build; it is not evidence for other Android architectures. Omitting it builds the configured architectures. Unlike the development variant, this variant embeds the Hermes bundle and can open without Metro.

**This is a local preview, not a production-signed release.** The generated Expo project signs this variant with its standard Android debug key. Do not publish it as a store release. Use the team's controlled signing configuration for distribution, preserve that configuration through a config plugin or the chosen build service, and rerun acceptance against the resulting artifact. No signing key belongs in the repository.

Before installing, inspect the package and signature:

```sh
"$ANDROID_HOME/build-tools/36.0.0/aapt2" dump badging \
  app/build/outputs/apk/release/app-release.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

## Android installation

Use a dedicated test device or emulator. Select its serial explicitly so the command cannot install on a different connected phone:

```sh
"$ANDROID_HOME/platform-tools/adb" devices
"$ANDROID_HOME/platform-tools/adb" -s TEST_DEVICE_SERIAL install \
  mobile/android/app/build/outputs/apk/release/app-release.apk
"$ANDROID_HOME/platform-tools/adb" -s TEST_DEVICE_SERIAL shell am start \
  -n sg.parse.companion/.MainActivity
```

The install commands are run from the repository root. A first launch should show the service-address pairing screen without requesting the microphone. Pairing needs a reachable HTTPS Parse service and explicit owner approval in the dashboard. Entering the service address does not select the phone for reminders; the owner makes that selection separately.

An optional disposable Android 16 ARM64 emulator uses `emulator` and `system-images;android-36;default;arm64-v8a`. Keep its AVD directory under `runtime/android-build/` as well. This AOSP image is suitable for startup and local UI checks; it does not establish FCM delivery. Emulator startup is not evidence of physical audibility, microphone behavior, battery behavior or either platform's full acceptance checklist.

## Local native integration fixture

`tools/android_native_fixture.py` prepares a private loopback TLS fixture and a separate `sg.parse.companion.verification` build. Its test-only network configuration trusts the generated CA only for `127.0.0.1`; the normal release source set does not include that CA. The fixture uses fictional accounts, scripted interpretations and a one-second tone. It cannot establish live speech recognition or audible replies.

The 27 September integration attempt paired the native verification installation through owner approval in the real dashboard. It exposed an Android permission lifecycle defect: requesting microphone permission again after it was already granted reopened the permission activity, causing focus-loss cancellation. The voice hook now checks the existing grant before requesting permission. If a permission dialog interrupts preparation, the app explains that recording did not start and requires a fresh deliberate press. Three regression tests cover those cases; TypeScript and all 25 unit plus 67 app/hook/HTTP-adapter tests pass.

The initial verification run failed before transcription with `Use PCM WAV or an AAC recording in an M4A container with its matching Content-Type`. Transport diagnostics found valid MP4 bytes labelled `audio/mpeg`: the pinned Expo fetch implementation replaces a File body's explicit header with the filesystem's detected type. The client now reads a size-bounded ArrayBuffer and sends those bytes with `audio/mp4`, checks cancellation after reading, and refuses oversized input before loading it. The backend's strict MIME/container validation is unchanged. Regression tests use Expo's actual body/header normalizer and cover size growth and cancellation during the read. TypeScript and 25 unit plus 73 app/hook/HTTP-adapter tests pass.

The corrected verification APK has completed native recording, normalized upload, tone playback, correction, explicit confirmation, permitted caregiver delivery and process restart on the Android 16 emulator. A fresh enrollment run passed 13 checks with 18 native recordings: note correction/confirmation, reviewed medication explanation, all four medication report states, external blood pressure, due/arranged/completed preventive-care history, support acknowledgement/resolution, follow-up outcomes and chat without silently creating a note. [The report](evidence/android-native-care-2026-09-27.json) includes source/artifact hashes, upload metadata and explicit limits. Screenshots show the [native correction](evidence/android-native-corrected-proposal-2026-09-27.png) and [permitted caregiver update](evidence/android-native-caregiver-2026-09-27.png). All speech interpretation is scripted and host audio is disabled; this establishes native module integration, not real speech recognition or acoustic audibility. The [initial failed-run report](evidence/android-native-integration-incomplete-2026-09-27.json) is retained as historical evidence of the defect.

A normal preview containing the permission and upload fixes is retained at `runtime/releases/parse-companion-android-arm64-preview-2026-09-27-r2.apk` (31,318,299 bytes; SHA-256 `3ad0173dc6aa34295546a80f9cd1743364493ccc20fe71f8eeb702d2b02a71bd`). It compiles, verifies its APK signature, installs and cold-launches after force-stop in the emulator. It uses the standard debug signing key and does not contain the fixture's local CA/network resources. The earlier preview at the top of this guide predates these fixes.

To reproduce with a fresh ignored directory, from the repository root:

```sh
backend/.venv/bin/python tools/android_native_fixture.py prepare \
  --data-dir runtime/native-integration-local
export PARSE_NATIVE_FIXTURE_DIR="$PWD/runtime/native-integration-local"
# Keep this running in a separate terminal; frontend/dist must already be built.
backend/.venv/bin/python tools/android_native_fixture.py serve \
  --data-dir "$PARSE_NATIVE_FIXTURE_DIR"
```

Using the toolchain environment from above, build from `mobile/android/`:

```sh
CI=1 NODE_ENV=production EXPO_NO_TELEMETRY=1 \
  ./gradlew -I "$PARSE_NATIVE_FIXTURE_DIR/native-verification.init.gradle" \
  :app:assembleNativeVerification -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --console=plain --max-workers=2
```

Install `app/build/outputs/apk/nativeVerification/app-nativeVerification.apk` on a disposable emulator using its explicit serial. From the repository root, run `PARSE_ANDROID_SERIAL=emulator-5580 node tools/android_native_smoke.cjs` with the fixture environment still set. The harness needs Playwright and Chrome; `PLAYWRIGHT_MODULE` can point to an existing Playwright installation. It controls only an emulator and the separate verification package, and writes screenshots and results under the ignored fixture directory. Add `PARSE_NATIVE_FULL_CARE=1` to exercise the extended medication, reading, preventive-care, support and follow-up scenarios. The fixture logs only upload size, MIME, container prefix and digests; it does not retain recordings or credentials in those logs. `PARSE_NATIVE_RESUME_PAIRED=1` is only for debugging an existing fixture pairing and reports that enrollment was reused. Use a fresh verification installation for a fresh fixture database; the fixture refuses to overwrite or reuse an existing database.

## Orphaned recording cleanup and lifecycle checkpoint

Killing the app during recording exposed a cache-cleanup defect: Expo stores Android recordings under `cache/Audio/` and iOS recordings under `cache/ExpoAudio/`, while the startup sweep only inspected the cache root. The sweep now visits those two known directories plus the root and deletes only recording/reply filename prefixes. Two regression tests reproduce the directory layout, preserve unrelated files and tolerate missing directories. The full-app filesystem mock now uses one-level directory listings so it cannot mask this defect. TypeScript and all 100 mobile tests pass (25 unit plus 75 app/hook/HTTP/storage cases).

The [original emulator reproduction](evidence/android-orphan-audio-reproduction-2026-09-27.json) records one orphan remaining after restart with the old APK. A rebuilt [partial lifecycle run](evidence/android-lifecycle-partial-2026-09-27.json) passed cancellation, backgrounding, sleep/wake, kill/reopen cleanup, microphone revocation and the duration ceiling. Its normalized capped recording contains 303,104 samples at 16 kHz (18.944 seconds). That run stopped at a test-fixture mistake: a structured `confirm` intent contained no affirmative transcript and the production confirmation guard correctly refused it.

A separate [confirmation run](evidence/android-spoken-confirmation-2026-09-27.json) then verified both cases: the ambiguous intent saves nothing, while a native recording mapped to the scripted transcript “yes, save that” saves exactly one shared phone-sourced note. The already-open caregiver view receives it, and restarting does not duplicate it. The [caregiver screenshot](evidence/android-spoken-confirmation-caregiver-2026-09-27.png) was visually inspected. This tests actual recording, transport and confirmation with scripted ASR and tone replies; it is not live speech or acoustic-audibility evidence.

The earlier [incomplete lifecycle run](evidence/android-lifecycle-incomplete-2026-09-27.json) stopped because UIAutomator reported zero-sized bounds after restart even though the screen rendered. A cold launch restored bounds, and [three subsequent cold launches](evidence/android-accessibility-cold-launches-2026-09-27.json) exposed valid bounds. The cause remains unresolved; no app fix is claimed for that intermittent accessibility/driver issue.

Select a test path with `PARSE_NATIVE_LIFECYCLE_ONLY=1`, `PARSE_NATIVE_CONFIRMATION_ONLY=1`, `PARSE_NATIVE_REMINDERS_ONLY=1` or `PARSE_NATIVE_ALERTS_ONLY=1` when running `tools/android_native_smoke.cjs`. These modes require `PARSE_NATIVE_RESUME_PAIRED=1` and an existing fictional fixture pairing. Lifecycle/confirmation cache checks require `adb root` on a disposable emulator and inspect recording filenames only. Installed APK digests are recorded separately from source hashes. Reminder tests call `tools/android_native_control.py` to create fictional due occurrences through the production scheduler; it refuses to count an old daily check-in as a new delivery. Alerts-only mode isolates the OS notification checks without replaying passed reminder cases.

The [reminder run](evidence/android-reminders-partial-2026-09-27.json) verified native medication and daily check-in start/completion acknowledgements, no replay after restart and an unchanged unconfirmed medication state. Its original 90-second background-alert observation window expired; Android actually posted the generic notification 104.008 seconds after the requested time. The [delay observation](evidence/android-notification-delay-2026-09-27.json) and [Android shade screenshot](evidence/android-delayed-notification-2026-09-27.png) preserve that result. The driver now measures posting delay, rejects an older posted alert as evidence for a new occurrence, and bounds observation at five minutes. This observation window is not a delivery guarantee or an on-time acceptance target. Live Expo/APNs/FCM remains unconfigured and unverified.

The isolated [alert run](evidence/android-local-alerts-2026-09-27.json) passed background posting, opening without recording medication taken, permission revocation with reported coverage cleared, and native Pause reminders with the selected target deactivated. Its alert posted 106.254 seconds late. A separate [read-only identity audit](evidence/android-notification-identity-2026-09-27.json) matched the actual Android notification tag to the intended device and dose occurrence. Screenshots show [the generic alert](evidence/android-local-alert-2026-09-27.png) and [the denied permission state](evidence/android-notifications-denied-2026-09-27.png). The isolated rerun also corrected the fixture's selection of an older plan's retained dose; it now filters by the newly created plan version. These are Android emulator results only; locked, normally terminated, offline, Focus/battery/timezone and physical-device cases remain, as do all iOS native and live-push cases.

The normal r3 preview at `runtime/releases/parse-companion-android-arm64-preview-2026-09-27-r3.apk` includes the cleanup fix (31,318,451 bytes; SHA-256 `5a3299a78222db3e8b653f30bb4b306c03fde2d98dca193bfedd8d30e3614cf7`). Compilation and APK signature verification passed, and it contains no local fixture resources. It uses the standard debug signing key. The normal package installs and cold-launches after force-stop without Metro; the installed APK digest matches, the screen shows “Connect to Parse,” and no process-scoped native/JavaScript errors were observed. [Artifact and launch report](evidence/android-preview-r3-2026-09-27.json), [pairing screen](evidence/android-preview-r3-pairing-2026-09-27.png). The earlier r2 installation evidence remains specific to r2.

## Recovery after a lost upload receipt

Native testing through a separate loopback TLS fault proxy confirmed that an abrupt disconnect after the backend accepts audio survives an offline app restart. Reconnection looks up the same receipt key, does not send another upload to the backend or confirm automatically, and explicit native confirmation creates one shared phone-sourced note. [Disconnect report](evidence/android-receipt-disconnect-2026-09-27.json).

The proxy then reproduced a real client defect: when a gateway replaced the accepted upload's 202 receipt with HTTP 503, the app deleted its protected receipt identifier. After offline restart it could fetch the care view but did not reconcile that accepted turn by its original key. [Before-fix report](evidence/android-receipt-503-before-2026-09-27.json). The voice hook now treats 503 as ambiguous, like other server/gateway errors, and retains only the pending identifiers/context for read-only recovery. Captured audio is still removed immediately. Four hook regressions cover 500/502/503 recovery and a genuinely unaccepted 503 whose receipt remains unknown until explicit discard. TypeScript and all **104 mobile tests** pass (25 unit plus 79 app/hook/HTTP/storage cases).

The rebuilt verification APK passed the actual 503/offline-restart scenario: the same accepted turn was recovered, the upload count and turn count stayed at one new turn, and no note was committed until the native Confirm action. The permitted caregiver received exactly one note; the restricted caregiver did not. A further restart added neither a turn nor a fact, and retained server raw audio was false. [Fixed native report](evidence/android-receipt-503-fixed-2026-09-27.json), [interrupted state](evidence/android-receipt-interrupted-2026-09-27.png), [recovered caregiver note](evidence/android-receipt-recovered-caregiver-2026-09-27.png). Speech remains scripted and the emulator has host audio disabled; this does not establish physical Wi-Fi/cellular or live-provider behavior.

Reproduce against the existing fictional fixture using its default backend port 8443 and the proxy port 8444. Keep the prepared fixture environment and local TLS material from the preceding setup; no certificate is added to the normal preview. Start the proxy in a separate terminal:

```sh
backend/.venv/bin/python tools/android_native_fault_proxy.py \
  --data-dir "$PARSE_NATIVE_FIXTURE_DIR" --port 8444
```

Then run the installed verification app check with Playwright available:

```sh
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_RECOVERY_ONLY=1 \
  PARSE_NATIVE_RECEIPT_FAULT=503 node tools/android_native_smoke.cjs
```

Use `PARSE_NATIVE_RECEIPT_FAULT=disconnect` for an abrupt connection close. The proxy verifies upstream TLS, forwards only phone/device API paths to the fictional loopback service, and never logs credentials, headers, transcripts or audio. It returns neither patient data nor authentication tokens to a different service. The harness restarts the verification app after changing the reverse mapping so an old pooled connection cannot bypass the fault. Its `finally` block clears the fault and restores `tcp:8443` to `tcp:8443`; stop the temporary proxy after the check. If the harness is forcibly killed, restore that mapping explicitly on the disposable emulator before continuing.

The normal r4 preview is `runtime/releases/parse-companion-android-arm64-preview-2026-09-27-r4.apk` (31,318,447 bytes; SHA-256 `dfd18427a243ba9eb7012c14b86fb240f88fa338480e4cf860c01058f2f9329d`). Compilation, signature verification, install, matching installed digest and cold launch without Metro passed. It uses the standard debug signing key and contains no fixture trust resources. The pairing screen appeared without observed process-scoped native/JavaScript errors. [Artifact and launch report](evidence/android-preview-r4-2026-09-27.json), [pairing screen](evidence/android-preview-r4-pairing-2026-09-27.png). Earlier r2/r3 artifact evidence remains specific to those builds.

## Android lock-screen and normal-termination alerts

The [locked-screen run](evidence/android-alert-locked-initial-2026-09-27.json) scheduled a real local notification for a specific dose and routing generation, then enabled the emulator's swipe keyguard. Android reported `mIsShowing=true` with the screen off. The actual alert appeared with only “Open Parse to check your care schedule.”; no medicine name or instruction was present. [Lock-screen screenshot](evidence/android-alert-locked-2026-09-27.png). Posting was 111.451 seconds after the server due time; a contemporaneous bracketed clock sample measured Android only 416.5 ms ahead of the host with a 27 ms round trip. This remains delayed emulator delivery, not evidence of timely physical-phone alerts. The keyguard had no PIN/biometric credential.

The first harness failed while expanding the notification shade immediately after dismissing keyguard. The alert remained posted. A separate direct tap on that same lock-screen alert reopened Parse; its initial greeting-visibility assertion failed because Settings resumed at the previous scroll position. A [separate audit](evidence/android-alert-locked-tap-audit-2026-09-27.json) verified the resumed native activity, visible Settings controls, exactly one `opened` event for the original identity and an unchanged `unconfirmed` dose. [Tap attempt](evidence/android-alert-locked-tap-attempt-2026-09-27.json), [opened app](evidence/android-alert-locked-opened-2026-09-27.png). The original failures are preserved; they are not rewritten as a clean end-to-end run. The harness now taps the lock-screen entry directly and checks the actual resumed activity and opened event, without requiring a particular scroll position.

The [corrected locked-screen rerun](evidence/android-alert-locked-fixed-2026-09-27.json) passed the complete sequence without an out-of-band launch: exact-dose scheduling, confirmed swipe-keyguard state, actual generic alert, direct tap, resumed native activity, matching opened event and unchanged unconfirmed dose. Raw delay was 95.196 seconds; the clock-adjusted estimate was 94.829 seconds. [Final lock screen](evidence/android-alert-locked-fixed-2026-09-27.png), [opened app](evidence/android-alert-locked-fixed-opened-2026-09-27.png).

The [normal background-process termination run](evidence/android-alert-terminated-2026-09-27.json) passed end to end. Android `am kill` removed the background process while package state remained `stopped=false`; this is process reclamation, not a user force-stop or a recents swipe. The OS later started a new process and posted the exact scheduled notification. The real notification tap reopened Parse and produced an opened event without a medication report. Raw posting delay was 69.450 seconds; the measured 375 ms clock offset gives an approximate 69.075-second adjusted delay. [Notification](evidence/android-alert-terminated-2026-09-27.png), [opened app](evidence/android-alert-terminated-opened-2026-09-27.png).

Reproduce with the prepared fictional fixture and installed verification APK, using one state per invocation:

```sh
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=locked \
  node tools/android_native_smoke.cjs
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=terminated \
  node tools/android_native_smoke.cjs
```

Keep `PARSE_NATIVE_FIXTURE_DIR` and the documented Playwright dependency configured. The termination case uses `am kill` only after backgrounding, checks that the process is absent and the package is not force-stopped, then waits for its real scheduled alarm. Neither mode synthesizes an OS notification. The helper matches the exact device/occurrence/route identity, records clock skew and posting delay, opens the actual alert, and checks that the dose remains unconfirmed. It restores the original keyguard setting in `finally`. These cases concern local medication alerts on the Android emulator; secure-lock behavior, iOS, real push, Focus/power restrictions and physical-device delivery remain separate gates.

## Offline plan changes and reminder handoff

The [offline-plan run](evidence/android-alert-offline-plan-2026-09-27.json) schedules a real local alert, backgrounds the app, routes it through the loopback TLS fault proxy and terminates its process with `am kill`. At the actual due time, the production scheduler queues the original reminder. The owner then replaces the medication plan while the phone is offline. A remote attempt to deselect that phone is rejected until local cleanup can run.

Android still posts the already-scheduled alert with generic text only. Raw posting delay was 88.689 seconds; the clock-adjusted estimate was 88.357 seconds. Opening that actual notification encounters the offline connection, shows no care/recording controls and does not download or play the cancelled reminder. On reconnect, the app fetches the replacement plan; the original command remains cancelled with `plan_changed`, no audio access and no playback acknowledgements. Its dose stays unconfirmed and the care-note count is unchanged. [Generic alert](evidence/android-alert-offline-plan-2026-09-27.png), [offline view](evidence/android-alert-offline-plan-opened-2026-09-27.png), [replacement plan](evidence/android-alert-offline-plan-current-2026-09-27.png).

That r4 run exposed an unfinished offline view: pairing wording and a raw transport error. The later connection-recovery checkpoint below corrects this UI and retains the earlier screenshot as the reproduced problem. The connection fault is local and controlled, not physical Wi-Fi/cellular evidence.

Native **Pause reminders** clears both posted alerts and the persistent Expo notification store before the server releases the route. Selecting the same phone again advances the routing generation; every persisted native alarm then belongs to the new generation. The helper reads only notification identifier keys from the disposable emulator's known Expo preferences file; it does not persist credentials or serialized notification bodies.

With the default 8443 fixture and 8444 fault proxy running as documented above:

```sh
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=offline-plan \
  node tools/android_native_smoke.cjs
```

This mode waits for a real due time and actual OS delivery, with a five-minute observation window after the dose is due. It restores the direct emulator reverse mapping and clears the proxy fault in `finally`. Stop the temporary proxy after testing. The evidence contains the source hashes used for the run; the separately dispatched revocation helper was subsequently refined to handle a retained service address and is not executed by this mode.

## Native access revocation and fresh pairing

The [revocation run](evidence/android-alert-revoked-2026-09-27.json) starts with confirmed care notes and actual scheduled native alerts. Revoking the selected phone through the owner's authenticated API causes the foreground native app to hide care and recording controls, clear its persistent scheduled notifications and release its reminder route. The dashboard reports revoked access with foreground readiness and background coverage disabled; no app notification remains posted. A force-stop/reopen still shows the access-denied view and adds no care record. [Denied native view](evidence/android-revoked-access-2026-09-27.png).

The user then explicitly chooses **Start a new pairing** in the app, obtains a new one-use code and receives owner approval. This creates a different device identity while preserving the revoked record. Selecting the new phone and enabling alerts schedules only identities belonging to that new device and routing generation. The four pre-existing care notes remain unchanged. [Reconnected settings](evidence/android-replacement-pairing-2026-09-27.png). This is native unpair/re-enrollment on the same emulator installation, not uninstall/reinstall or physical Keystore validation.

Reproduce with the direct 8443 reverse mapping, the prepared fictional fixture and the installed verification APK:

```sh
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=revoked \
  node tools/android_native_smoke.cjs
```

The fixture keeps the old revoked row and selects the newly approved device for subsequent checks. Owner revocation here is received while online in the foreground; the offline/terminated scenario has separate evidence below. Both original modes use the existing r4 verification APK; no production app code or new binary was needed for those checks.

## Offline revocation and retained native alerts

The [complete nine-check run](evidence/android-offline-revocation-2026-09-27.json) uses the unchanged r5 verification APK and the fictional loopback TLS fault proxy. It schedules an exact dose alert, disconnects the phone, confirms normal background-process termination without force-stop, queues the due reminder, and revokes the phone through the owner's API.

Revocation marks access and reported readiness as denied immediately. It deliberately retains the selected-phone route until that phone attests local cleanup; an attempted remote handoff is rejected with 409. This preserves the existing rule that an offline phone's local alerts and downloaded speech must be stopped before another companion is selected. The pending command has no audio access or playback acknowledgement. The phone still retains its previously scheduled local alert because it has not received the revocation.

Android posts that exact alert with generic text, without medicine or dose instructions. Raw delay is 86.591 seconds, approximately 86.323 seconds after clock adjustment. Tapping while offline opens **Cannot reach Parse**, without care details, recording controls or old reminder playback. Reconnecting automatically shows **Phone access stopped**, clears posted and scheduled local alerts and releases the route. Denial survives force-stop/reopen. [OS alert](evidence/android-offline-revocation-alert-2026-09-27.png), [offline opening](evidence/android-offline-revocation-offline-2026-09-27.png), [revoked view](evidence/android-offline-revocation-denied-2026-09-27.png).

Deliberate native re-pairing and owner approval then create a different device identity. Only the new phone's generation-15 alarms remain scheduled; the old revoked identity and all five care notes are retained. The stale command is cancelled during route cleanup without audio access, and its dose remains unconfirmed. [Re-paired Settings](evidence/android-offline-revocation-repaired-2026-09-27.png). Direct routing and the original lock setting are restored, transient native audio is absent, and the temporary proxy is stopped after testing.

With the documented fictional fixture and loopback fault proxy running, reproduce using:

```sh
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=offline-revoked \
  node tools/android_native_smoke.cjs
```

Earlier attempts remain separate: [an incorrect immediate-route-release expectation](evidence/android-offline-revocation-routing-attempt-2026-09-27.json), [a redundant Retry tap that raced automatic reconnection](evidence/android-offline-revocation-retry-attempt-2026-09-27.json), and [a proxy failure during native unpairing](evidence/android-offline-revocation-delete-attempt-2026-09-27.json). The fault proxy lacked DELETE forwarding and returned 501; it now forwards DELETE through the same bounded, loopback-only handler. An [unauthenticated probe](evidence/android-fault-proxy-delete-2026-09-27.json) receives the backend's normal 401 response, and the final complete native run passes re-pairing through that proxy. No production app or backend change was required.

These are Android emulator, controlled-network and local-notification results. They do not establish physical radio failures, iOS behavior, live push, physical-device alert timing or complete E08/E09 acceptance.

## Native connection recovery UI

A saved installation now has a distinct **Cannot reach Parse** state at cold startup. **Retry connection** invokes the same serialized foreground sync used by periodic polling; it checks current enrollment and loads current care before exposing recording. It preserves the protected identity. A new enrollment request is made only when the enrollment endpoint reports that no authorized enrollment exists, using the same installation credential and idempotency key. Access denial retains its separate care-clearing and cleanup behavior.

If a refresh fails after care has loaded, the warning appears at the top and explicitly labels the retained care details as previously loaded. Raw native/network errors from connection synchronization are replaced with actionable connection wording. Successful synchronization clears the connection warning; unrelated operation failures retain their own state.

Five new full-app regressions cover cold enrollment/home failures, no replacement enrollment or automatic care commitment on retry, a pending retry shared with periodic polling, revocation during reconnect, warm automatic recovery and a not-yet-registered installation. TypeScript and all **109 mobile tests** pass: 25 unit and 84 app/hook/HTTP/storage tests. An intermediate JSX placement error was caught by Metro, corrected, and followed by a fresh typecheck, complete mobile test run and successful builds.

The [rebuilt native run](evidence/android-connection-recovery-2026-09-27.json) uses the existing paired Android emulator through the isolated TLS fault proxy. It passes cold disconnected startup, an actual tap on Retry connection, warm disconnected refresh and automatic foreground recovery. The selected device, routing generation, existing note IDs and all dose report states remain unchanged. [Cold disconnected screen](evidence/android-connection-offline-2026-09-27.png), [recovered phone](evidence/android-connection-recovered-2026-09-27.png), [warm warning](evidence/android-connection-warm-offline-2026-09-27.png). The report verifies the installed APK digest and source hashes. This is native Android emulator/controlled-network evidence; physical networks, live speech and iOS remain separate gates.

Reproduce with the default fictional fixture and fault proxy running:

```sh
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_CONNECTION_ONLY=1 \
  node tools/android_native_smoke.cjs
```

The helper restores direct routing and clears the fault in `finally`; stop the proxy after the check. It reuses the existing care records and paired identity.

The normal r5 preview is `runtime/releases/parse-companion-android-arm64-preview-2026-09-27-r5.apk` (31,319,647 bytes; SHA-256 `f144dba7c46e6ce18e9cddd4dbb14625af0edc74d4a6c0eedbc7152e966b0c82`). It builds, verifies its signature, installs and cold-launches without Metro, with a matching installed digest and no observed process-scoped native/JavaScript errors. It uses the standard debug key and excludes the verification fixture resources. [Artifact and launch report](evidence/android-preview-r5-2026-09-27.json), [normal pairing screen](evidence/android-preview-r5-pairing-2026-09-27.png). Earlier alert and recovery results remain tied to their recorded APKs; the r5 binary is not claimed to have rerun every previous native scenario.

## Android incoming-call interruptions

The [complete native call run](evidence/android-call-interruptions-2026-09-27.json) uses the unchanged r5 verification APK, Android's simulated GSM modem and the native dialer. It verifies both ringing and answered states through `dumpsys telephony.registry`; no external telephone call is made.

Answering the simulated call cancels an active native recording and deletes its cache file without uploading it. Returning to Parse leaves recording idle and care notes unchanged. Ringing alone did not cancel capture in this run, so this evidence is specifically for an answered call. [Recording while ringing](evidence/android-call-recording-ringing-2026-09-27.png), [return after cancellation](evidence/android-call-recording-return-2026-09-27.png).

A real scheduled reminder plays an 18-second fixture tone, with Android reporting an active player and the server receiving `playback_started`. Incoming ringing stops that player while Parse is still the resumed activity, before Answer is tapped. Cached speech is removed and the server records `interrupted`, without `playback_completed`. Returning and restarting do not replay the reminder, add notes or change its unconfirmed medication report. [Playback interrupted during ringing](evidence/android-call-playback-ringing-2026-09-27.png), [return to Parse](evidence/android-call-playback-return-2026-09-27.png). Host audio is disabled; physical-phone behavior and acoustic audibility remain unverified.

Reproduce with the prepared fictional fixture, the paired verification installation, direct 8443 reverse mapping and the documented Playwright dependency:

```sh
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_CALLS_ONLY=1 \
  node tools/android_native_smoke.cjs
```

The helper requires the inspected 1080 × 2400 emulator layout. UIAutomator omits the nonfocused incoming-call overlay, so it captures the current screen and taps the observed Answer coordinates after the animation settles, then requires actual active-call state. It restores the original fixture tone, ends only its own simulated call and backgrounds Parse in cleanup.

Three earlier harness attempts remain recorded separately: [the modem-list attempt](evidence/android-call-modem-attempt-2026-09-27.json) incorrectly relied on `gsm list`, which returned empty while Android was ringing; [the key-event attempt](evidence/android-call-answer-attempt-2026-09-27.json) did not answer the call; [the partial UI attempt](evidence/android-call-partial-2026-09-27.json) passed recording cancellation but tapped Answer too early during the playback case. The final complete run uses telephony state and the settled native Answer control. These harness corrections required no production app change.

## Paired Android care at 200% text size

The [complete large-text run](evidence/android-large-text-2026-09-27.json) uses the unchanged r5 verification APK at Android `font_scale=2.0`, 1080 × 2400 pixels and 420 dpi. It exercises actual native recording, read-back, explicit confirmation, all four care tabs and the reachable Settings actions. The report includes source/APK hashes and measured bounds for each exercised control. Every measured target exceeds 48 logical units in each dimension; the talk control is approximately 363 × 206, the Cancel button 363 × 70, and the shortest measured tab about 66 units tall.

Cancel is reached and tapped 5.130 seconds after starting the test's recording action. Native cleanup deletes the recording without an upload or new note. A subsequent native recording returns a scripted proposal whose enlarged read-back includes the fictional note and its sharing recipient. Confirm and Cancel this update are both reachable; explicit Confirm saves exactly one phone-sourced note in the already-open permitted caregiver page, while the restricted account cannot see it. Restart retains exactly one copy. [Talk](evidence/android-large-text-talk-2026-09-27.png), [stopped capture](evidence/android-large-text-cancelled-2026-09-27.png), [read-back](evidence/android-large-text-review-2026-09-27.png), [confirmation controls](evidence/android-large-text-confirm-controls-2026-09-27.png), [caregiver result](evidence/android-large-text-caregiver-2026-09-27.png).

The native tabs wrap and remain operable: [Today](evidence/android-large-text-today-2026-09-27.png), [Medicines](evidence/android-large-text-medicines-2026-09-27.png), [Care](evidence/android-large-text-care-2026-09-27.png), [Settings](evidence/android-large-text-settings-2026-09-27.png). The [permission, dashboard and unpair actions](evidence/android-large-text-settings-actions-2026-09-27.png) are fully reachable and measured, without activating those external/destructive actions. Screenshots were visually reviewed. Long pages require vertical scrolling; this is not evidence for every possible care text or device size.

Reproduce with the prepared fictional fixture, paired verification installation and documented Playwright dependency:

```sh
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_LARGE_TEXT_ONLY=1 \
  node tools/android_native_smoke.cjs
```

The helper restores the original font scale and backgrounds the app in `finally`. After the passing run, the scale was independently checked at 1.0 and the known native cache contained no recording/reply files. No production app code changed. Earlier harness failures are preserved: [initial search](evidence/android-large-text-first-attempt-2026-09-27.json), [scroll trace](evidence/android-large-text-scroll-attempt-2026-09-27.json), [immediate cleanup assertion](evidence/android-large-text-cleanup-attempt-2026-09-27.json), [status wording assertion](evidence/android-large-text-status-attempt-2026-09-27.json). The final helper avoids flinging past controls, handles Android's inverted offscreen bounds, waits for native cleanup and checks the actual Stop completion message.

This covers a paired Android emulator at 200% text, using scripted speech and fixture tones with host audio disabled. It does not establish TalkBack/VoiceOver behavior, physical accessibility, iOS layout, acoustic audibility or the full E10 acceptance gate.

## Phone-sized visit-summary workflow

A [four-check browser run](evidence/phone-viewport-summary-2026-09-27.json) at 390 × 844 with mobile/touch emulation uses actual previously confirmed phone-sourced notes from this native fixture. The owner prepares a draft, checks its source links, omits one source, saves a review and explicitly shares a read-only copy. The omitted wording is absent, retained wording is present, and the owner/restricted/public pages have no horizontal overflow. The restricted caregiver has no prepare/share controls. A separate share with a 60-second lifetime becomes unavailable after real server-clock expiry; revoking the original link also makes it unavailable. [Read-only phone layout](evidence/phone-viewport-summary-2026-09-27.png), [revoked view](evidence/phone-viewport-summary-revoked-2026-09-27.png). This is desktop Chrome 153 emulation, not Android/iOS browser or physical-phone acceptance.

The [first attempt](evidence/phone-viewport-summary-before-route-2026-09-27.json) reached the owner controls but could not open the public page: the test fixture's static mount lacked the `/shared/summaries/{token}` entry route. The production Caddy configuration already falls back to `index.html`. The local fixture now explicitly serves the same built entry page for that route and leaves API paths unchanged.

The fixture's new `resume` mode checks the existing fictional patient/owner markers and original loopback TLS origin before reopening its database. It does not reseed. [The restart audit](evidence/android-fixture-resume-2026-09-27.json) confirms preservation of all existing record identities and metadata, including the installed phone's pairing. Stop only the known fixture process and verify it has exited before resuming:

```sh
backend/.venv/bin/python tools/android_native_fixture.py resume \
  --data-dir "$PARSE_NATIVE_FIXTURE_DIR"
node tools/browser_phone_summary.cjs
```

Keep the documented Playwright dependency configured. `serve` still refuses an existing database; `prepare` still requires a new directory. The notification runs above used the earlier committed fixture source before this restart; their source hashes identify that version. The summary report identifies the updated fixture source.

## Caption-only native demo

`runtime/native-care-20260927/parse-native-demo-captioned.mp4` is a 90-second, 1440 × 900, 30 fps H.264 recording with no audio track. It shows the actual Android emulator app, note correction and confirmation, then a captured caregiver dashboard showing the saved phone-sourced note. Captions label the emulator, scripted speech and fictional data throughout; the app portion plays at 1.16× speed. This is native app evidence, not a physical-phone/live-speech or hardware-pendant film.

The raw emulator recording, edit script and render filter are retained alongside it. The report above records the final video's digest and size. The video was decoded end to end without errors and representative frames were visually reviewed. Media/APK binaries remain local rather than being committed to Git.

## iOS build route

Install full Xcode and its simulator runtime, then select that Xcode developer directory. Command Line Tools alone cannot compile or run the iOS application. From `mobile/`, use `npm run prebuild -- --platform ios` and `npm run ios` with the chosen simulator or development device. Physical-device installation requires the team's signing arrangement. The host used for the Android checkpoint has no full Xcode, so no iOS compile or installation is claimed.

Both platforms remain in scope. Configure the reachable service, live speech provider and each platform's native push credentials before collecting the physical-device evidence in [the setup guide](Phone-Companion-Setup.md) and [the PRD](Phone-Companion-PRD.md).

## Clock and time-zone reminder correction

The original r5 Android app reproduced a reminder defect: moving the running emulator's clock back five minutes left both registered RTC alarms **300,008.5 ms late** relative to their server due times. Foreground synchronization was still working and the two notification identities remained unchanged; the scheduler only replaced alarms when the plan revision changed or an ID disappeared. [Before-fix evidence](evidence/android-clock-before-fix-2026-09-27.json).

The production hook now rebuilds on foreground resume, device time-zone change, or a device/server clock-offset change larger than five seconds. The tolerance prevents minor response-time variation from rebuilding every poll; comparison against the last rebuild also catches cumulative drift. A refresh requested during an outstanding native operation remains pending. Generic content, occurrence/routing identities, serial cleanup and confirmation rules are preserved.

The r6 verification APK (`15ad0b843daad17bd030dad58e8db29d9269f2317707db3236dec80484b33c3e`) passed five native checks including pairing reuse: running-clock changes of minus/plus five minutes, changing the device zone from Asia/Singapore to Pacific/Honolulu, and a background clock change followed by foreground resume. AlarmManager timestamps and the native persistent identity store were inspected directly. Corrected timestamps stayed within **22.5 ms** of the initial registered instants, after adjusting for measured phone/host clock offset; the server schedule revision, route generation, five notes, all medication report states and the two native identities remained unchanged. These measurements concern **scheduled timestamps, not notification arrival latency**. [Complete report](evidence/android-clock-timezone-2026-09-27.json), [reviewed native screen](evidence/android-clock-timezone-2026-09-27.png).

The test changes only the guarded disposable emulator, never the host clock. Automatic time and time-zone settings and Asia/Singapore were restored, and a bounded native-alarm check verified corrected timestamps after restart. The [first fixed run](evidence/android-clock-first-fixed-2026-09-27.json) passed the scenario checks but sampled cleanup too early; its three-and-a-half-second startup sleep was replaced with observation of the actual restored alarms before the final run. No additional production change was needed.

Run against an existing paired fictional fixture:

```sh
PARSE_NATIVE_FIXTURE_DIR="$PWD/runtime/native-care-20260927" \
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_CLOCK_ONLY=1 \
node tools/android_native_smoke.cjs
```

`tools/android_native_clock.cjs` refuses alarms less than one hour away, preserves the fixture's care records, records source/APK hashes and checks actual server-reported schedule revisions. Five new production-hook regressions cover clock changes, time zones, foreground rebuilding, small timing variation and an overlapping foreground refresh. TypeScript and all **114 mobile tests** pass (25 unit + 89 app/hook/HTTP/storage tests). The normal r6 APK also builds, verifies its signature, installs with a matching digest and cold-launches without fixture trust or observed process-scoped errors.

This does not verify iOS or physical-device scheduling, live push, or clock changes while an unreachable/terminated app cannot refresh. Offline notifications remain generic; OS batching and Focus/battery restrictions can still delay delivery.

## Native Android deep Doze

The unchanged r6 verification APK passed a forced deep-Doze notification run on the Android 16 emulator. Its normal configuration had both deep and light idle disabled, so this test explicitly enabled deep idle, waited for actual screen-off/Asleep state, then entered `IDLE`. PowerManager reported `mDeviceIdleMode=true` at the due time and when the OS notification was observed. Parse was not allowlisted. The emulator remained connected to its virtual charger; this is a forced OS-state test, not physical battery consumption or Android Battery Saver evidence.

An owner-created fictional medication plan produced a native notification with the expected dose/route identity. At the due time, the real scheduler queued the associated reminder. While Doze was active, the phone did not fetch its audio or submit a playback acknowledgement. Android then posted **“Open Parse to check your care schedule.”** during deep idle, **78.239 seconds after the due timestamp, or 77.884 seconds after clock adjustment**. No medicine name or instruction appeared in the alert.

After leaving Doze, the test opened that exact OS notification through the native UI. Its `opened` event was recorded; the current reminder then produced `received`, `playback_started` and `playback_completed` acknowledgements through the native fixture-tone player. The medication remained `unconfirmed`, and the care-note count did not change. Actual deep/light idle enablement, force state, screen state and charger state were restored and checked.

[Complete source/APK/state report](evidence/android-doze-2026-09-27.json) · [visible restriction warning](evidence/android-doze-scheduled-2026-09-27.png) · [generic OS notification](evidence/android-doze-notification-2026-09-27.png) · [opened app](evidence/android-doze-opened-2026-09-27.png).

An [earlier harness attempt](evidence/android-doze-screen-attempt-2026-09-27.json) checked the idle controller before Android finished its screen-off transition; it stopped before the due time and restored the original settings. The final harness waits for the actual transition. No production application or backend change was required.

```sh
PARSE_NATIVE_FIXTURE_DIR="$PWD/runtime/native-care-20260927" \
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=doze \
node tools/android_native_smoke.cjs
```

The harness retains Doze until delivery or two minutes after the due time, then allows a bounded recovery window; this run delivered during Doze, so the deferred-until-wake branch was not exercised. Four checks passed. The source/API/OS-state evidence is specific to this emulator and r6 APK: no physical-phone, audible-speech, live-push, DND, Battery Saver/OEM restriction or iOS acceptance is claimed.

## Native Android Do Not Disturb

The unchanged r6 verification APK was exercised under Android 16's actual `ZEN_MODE_NO_INTERRUPTIONS` policy (interruption filter 3), with Parse in the background. A checked fictional plan scheduled the exact local occurrence. The app displayed its existing warning about Focus/battery delays before the test enabled DND. No notification-policy access or channel exemption was granted.

Android posted the generic **“Open Parse to check your care schedule.”** entry **85.576 seconds, or 85.300 seconds after clock adjustment,** after its due timestamp. Its matching `NotificationRecord` reported `mIntercept=true`, suppressed visual effects 159, and `mBypassDnd=false` on `parse-care`. The entry remained available in the notification shade under this policy. Before opening, the associated server command was queued with no audio access or playback acknowledgements.

An actual tap on that entry reopened Parse while DND remained active. The refreshed reminder produced native fixture-tone player callbacks; medication remained `unconfirmed` and the number of care notes was unchanged. Host audio was disabled, so callback completion establishes neither audible playback nor acoustic silence. Original DND mode, interruption filter and effective policy were restored and verified.

[Complete source/APK/state report](evidence/android-dnd-2026-09-27.json) · [restriction warning](evidence/android-dnd-scheduled-2026-09-27.png) · [generic notification with DND active](evidence/android-dnd-notification-2026-09-27.png) · [opened app](evidence/android-dnd-opened-2026-09-27.png).

The [first attempt](evidence/android-dnd-policy-attempt-2026-09-27.json) passed the four behavior checks but failed a raw-string restoration assertion: Android added deprecated screen-on/off aggregate flags while retaining the same specific visual restrictions. The helper now compares the effective restrictions and every other policy field. Android documents those [legacy flag mappings](https://developer.android.com/reference/android/app/NotificationManager.Policy#suppressedVisualEffects). Checks against the recorded policies accept that equivalence and reject changed allowed callers or notification-list suppression. A fresh full native run then passed, including restoration. No production app/backend change or new APK was needed.

```sh
PARSE_NATIVE_FIXTURE_DIR="$PWD/runtime/native-care-20260927" \
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=dnd \
node tools/android_native_smoke.cjs
```

This is a scheduled local-alert and Android interruption-policy check. It does not establish physical audibility, actual APNs/FCM, iOS Focus behavior, Battery Saver/OEM restrictions or full E08 acceptance.

## Native Android Battery Saver

The unchanged r6 verification APK passed four native checks with Android 16 Battery Saver enabled. The guarded disposable-emulator harness simulated an unplugged 15% battery, enabled low-power mode and verified the real PowerManager full-Saver state and AlarmManager's `Force all apps standby: true`. The active full policy included background checks and the firewall; Parse had no permanent power exemption. The device remained awake and deep Doze was not forced, separating this case from the earlier Doze test.

A checked fictional medication plan produced the exact route/occurrence-matched native alert. The actual scheduler queued its reminder at the due time. Before opening, that command had no audio access or playback acknowledgements. Android posted **“Open Parse to check your care schedule.”** while Battery Saver remained active, **80.918 seconds late, or 80.585 seconds after clock adjustment**. The alert contained no medicine name or instruction. This is an observed delivery time, not a measurement of how much delay Battery Saver caused.

The harness tapped the actual notification while Saver was still active. Parse resumed, fetched the current reminder and reported native fixture-tone playback callbacks. Medication remained `unconfirmed`; the same five notes remained. The final cleanup disabled Saver, reset the simulated battery to the emulator's hardware values, restored the original sticky setting (absent), and compared the full original/restored policy and battery state. No application/backend change or new APK was required.

[Complete source/APK/power-state report](evidence/android-battery-saver-2026-09-27.json) · [visible restriction warning](evidence/android-battery-saver-scheduled-2026-09-27.png) · [generic notification at simulated 15% charge](evidence/android-battery-saver-notification-2026-09-27.png) · [opened app with Saver still active](evidence/android-battery-saver-opened-2026-09-27.png).

```sh
PARSE_NATIVE_FIXTURE_DIR="$PWD/runtime/native-care-20260927" \
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=battery-saver \
node tools/android_native_smoke.cjs
```

The bounded harness keeps Saver active until delivery or two minutes after the due time, then allows recovery after releasing the restriction. This run delivered before release, so the deferred-until-release branch was not exercised. The check establishes AOSP emulator policy behavior with local HTTPS, scripted interpretation and tone replies. It does not establish battery life/consumption, physical sound, manufacturer-specific restrictions, live push, iOS behavior or full E08 acceptance.

## Native Android PIN-protected lock screen

The unchanged r6 verification APK passed five checks behind Android 16's actual PIN keyguard. The guarded emulator helper first verified that no credential existed, then installed a fictional test PIN and turned the screen off. `secure`, keyguard showing and input restriction were all true at the due time and when the exact notification was observed. The existing lock-screen settings permitted private notification content; the app itself still supplied only the generic prompt.

The scheduler queued the dose reminder while locked. Android posted **“Open Parse to check your care schedule.”** **97.196 seconds after the due timestamp (96.8565 seconds after clock adjustment)**. No medicine name or instruction was present. A tap on this actual lock-screen notification displayed the system PIN prompt. At that point, native view inspection found no Parse care UI, and the command still had no audio access or playback acknowledgements. The OS screen capture at the PIN prompt was black, so it is not presented as a readable PIN-screen screenshot; the [native hierarchy](evidence/android-secure-lock-pin-required-2026-09-27.xml) records `Enter PIN`, the PIN field and system keypad before entry.

Typing the fictional PIN through Android's input UI unlocked the keyguard and resumed Parse without directly launching the activity or dismissing the secure lock. The app fetched the current reminder and emitted fixture-tone playback callbacks. Medication stayed `unconfirmed`, and the same five notes remained. Cleanup removed the temporary PIN and verified the original keyguard and notification settings exactly.

[Five-check source/APK/OS-state report](evidence/android-secure-lock-2026-09-27.json) · [generic alert behind the PIN lock](evidence/android-secure-lock-notification-2026-09-27.png) · [opened app](evidence/android-secure-lock-opened-2026-09-27.png).

A separate [post-cleanup restart audit](evidence/android-secure-lock-restart-2026-09-27.json) verifies background process absence before a cold activity launch, a different new process, the paired native home and the same selected device/generation. [Restarted home](evidence/android-secure-lock-restart-2026-09-27.png) · [native view hierarchy](evidence/android-secure-lock-restart-2026-09-27.xml). This confirms that this temporary PIN change did not lose the installation's pairing; it is not a full Keystore/reinstall or device-security assessment.

```sh
PARSE_NATIVE_FIXTURE_DIR="$PWD/runtime/native-care-20260927" \
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=secure-locked \
node tools/android_native_smoke.cjs
```

For the supplemental restart check, background the restored app, use normal `am kill` and verify process absence, then start its activity and inspect the paired home and server-selected device. No app data clearing or re-enrollment is involved. This run used the Android emulator, local HTTPS, scripted interpretation and tone replies. Physical PIN/biometric flows, audible speech, iOS and full E08 acceptance remain unverified. The host still has only Command Line Tools; a current `xcrun --find simctl` check cannot find the iOS Simulator tools. No production app/backend change or new APK was required for this verification.


## Native Android recent-apps dismissal

The unchanged r6 verification APK passed four checks after an actual upward swipe of its **Parse local verification** card in Android 16's recent-apps view. The harness selects that exact native card and leaves other tasks alone. Android removed task 103 and its process (PID 7284); the package remained `stopped=false`. The exact occurrence remained registered in native notification storage. This case uses neither `am kill` nor `force-stop`.

At the due time the app still had no task or process. The actual scheduler queued its current reminder, with no audio access or playback acknowledgements. Android later started PID 8285 to post the generic **“Open Parse to check your care schedule.”** alert, without recreating an app task. Posting was **75.428 seconds after the due time (75.134 seconds after clock adjustment)**. No medicine-specific text appeared in the alert.

Tapping that actual notification created a new Parse task (105). The harness waits separately for the server's native-player acknowledgements: `received`, `playback_started`, then `playback_completed`. Medication remains `unconfirmed` and all five care notes remain unchanged. Opening is therefore distinct from playback and from a medication report. An initial run captured the open event before the first reminder poll; a later read confirmed completion, and the final rerun explicitly awaited it. No production app/backend change or new APK was needed.

[Complete source/APK/task/notification report](evidence/android-recents-2026-09-27.json) · [exact card before dismissal](evidence/android-recents-card-2026-09-27.png) · [after dismissal](evidence/android-recents-dismissed-2026-09-27.png) · [generic notification](evidence/android-recents-notification-2026-09-27.png) · [opened app after playback](evidence/android-recents-opened-2026-09-27.png).

```sh
PARSE_NATIVE_FIXTURE_DIR="$PWD/runtime/native-care-20260927" \
PARSE_NATIVE_RESUME_PAIRED=1 PARSE_NATIVE_ALERT_STATE=recents \
node tools/android_native_smoke.cjs
```

This is a controlled AOSP emulator check using local HTTPS, scripted interpretation and tone replies with host audio disabled. It does not establish physical-device audibility, manufacturer-specific task dismissal, force-stop recovery, iOS behavior or full E08 acceptance.

## Native Android TalkBack recording and cancellation

The unchanged r6 verification APK passed four checks with an actual TalkBack service and offline English eSpeak voice on the Android 16 emulator. Enabling the screen reader overrides the saved hold preference with tap mode. Virtual touchscreen swipe gestures reach the labelled recording button without recording; a double-tap starts native capture. Further swipes reach **Cancel recording**, and a second double-tap stops capture. The transient audio file is removed and the server upload count stays at **31**. All six original accessibility/TTS settings and the original saved tap preference are restored afterward.

[Four-check report with source/APK hashes and focus sequence](evidence/android-talkback-2026-09-27.json) · [tooling provenance](evidence/android-talkback-tooling-2026-09-27.json) · [record button focused](evidence/android-talkback-control-2026-09-27.png) · [recording](evidence/android-talkback-recording-2026-09-27.png) · [Cancel focused](evidence/android-talkback-cancel-2026-09-27.png) · [cancelled](evidence/android-talkback-cancelled-2026-09-27.png) · [original settings restored](evidence/android-talkback-restored-2026-09-27.png).

The screenshots retain TalkBack's onboarding tip and debug speech overlay; some content is obscured. The service's accessibility-node dump identifies the focused controls, and native cache/server observations establish cancellation. Host audio is disabled, so this run does not verify audible prompts, speech quality, physical touch gestures, proposal review/confirmation with a screen reader, iOS VoiceOver or complete E10 acceptance.

### Tooling and reproduction

Google's TalkBack source is pinned at `229212fdf5842191d0a93fc95d9ca1423b346866`, with no tracked source changes. The debug APK uses Gradle 8.13, AGP 8.11.1, JDK 17 and SDK 36. Its isolated NDK 21 launcher runs the original compiler through the host's installed Rosetta and uses the existing NDK 27 archiver to avoid a host-tool crash. These adaptations affect verification tooling, not Parse. The provenance report records their hashes and the F-Droid eSpeak 1.52.0 APK/signature inspection. Neither third-party APK is committed.

Use only the disposable, rooted `emulator-5580` at 1080 × 2400 with the existing fictional HTTPS fixture under `runtime/native-care-20260927`. Install/initialize the pinned TalkBack and eSpeak builds, select TalkBack's VERBOSE developer logging, then disable TalkBack before the run. Preserve the original six secure settings in `runtime/android-accessibility/original-settings.json` and the original Parse preference in `original-parse-tap-mode.json`; this harness requires the documented baseline of accessibility disabled, no selected service/TTS settings, and saved tap mode enabled. It temporarily changes the saved preference to hold to test the screen-reader override. The tooling provenance file must be present under the same directory.

```sh
runtime/android-build/sdk/ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android26-clang \
  -O2 -Wall -Wextra -Werror tools/android_emulator_touch.c \
  -o runtime/android-accessibility/parse-emulator-touch
python3 tools/android_native_talkback_probe.py
```

The touch helper checks the emulator property, input-device name and coordinate range before writing events. It sends fixed touch exploration, swipe and double-tap gestures through the virtual touchscreen. Ordinary `adb shell input swipe` did not move TalkBack focus in the initial attempt. The final probe also verifies Parse owns the foreground window after TalkBack initialization and waits for asynchronous focus/auto-scroll before the next gesture. An earlier 0.2-second snapshot missed the actual Cancel focus event and mistakenly advanced past it; TalkBack logs established that this was a harness timing error. A separate startup attempt encountered TalkBack onboarding, prompting the foreground guard. UIAutomator is used only before enabling and after disabling TalkBack; active focus observations come from TalkBack itself.

The final run passed on the existing APK without changes to production app or backend code. The helper rebuild matches its recorded binary hash, Python syntax validation passes, and the exported source hashes match the committed files.
