# Parse · Public phone companion

A public ChatGPT Site for QR pairing with the private Parse team dashboard. The phone does not need a ChatGPT account. It uses the existing Aurora Pearl theme.

The root and `/phone` render only the phone companion. The Site contains no dashboard, inbox, database, audio storage, OpenAI key, or transcript view.

The server forwards only the bounded `/api/voice/phone/` actions to the private dashboard: claim a QR invitation, check the claimed phone connection, and send/finish/discard approved audio. The dashboard remains private through native Sites sharing and its server allowlist. Pairing secrets are single-use, expire, and require a separate laptop approval. The phone cannot approve itself, fetch audio, list recordings, or access another room.

`PRIVATE_DASHBOARD_ORIGIN` is the verified private Site origin. `PRIVATE_VOICE_SERVICE_TOKEN` is the existing Sites service credential, stored only as a masked server secret. The proxy never forwards ChatGPT identity headers or sign-in cookies. It sends that credential only to the configured HTTPS dashboard origin and refuses redirects. Only the paired phone cookie crosses the bridge. Responses omit playback URLs and transcripts.

`PUBLIC_SITE_ORIGIN` is this companion's verified origin. Same-origin writes, short request bounds, secure HttpOnly/SameSite cookies, and an explicit action allowlist protect the proxy. The private backend independently validates QR tokens, approval, phone credentials, recording ownership, ordering, and recording limits.

Use fictional, non-sensitive demo content. Existing transcription stays on the private dashboard and uses its existing approved API secret. The public companion has no OpenAI API key. Clips are limited to 20 seconds. Physical iPhone/Safari and Android/Chrome acceptance runs remain a device test.

Verification uses the real proxy and private backend code with isolated local storage and synthetic audio. It does not record a microphone or call OpenAI.

Run `node scripts/verify-phone-bridge.mjs` for the isolated audio and access checks, and `node scripts/verify-worker-requests.mjs` for actual workerd request construction. The Workers runtime accepts manual redirect handling; redirect responses are explicitly rejected so server credentials stay on the configured private origin.

## Interface

Pairing and recording have no extra acknowledgement checkboxes. The laptop approves a phone using **Codes match — connect phone** after comparing its code. Recording still starts only when the person taps **Start recording** and grants browser microphone access. Care updates still require a reviewed **Confirm and save** action.
