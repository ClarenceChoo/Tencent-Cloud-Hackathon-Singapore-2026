# Fictional offline-vault primitive probe

This isolated Expo fixture supports the feasibility study for [issue #15](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/15). It is outside production imports and uses the repository's existing pinned dependencies. It records no microphone audio, signs into no account, and sends no upload. The bytes are a one-second synthetic tone and fictional journal text. The app displays only operation names, timestamps and boolean observations; key material and plaintext are not reported.

The application identifier is **sg.parse.vaultprobe**, separate from **sg.parse.companion**. Its key service and exact file directory belong only to the probe. Its reset/cleanup buttons delete only that separate app's probe key and files. Use a dedicated test device with an operator present for lock, kill, reboot, reinstall and backup exercises.

## Preparation

From the repository root, prepare a new disposable project:

```sh
backend/.venv/bin/python tools/prepare_offline_vault_probe.py --out runtime/offline-vault-probe
```

The preparer copies the fixture and pinned dependency manifests, reuses the installed mobile dependencies, and gives the fixture its own Expo config. It does not build, install, reset a device or run an external process. Open the generated project with the Expo development tooling when a dedicated physical Android or iOS test device and its native toolchain are available. Verify the **Parse Vault Probe** name and **sg.parse.vaultprobe** identifier before installing. An Expo Go, web or emulator run is not a physical-device G1 pass.

## Reproducible primitive observations

1. Confirm that this is the dedicated fictional probe app. Use **Reset and prepare fictional key**, then **Write encrypted journal checkpoint**. The key is protected by the pinned SecureStore API with authentication requested and device-only, unlocked keychain accessibility on iOS.
2. Use **Inspect**. Record whether both ciphertext files exist and their plaintext can be authenticated and read. **Check tamper and identity rejection** alters a copy of the sealed bytes and changes the authenticated installation identity; both operations should be rejected. The original file is preserved.
3. For each interruption stage, reset first, choose **temporary ciphertext write**, **audio rename**, or **journal checkpoint**, terminate the probe process through the device tooling, and relaunch it. Use **Inspect** before preparing any new key. A partial pair is reported as incomplete. This fixture deliberately does not implement production orphan reconciliation or assert crash durability.
4. Exercise lock/relock and reboot with the operator, inspecting before creating any new data. Record whether authentication/key access is unavailable or allowed in each state. A foreground UI check alone cannot prove denial before first unlock or in a background execution path.
5. Capture device model, OS, lock configuration, native build digest, exact checkpoint, key-access observation and result. Keep key bytes and backup contents out of the report. Reinstall/reset/backup exercises require a dedicated device and both cloud and device-transfer paths on each enabled platform.

## Limits and gate status

The fixture tests an SDK composition candidate, not a selected vault. AES-GCM rejects tampering only if the executed native implementation actually passes the probe. File moves do not establish durable ordering or a multi-file transaction. The probe stores its files in the app's document directory; iOS vault backup exclusions and a production non-backup identity/key policy are not implemented. The Android config disables application backup, but that setting alone does not establish cloud/device-transfer exclusion. Retention, backward-clock/reboot handling, low-storage behavior, bounded queue reconciliation and server resend identity also remain to be implemented after adapter selection.

**G1 has not passed on Android or iOS.** The native typecheck and separate Android debug build passed on 2 October 2026. The manifest identifies `sg.parse.vaultprobe`, version `0.1.0`; SHA-256 is `80a770714274e376eb215744f1caf39032662fbcfbe65dc57f417f5dfb6a355a`. The APK is in ignored `runtime/offline-vault-probe-20261002/android/app/build/outputs/apk/debug/app-debug.apk`. No physical installation, device test or successful storage observation is claimed, and the iOS native build is unexecuted. Record all physical results in the [feasibility decision record](../../../../docs/adr/2026-10-02-native-offline-capture.md). Keep offline capture disabled until the full gate passes for an enabled platform. This fixture alone cannot close #15.
