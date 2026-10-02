# Native offline audio capture feasibility

Status: study in progress; G1 has not passed on either operating system. This decision record covers [issue #15](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/15). It does not enable an offline queue or authorize a production storage adapter.

## Current evidence

On 2 October 2026, the repository's Android platform-tools returned an empty attached-device list. The host could not locate `xctrace` through `xcrun`. These observations establish that this session currently has no connected Android test device or usable Apple device-testing toolchain; they do not establish whether test phones are available elsewhere. Physical-device availability has been requested from the user.

The current native implementation stores installation credentials and opaque accepted-turn recovery identifiers with SecureStore. Audio is temporary recorder/reply data in cache, removed through `removeAudio` and `sweepAudio`. `resolveAcceptedTurn` is read-only recovery and does not retain audio. The proposed unsent-audio queue must remain separate from that accepted-turn journal.

The pinned stack is Expo 57.0.25, React Native 0.86.3, expo-crypto 57.0.3, expo-file-system 57.0.7 and expo-secure-store 57.0.4. No dependency was added or upgraded for this study.

## Candidates

| Boundary | Maintained Expo SDK composition | Minimal native Expo module |
| --- | --- | --- |
| Encryption | The installed Crypto AES-GCM API can encrypt bytes and journal metadata. A test adapter could combine it with SecureStore and FileSystem. | Android Keystore AES-GCM and an iOS native encryption implementation keep key handling within the module. |
| Key access | The SDK example exports a generated AES key for SecureStore. That is a candidate for testing, with different platform lock and reinstall behavior to prove. | Explicit per-platform lock-state restrictions and installation-scoped key aliases; no key-return API to JavaScript. |
| Atomic commit | File writes/moves do not prove a transaction across encrypted audio and journal metadata. Crash reconciliation and durable ordering need a tested adapter. | Native atomic-file/rename primitives plus an encrypted write-ahead journal; a single atomic file alone does not commit two files together. |
| Backup | The app currently sets Android `allowBackup: false`. The vault still needs cloud/device-transfer exclusions and iOS file/key backup exclusions verified on device. | Store in excluded private locations and supply explicit native backup rules/resource attributes, then inspect actual backup/restore behavior. |
| Reinstall/identity | SecureStore's platform persistence must be combined with an installation marker and explicit inaccessible-old-key handling. | Bind encrypted data and journal to the installation identity with authenticated metadata, and reconcile missing/replaced keys before exposing entries. |
| Delivery readiness | Compatibility can be checked against the pinned SDK without a package change; no device acceptance yet. | More platform code and native builds to maintain; no device acceptance yet. |

The Expo option is an inference from the available pinned APIs, not a claim that an existing complete protected vault is provided. The native option is a design candidate. Neither is selected until the same physical-device matrix passes. A generic encrypted key/value database alone is not a replacement for atomic, bounded encrypted audio storage.

## Platform sources reviewed

- [Expo Crypto](https://docs.expo.dev/versions/latest/sdk/crypto/) documents AES-GCM and demonstrates encrypted file bytes with a key in SecureStore. Its recommended version matches the installed 57.0.3 package. This establishes the primitive's API, not durable queue semantics.
- [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/) documents platform key storage, device-only keychain accessibility, backup considerations and physical-device requirements for authentication tests. It is intended for small secrets. Audio belongs in a separately protected vault.
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore) documents non-exportable key material, authorized-use restrictions and hardware support that varies by device. The test report must identify the actual protection available on each tested phone.
- [Android AtomicFile](https://developer.android.com/reference/android/util/AtomicFile) is a candidate native file primitive. Serial access, encryption and multi-file journal recovery remain adapter responsibilities.
- [Android backup rules](https://developer.android.com/identity/data/autobackup) distinguish cloud backup and device transfer. Verify both paths; the application setting alone is insufficient evidence for the vault gate.
- [Apple atomic data writes](https://developer.apple.com/documentation/foundation/nsdata/writingoptions/atomic) and [Apple file protection](https://developer.apple.com/documentation/foundation/urlfileprotection) identify native mechanisms to evaluate. Exact key/file protection and backup behavior require the built module and physical iOS tests.

## G1 pass matrix

Every enabled OS needs a device model, OS version, lock configuration, native build digest, adapter version and reproducible credential-free evidence for each row. `Not run` is not a pass.

| Test | Required observation | Android | iOS |
| --- | --- | --- | --- |
| Encryption and integrity | Audio and sensitive journal bytes are ciphertext; altered ciphertext/authenticated identity is rejected; keys are absent from backup artifacts. | Not run | Not run |
| Write interruption | Kill the process after temporary write, audio rename and journal commit separately; recover one complete entry or remove the orphan with no new turn key. | Not run | Not run |
| Lock/reboot | Reads and sends obey the documented lock policy before first unlock and after relock; no accidental plaintext spill. | Not run | Not run |
| Identity reset | Logout/reset, reinstall and account replacement make old audio unreadable and prevent its upload under another identity. | Not run | Not run |
| Backup/restore | Neither audio/journal nor usable keys cross cloud or device-transfer restoration. Test configured exclusions on the built app. | Not run | Not run |
| Low storage | Failed enqueue preserves existing clips, rejects the new entry, and leaves no readable partial data or journal assertion. | Not run | Not run |
| Retention/clock | Reads/uploads are denied after 24 hours, identity change, unverifiable reboot timing or backward clock movement; cleanup runs at the next execution opportunity. | Not run | Not run |

The disposable [fictional fixture](../../mobile/test/manual/offline-vault/README.md) is in `mobile/test/manual/offline-vault/` and remains outside production imports. It generates a synthetic tone, encrypts audio and journal bytes separately, exposes interruption checkpoints, and checks altered ciphertext/authenticated identity rejection. It does not upload audio, touch real accounts or use the microphone. The preparer creates a separate app with identifier `sg.parse.vaultprobe` under ignored runtime; it does not build or install it. Both the mobile project and prepared fixture passed TypeScript checks on 2 October 2026. No physical observation has executed. This candidate lacks verified backup exclusions, durable transaction ordering, retention and orphan reconciliation, so even successful primitive observations cannot pass the full gate. Physical reset/reinstall tests use a dedicated fixture app/device and explicit operator control.

## Delivery gate and remaining work

Android and iOS offline capture remain disabled. Existing foreground online recording is unchanged. After G1 passes for a platform, select and pin its concrete adapter, implement the bounded queue and metadata migration after `0007_summary_purposes`, then run the complete offline capture/retry/review flow on that platform. A completed feasibility document alone cannot close issue #15.
