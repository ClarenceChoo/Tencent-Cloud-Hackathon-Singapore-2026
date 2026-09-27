# Parse native companion

React Native/Expo development build for iPhone and Android, sharing Parse's existing FastAPI care system.

This branch is still implementing the full phone companion. Start with the [setup guide](../docs/careloop/Phone-Companion-Setup.md), [native build guide](../docs/careloop/Phone-Companion-Native-Build.md) and [requirement/evidence ledger](../docs/careloop/Phone-Companion-Verification.md). An ARM64 Android preview APK compiles and opens in an Android 16 emulator. The Android native recording, correction and caregiver flow has local fixture evidence. Voice, routing and background-alert source is present; iOS compilation, complete native acceptance, physical-device and live-provider verification remain unfinished.

```sh
npm ci
npm run typecheck
npm test
npm run prebuild
npm run ios     # full Xcode required
npm run android # Android SDK and supported Java required
```

The phone's private installation token is generated locally and stored in OS secure storage. The owner approves the separate expiring code in the existing dashboard. No secret is configured in the application bundle.
