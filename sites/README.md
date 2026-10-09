# Hosted Parse and ESP32 voice

The current hosted dashboard lives in `parse-shared-voice/`. It brings the ESP32 recording controls, signal display, transcripts, replies, and care proposals into [one Parse workspace](https://parse-shared-voice.iians0n.chatgpt.site/?view=voice). `parse-phone-companion/` is its public phone and laptop bridge.

Start with the [voice tool-calling guide](parse-shared-voice/docs/voice-tool-calling.md) for the eleven functions, conversation context, clarification, confirmation, retry limits, and software checks. See the [ESP32 relay guide](../tools/ESP32_VOICE_RELAY.md) for laptop setup and the [microphone firmware](../firmware/diagnostics/microphone/README.md) for the matching INMP441 transport.

## Source provenance

This GitHub source export starts from the deployed Sites versions below. Application source and migrations match their published commits; generated TypeScript build caches are omitted. The setup documentation is updated for this repository.

| Directory | Published version | Sites source commit |
| --- | --- | --- |
| `parse-shared-voice` | 12 | `819db31a83e049af8e1e6e4112da7531e7602bbf` |
| `parse-phone-companion` | 5 | `03f33358daee76c477970b0b8cf48cee09e2dbaa` |

These directories are ordinary source files, not Git submodules. Each keeps its own package lock, build scripts, and nonsecret Sites project metadata. A GitHub push does not deploy a Sites version. The existing live applications retain their Sites deployments and runtime settings.

## Local software checks

Use Node.js 22.13 or newer. Install the locked dependencies in each site directory with `npm ci`. Keep the two directories as siblings because the relay integration check imports the bridge source.

From `parse-shared-voice/`:

```sh
node scripts/verify-care-intents.mjs
node scripts/verify-care-voice-jobs.mjs
node scripts/verify-care-dashboard.mjs
node scripts/verify-esp32-relay.mjs
node scripts/verify-microphone-analysis.mjs
node scripts/verify-care-activity.mjs
node scripts/verify-public-phone.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run build
```

The default checks use synthetic audio/provider replies and isolated storage. They require no API key or board. The optional live-model evaluation is described separately in the tool-calling guide.

The hosted worker needs its platform bindings, approved runtime secrets, and dashboard allowlist. The phone bridge needs its approved server-side connection to the private dashboard. Private runtime state, audio, pairing cookies, and credentials are not part of this export.
