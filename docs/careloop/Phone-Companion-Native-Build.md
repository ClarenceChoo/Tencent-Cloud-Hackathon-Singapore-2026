# Parse native build and installation

The phone source lives in `mobile/`. Generate its Android and iOS projects from the checked-in Expo configuration; the generated directories, SDK downloads, signing files and application binaries stay out of Git. [Acceptance status](Phone-Companion-Verification.md) distinguishes compilation, emulator checks and physical-phone evidence.

## Verified Android preview

On 27 September 2026, the ARM64 APK compiled, passed APK signature verification, installed and cold-launched on the Android 16 AOSP emulator without Metro. The final binary is 31,316,823 bytes, SHA-256 `51bcb7a7bb8d0e316b34bbfd85b4fb9fe6de61371e42b44895f0a63c93fac221`. A local copy is retained at `runtime/releases/parse-companion-android-arm64-preview-2026-09-27.apk`, with an adjacent checksum file. Binaries and toolchains are not committed or published as a release.

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

## iOS build route

Install full Xcode and its simulator runtime, then select that Xcode developer directory. Command Line Tools alone cannot compile or run the iOS application. From `mobile/`, use `npm run prebuild -- --platform ios` and `npm run ios` with the chosen simulator or development device. Physical-device installation requires the team's signing arrangement. The host used for the Android checkpoint has no full Xcode, so no iOS compile or installation is claimed.

Both platforms remain in scope. Configure the reachable service, live speech provider and each platform's native push credentials before collecting the physical-device evidence in [the setup guide](Phone-Companion-Setup.md) and [the PRD](Phone-Companion-PRD.md).
