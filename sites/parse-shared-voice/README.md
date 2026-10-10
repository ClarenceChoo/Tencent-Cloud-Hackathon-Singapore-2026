# Parse · Care dashboard and phone demo

A ChatGPT Site with the full Parse care dashboard, a public phone companion and a private team workspace. Today, Timeline, Medications, Care and Log use the current Aurora Pearl logo, fonts, colours and buttons. Check records is a Today action, summary preparation is a Timeline action, and the header provides phone pairing and Settings.

## Demo flow

1. Open the dashboard on the laptop and sign in with an invited ChatGPT account.
2. Choose **Connect** in the header, then **Pair phone → Create pairing QR**. Existing `?view=voice` links still open this workspace.
3. Scan it on any compatible phone and open Safari on iPhone or Chrome on Android. The phone does not need ChatGPT sign-in.
4. Choose **Connect this phone**, compare the six-digit code, and choose **Codes match — connect phone** on the laptop.
5. Choose **Listen live** on the laptop. Headphones avoid audio feedback.
6. Tap **Start recording** on the phone. Keep Safari open and visible. Audio is sent while speaking; the laptop polls and plays the received chunks.
7. Tap **Stop recording**. The microphone turns off and the complete recording appears in the inbox. Clips stop automatically at 20 seconds.
8. When its transcript arrives, choose **Review care update**. Parse selects the appropriate application function and prepares a proposal. Review or revise the server read-back, then choose **Confirm and save** to add the exact reviewed record to the care dashboard.

Both devices use the hosted backend; the Mac does not run a public tunnel. Sites itself uses Cloudflare infrastructure. This dashboard Site retains its native private sharing policy. QR links open the separate public phone companion Site. A bounded server bridge forwards phone actions to this private backend using the existing Sites service credential; phone approval and cookie checks still happen here. The application also protects the dashboard and every dashboard API with ChatGPT sign-in and the server-side team allowlist.

## Storage and access

- The dashboard requires a platform-authenticated ChatGPT identity whose email is in the server-side `DASHBOARD_ALLOWED_EMAILS` runtime setting. A missing allowlist denies access. The home page renders only a sign-in/access gate for other visitors; dashboard APIs return 401 or 403. Never grant dashboard access based on browser state or a phone cookie.
- Each room, recording and audio object is scoped to the dashboard account that created its pairing. An invited teammate can use their own dashboard but cannot read another account's recordings.
- Each invited account receives its own persistent fictional care space. **Settings → Sharing permissions** can grant care-record scopes to another already invited teammate. Notes remain private until their sharing is explicitly changed. A care grant never exposes the owner's recordings, phone pairing, proposal administration or private settings.
- A QR invitation has a random single-use token, expires after ten minutes, and requires laptop approval. Only its hash is stored. The token travels in the URL fragment and is removed after the phone reads it.
- The phone credential is a secure HttpOnly, SameSite cookie. Pairings expire after 24 hours or can be disconnected earlier. The public companion forwards only the phone endpoints that allow claiming an invitation, reading that phone's connection status, and sending/finishing/discarding its own audio after approval. The phone cannot approve itself, list an inbox, read audio, or retrieve transcripts.
- Mono 16 kHz PCM is resampled in an AudioWorklet and uploaded in independent one-second WAV chunks. Exact chunk retries are idempotent. The backend rejects changed duplicates, missing positions and overlapping recording starts.
- D1 holds metadata. R2 holds private audio. Audio and transcripts are served only through authenticated, allowlisted dashboard APIs. The phone's finish response omits private playback URLs and transcripts. Browser storage is not the source of truth.
- The inbox makes recordings accessible for 24 hours. This is an access window, **not automatic physical deletion from R2**. This prototype has no scheduled deletion process.
- Use fictional, non-sensitive information only. [Sites prohibits protected health information](https://help.openai.com/en/articles/20001340-chatgpt-sites-complying-with-data-protection-laws).

## Transcription and care functions

Live audio works without an OpenAI key. If an explicitly approved `OPENAI_API_KEY` is configured as a **Sites secret**, the backend transcribes the assembled recording using `gpt-4o-mini-transcribe` after Stop. This is not live transcription. An upstream failure preserves the audio and reports the missing transcript honestly.

With the user's explicit approval, the existing Tencent demo key is configured as a masked Sites secret. Anonymous phones can trigger transcription only after an invited dashboard has approved them, within the existing recording limits. The local key copy remains in its approved private env file. Never put a key in a QR, a phone page, client source, or this repository. API usage is billed separately from Sites hosting.

The private backend uses `gpt-4.1` through the Responses API for eleven strict care functions: six proposal types, confirmation review, stored medicine instructions, support status, follow-up status and clarification/conversation. Existing-task updates have a separate strict payload shape from task creation. Function calls cannot commit a record. Proposals expire after two minutes, revisions replace previous reviews, and saving rechecks the referenced record/version. Repeated interpretation of the same recording uses the stored result rather than another API request.

Care records, grants, proposals, summaries and interpretation jobs persist in D1. Ask Parse returns permitted source-linked records. Visit summaries require review before printing or sharing; source changes invalidate existing reviews/links. Summary links are limited to the existing private Site audience and expire after one hour. Unreported scheduled doses are not included as medication reports.

To invite another dashboard teammate, preserve the native Sites viewer list and add the invited ChatGPT sign-in email to `DASHBOARD_ALLOWED_EMAILS`. Deploy a saved version to apply the runtime revision. Removing dashboard access requires removing that email from the runtime allowlist too; both the native private sharing policy and the application allowlist protect dashboard access.

The care interface was migrated from the original dashboard preview; its new hosted records are seeded once from fictional preview fixtures. It does not copy the original Python backend's care database. Browser phone pairing, an approved ESP32 laptop relay, and direct ESP32 Wi-Fi all feed this workspace. Direct Wi-Fi uses the iPhone hotspot after one USB setup in the dashboard and supports cloud-generated spoken replies; background reminders and native push are not enabled. See [voice tool calling](docs/voice-tool-calling.md), the [direct Wi-Fi setup guide](../../tools/ESP32_WIFI_SETUP.md), and the [laptop relay guide](../../tools/ESP32_VOICE_RELAY.md). The public phone companion remains a separate public Site with a restricted server bridge to this private dashboard.

## Local checks

```sh
npm run dev -- --hostname 127.0.0.1 --port 5174
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint app/care app/voice-workspace.tsx app/v1 app/shared app/page.tsx app/layout.tsx db/schema.ts scripts/verify-care*.mjs
node --import ./scripts/sites-env.mjs scripts/verify-shared-voice.mjs
node --import ./scripts/sites-env.mjs scripts/verify-public-phone.mjs
node --import ./scripts/sites-env.mjs scripts/verify-care-dashboard.mjs
```

The ordinary verification scripts use isolated local D1/R2 and synthetic sound. They cover transport, all eleven care-function handlers using simulated provider responses, persistence/confirmation, care sharing, summary invalidation and account isolation. They never record a microphone or call the real OpenAI API.

An explicitly invoked live verifier makes at most three fictional Responses API calls using the already approved local demo key and isolated test storage. It passed for a note, a blood-pressure reading and an existing-task transition after strict schema fixes. It does not establish a complete eleven-function live acceptance run or physical-phone behaviour:

```sh
node --import ./scripts/sites-env.mjs scripts/verify-care-openai.mjs --use-approved-demo-key
```

Generate schema migrations with `npm run db:generate`, inspect the SQL, and apply them locally once. Production schema migrations are included in the Sites deployment archive. Applied migrations are append-only.

The local preview uses the starter's mock ChatGPT identity; production uses Sites sign-in. A physical iPhone/Safari acceptance run is still required for microphone permissions, interruption behaviour and playback on the user's device.

The built production worker also has a loopback-only render check, `node scripts/verify-care-production.mjs http://127.0.0.1:5175`, run against `npm run start -- --port 5175 --var DASHBOARD_ALLOWED_EMAILS:seedy@sites.test --var PUBLIC_SITE_ORIGIN:http://127.0.0.1:5175`. This covers signed-in server rendering, both access gates and the real care API route. Browser URL inspection is deferred until after mount so it cannot crash server rendering.

The page exposes a bounded, read-only `read_voice_workspace` WebMCP tool when the browser supports it. It refreshes the same visible state and cannot start recording or approve a phone.

## Interface

Pairing and recording have no extra acknowledgement checkboxes. The laptop approves a phone using **Codes match — connect phone** after comparing its code. Recording still starts only when the person taps **Start recording** and grants browser microphone access. Care updates still require a reviewed **Confirm and save** action.

The care profile and initial medicine/monitor labels use plain names. Existing starter labels are normalized when a care space is opened; record IDs, reported values, dates, permissions and source provenance remain intact. Sharing choices use readable labels. Initial data remains illustrative and the data-use restrictions above still apply.


## Dashboard cleanup · 9 October 2026

The navigation and Today cleanup from GitHub commit `e19630fd84607bcf507ceacad4cfe0b6e93d092f` are integrated with the existing Sites backend. Today is the starting view. Care contains Tasks and Requests & follow-ups, with the open-request count retained. Readings and companion details remain under More care details.

Log is a read-only view of saved hosted records, retained dose/task/follow-up revisions, summaries and owner-only recording metadata. Search, category, patient-local dates and stable pagination run on the server after current record permissions are applied. Deleted/private notes, other recipients' requests and restricted follow-ups stay hidden; the endpoint never selects transcripts, audio, credentials or provider errors. New proposals retain their creation time. Existing events without a recorded timestamp are omitted rather than assigned an invented date. This is not a complete administrative audit trail; the original Python backend's audit database is not copied into Sites.

The header reports **Companion paired** for an approved pairing. It does not infer a live microphone or browser presence. The existing public phone companion, bridge, recording protocol, confirmation flow, runtime secrets, access policy and database schema are retained. The ESP32 relay and its migration published in Sites version 9 are preserved. The Python frontend’s browser-presence protocol is not substituted for the existing Sites pairing protocol.

Additional regression check:

```sh
node --import ./scripts/sites-env.mjs scripts/verify-care-activity.mjs
```

The isolated test covers access revocation, deleted/private notes, restricted related follow-ups, safe recording metadata, Singapore midnight boundaries, invalid filters, tied timestamps and pagination through 130 historical medication reports. Production builds and the existing care/phone/ESP32 relay checks also pass. Browser verification covered the five destinations, Check records, summary preparation, Care subsections, Settings, QR creation, note proposal/review/confirmation, log filtering and widths 320, 390, 768 and 1200 CSS pixels. Physical microphone behaviour was not re-tested.
