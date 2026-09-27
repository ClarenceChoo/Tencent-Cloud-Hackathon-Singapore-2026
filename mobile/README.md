# Parse native companion

React Native/Expo development build for iPhone and Android, sharing Parse's existing FastAPI care system.

This branch is still implementing the full phone companion. Start with the [setup guide](../docs/careloop/Phone-Companion-Setup.md) and [requirement/evidence ledger](../docs/careloop/Phone-Companion-Verification.md). Native microphone and spoken-reply source is present; native build/device verification, active companion routing and background reminders remain unfinished.

```sh
npm ci
npm run typecheck
npm test
npm run prebuild
npm run ios     # full Xcode required
npm run android # Android SDK and supported Java required
```

The phone's private installation token is generated locally and stored in OS secure storage. The owner approves the separate expiring code in the existing dashboard. No secret is configured in the application bundle.
