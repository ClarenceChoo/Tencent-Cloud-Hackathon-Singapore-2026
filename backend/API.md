# CareLoop API contract

This file is the implementation contract for the web dashboard and ESP32 firmware. The OpenAPI document at `/openapi.json` is authoritative for field-level validation once the backend is running. All timestamps are ISO 8601 UTC strings unless a field explicitly contains a local date or the user's own approximate wording. Unknown facts are `null`; array fields are always arrays.

## Browser session and CSRF

Browser routes use the HttpOnly `careloop_session` cookie. Every browser mutation, including login and logout, must include an allowed `Origin` header. Authenticated mutations must additionally send the `X-CSRF-Token` returned by login/session. Production cookies are `Secure`; local development can disable that only through explicit configuration.

```http
POST /v1/auth/login
Origin: http://localhost:5173
Content-Type: application/json

{"email":"owner@careloop.invalid","password":"fictional-demo-only"}
```

```json
{
  "user": {"id":"usr_…","name":"Fictional Alex Tan","email":"owner@careloop.invalid","role":"owner"},
  "patients": [{"id":"pat_…","name":"Fictional Mei Tan","timezone":"Asia/Singapore"}],
  "csrf_token":"…"
}
```

`GET /v1/auth/session` returns the same body. `POST /v1/auth/logout` returns `204`.

## Dashboard

`GET /v1/app/patients/{patient_id}/dashboard`

Callers with device/dashboard access also receive `device_setup`: `service_address`, `voice_service` (`unconfigured`, `configured`, `simulated`, `invalid_configuration`), `live_voice_verified:false`, `scheduler_enabled` and `protocol`. `configured` describes provider settings only; it is not evidence of a successful live call. Device status is `awaiting_connection` before any contact, `connected` only while an authenticated socket has a fresh heartbeat, `stale` after disconnect or heartbeat timeout, and `revoked` after access is removed. A previous upload timestamp alone cannot make a device connected.

```json
{
  "patient": {"id":"pat_…","name":"Fictional Mei Tan","preferred_name":"Mei","timezone":"Asia/Singapore","language":"en","daily_check_in_enabled":true,"daily_check_in_local_time":"09:00","calling_route":"Call the configured family number"},
  "devices": [{"id":"dev_…","status":"connected","last_seen":"2026-09-22T12:00:00Z","battery_mv":3950,"firmware_version":"0.1.0","revoked_at":null}],
  "medication_plans": [{"id":"plan_…","version":2,"timezone":"Asia/Singapore","source":"Fictional pharmacy label used for demonstration","checked_by":"Fictional Alex Tan","checked_at":"2026-09-22T09:00:00Z","active":true,"medicines":[{"id":"med_…","name":"DemoMed","instructions":"One fictional tablet with breakfast","reviewed_reference":"Fictional demo reference; not medical advice","reference_source":"Demo label"}],"schedule":[{"medicine_id":"med_…","local_time":"08:00"}]}],
  "doses": [{"id":"dose_…","plan_version":2,"medicine_id":"med_…","medicine_name":"DemoMed","scheduled_at":"2026-09-22T00:00:00Z","delivery_state":"playback_completed","report_state":"unconfirmed","report_time":null,"taken_time_text":null}],
  "notes": [],
  "measurements": [],
  "preventive_tasks": [],
  "support_requests": [],
  "followups": [],
  "check_ins": [{"id":"checkin_…","local_date":"2026-09-22","due_at":"2026-09-22T01:00:00Z","delivery_state":"playback_completed","created_at":"…"}],
  "proposals": [],
  "summaries": [{"id":"summary_…","status":"reviewed","share_active":true,"share_expires_at":"2026-09-22T14:00:00Z"}],
  "access_grants":[{"id":"grant_…","user":{"id":"usr_…","name":"Fictional Alex Tan","email":"owner@careloop.invalid"},"relationship":"owner","scopes":["*"],"expires_at":null}],
  "allowed_recipients":[{"id":"usr_…","name":"Fictional Jamie Lim","relationship":"caregiver"}],
  "permissions":["read:dashboard","write:care","manage:devices","manage:sharing"]
}
```

`access_grants` and `summaries` are populated only for callers with `manage:sharing`; otherwise they are empty arrays. Summary rows expose only whether an unexpired link exists and its expiry, never the bearer token again. `allowed_recipients` exposes only ID, display name and relationship to owners or callers with `write:care`, so a caregiver can populate a support-recipient picker without reading grants or email addresses. Each note includes `shared_with_user_ids` for an owner. Health notes remain private by default: `read:dashboard` or `read:notes` permits the collection but a caregiver receives only notes explicitly shared with that caregiver. A caregiver receives only support requests assigned to that user and follow-ups whose derived `permitted_user_ids` includes that user; broad `read:dashboard` never overrides record privacy. Pending proposals and their read-backs follow the same record visibility rules. A missing patient grant returns `403`, never an empty dashboard that could reveal patient existence.

## Immutable proposals and care records

`PUT /v1/app/patients/{patient_id}/profile` updates the chosen `preferred_name`, `language`, IANA `timezone`, optional `calling_route`, and daily check-in preference (`daily_check_in_enabled`, `daily_check_in_local_time` in `HH:MM`). It requires owner-level `manage:profile`; the backend passes these settings into device interpretation context. When enabled, the scheduler creates one durable `checkin.play` event per patient-local date at the configured time. It expires after 30 minutes, uses the chosen name, and does not create a clinical record or imply wellbeing. Disabling the preference cancels pending check-in playback. An urgent support proposal includes the configured calling route in its read-back and states that it has not dispatched help. If no route is configured, the read-back says so and directs the person to their usual local support or emergency contact method.

`POST /v1/app/patients/{patient_id}/proposals`

```json
{"kind":"measurement","payload":{"measurement_type":"blood_pressure","systolic":128,"diastolic":76,"unit":"mmHg","occurred_at":"2026-09-22T07:15:00+08:00","occurrence_text":null,"timezone":"Asia/Singapore","source_description":"Existing home cuff","reporting_actor":"patient"}}
```

Response (`201`):

```json
{"id":"prop_…","kind":"measurement","payload":{},"readback":"I will record… Is that right?","status":"pending","expires_at":"2026-09-22T12:02:00Z","replaces_proposal_id":null,"record_type":null,"record_id":null}
```

Accepted `kind` values and required payloads:

- `health_note`: `wording`; optional `symptom`, `occurrence_text`, `occurred_at`, `timezone`, `share_with_user_ids`.
- `medication_report`: `dose_instance_id`, `report_state` (`reported_taken`, `reported_skipped`, `reported_not_yet`, `reported_uncertain`); optional `taken_time_text`. The server stores and rechecks `plan_version`.
- `measurement`: `measurement_type` (`blood_pressure`), integer `systolic`, integer `diastolic`, `unit` (`mmHg`), `timezone`, `source_description`, `reporting_actor`; exactly one of `occurred_at` or `occurrence_text` may be supplied. To correct an existing confirmed reading, also send `supersedes_id` with that measurement's ID and all revised material fields. Confirmation preserves the original for audit, removes it from current chart data, and invalidates summaries that cite it.
- `preventive_task`: for creation, `task_type`, `description`, `source`, `due_date`, `timezone`, `state`; for transition, `task_id`, `state`, optional `appointment_date`, `completion_date`. States are `planned`, `due`, `arranged`, `completed`, `declined`, `needs_discussion`. Arrangement/completion dates are stored when known; an unknown date stays `null` and is stated as unknown in the read-back rather than invented.
- `support_request`: `request_text`, `recipient_user_id`, optional `urgency` (`routine`, `urgent`) and `barrier_text`.
- `followup`: create one with `related_type`, `related_id`, `check_at`, `permission_scope` (`private` or `related_recipients`), and `resolution_state:"open"`. The server derives immutable recipients from the related support request or explicitly shared note; medication follow-ups remain private. Later resolve that same row with a new confirmed proposal containing `followup_id`, `reported_outcome`, and `resolution_state:"resolved"`. The server preserves an outcome audit entry. Silence never resolves a follow-up, and a separate resolved duplicate is never created.

`POST /v1/app/proposals/{id}/revise` with `{"payload":{…}}` returns a new proposal and marks the old proposal `invalidated`. `POST /v1/app/proposals/{id}/confirm` with `{"confirmed":true}` atomically commits once and returns:

```json
{"status":"committed","record_type":"measurement","record_id":"measurement_…"}
```

Repeating confirmation returns the same result. Expired/invalidated proposals return `409`. Medication-plan drift also returns `409` and invalidates the proposal. Ambiguous or missing material fields return `422` before a proposal is created.

## Checked medication plans

`POST /v1/app/patients/{patient_id}/medication-plans`

```json
{
  "timezone":"Asia/Singapore",
  "source":"Fictional label reviewed for the demo",
  "checked":true,
  "medicines":[{"id":"med_demo","name":"DemoMed","instructions":"One fictional tablet with breakfast","reviewed_reference":"Fictional reviewed explanation","reference_source":"Demo label v1"}],
  "schedule":[{"medicine_id":"med_demo","local_time":"08:00"}]
}
```

Returns the active plan version (`201`). A later plan creates the next version, deactivates the old one, and cancels its unsent reminder commands. Unchecked or unsourced plans are rejected.

The scheduler continuously materializes the next three patient-local days for every active recurring plan. A database uniqueness constraint prevents duplicate instances when scheduler runs overlap or repeat.

## Support, devices, deletion and grants

- `POST /v1/app/support-requests/{id}/acknowledge` → explicit human acknowledgement timestamp. Only the selected `recipient_user_id` can acknowledge; even an owner cannot mark another person's request as seen.
- `POST /v1/app/support-requests/{id}/resolve` body `{"outcome":"…"}` → explicit resolution.
- `POST /v1/app/devices/claim` body `{"code":"ABCD-EFGH","patient_id":"pat_…"}` → `{"device_id":"dev_…","status":"claimed"}`. Claim codes are one use and short lived.
- `POST /v1/app/devices/{id}/revoke` → `{"device_id":"dev_…","status":"revoked"}` and immediate rejection of subsequent device calls.
- `DELETE /v1/app/notes/{id}` returns `204`, revokes future reads, and invalidates summaries that cite the note.
- `PUT /v1/app/notes/{id}/sharing` body `{"user_ids":["usr_…"]}` replaces explicit note recipients; `[]` makes it private. Only `manage:sharing` may use it, and recipient changes invalidate summaries that cite the note.
- `POST /v1/app/patients/{patient_id}/grants` body `{"user_id":"usr_…","scopes":["read:notes","read:measurements","ack:support"],"expires_at":null}`.
- `DELETE /v1/app/grants/{id}` returns `204` and removes access immediately.

## Reviewed visit summaries

`POST /v1/app/patients/{patient_id}/summaries` body `{"start_date":"2026-09-01","end_date":"2026-09-22"}` creates a source-linked draft. Because the draft aggregates private records, this route requires `manage:sharing`. Date boundaries use the patient's recorded timezone. Dated entries retain reported occurrence, server record time, unit/source, and confirmation provenance; the preventive section is explicitly labelled as current context at generation time.

The normalized summary schema is `sections:[{"title":"Reported measurements","items":[{"text":"Patient reported…","source_id":"measurement_…"}]}]` with immutable top-level `sources:[{"type":"measurement","id":"measurement_…","version":1}]`, plus `status:"draft"` and `invalidated_at:null`. Section-level `sources`, unknown IDs, source type/version drift, and arbitrary item fields are rejected. Owner-written questions may be unsourced items containing only `text`.

`PUT /v1/app/summaries/{id}` accepts `{"sections":[…],"omitted_source_ids":[…],"reviewed":true}`. Omitted items and their source refs disappear from returned `sections`/`sources`; an owner can see `omitted_source_ids` while reviewing. `POST /v1/app/summaries/{id}/share` accepts `{"expires_in_seconds":3600}` and returns `{"share_token":"…","expires_at":"…","url":"/v1/shared/summaries/…"}`. `POST /v1/app/summaries/{id}/revoke` revokes all active links. `GET /v1/shared/summaries/{token}` needs no session and returns `{"patient":{"name":"…"},"summary":{…},"read_only":true}` but never exposes omitted IDs/versions; it fails with `410` on expiry, revocation, or source invalidation.

## Device authentication and audio

Every device HTTPS call uses `Authorization: Bearer <unique device credential>`. Credentials never appear in URLs. Revoked or unclaimed credentials are rejected. Device identity and patient identity are always derived from the credential binding.

`GET /v1/device/info` returns the bound `device_id`, `pairing_state:"paired"`, `server_time`, and the same connection/provider configuration facts in `device_setup`. It includes no patient records or credential. Protocol v1 is Wi-Fi, mono 16 kHz signed 16-bit PCM WAV, 0.3–20 seconds, with a 768 KiB upload limit, a 5-second heartbeat target and a 15-second stale threshold. This endpoint is used by `tools/check_hardware_ready.py` before physical acceptance.

`POST /v1/device/turns` requires `Content-Type: audio/wav`, UUID `Idempotency-Key`, and optional `X-Context-Id`. The body must be mono signed 16-bit PCM WAV at 16 kHz, 0.3–20 seconds, at most 768 KiB.

```json
{"turn_id":"turn_…","status":"accepted","received_at":"2026-09-22T12:00:00Z"}
```

Same key, bytes, and context returns the same turn even after that turn committed its proposal; a changed body or context returns `409`. `GET /v1/device/turns/{turn_id}` returns the durable processing state and a complete `turn.result` envelope to reconcile a lost WSS acknowledgement:

```json
{"turn_id":"turn_…","status":"awaiting_confirmation","received_at":"…","event":{"protocol_version":1,"event_id":"evt_…","type":"turn.result","device_id":"dev_…","server_time":"…","expires_at":"…","payload":{"turn_id":"turn_…","context_id":"ctx_…","status":"awaiting_confirmation","spoken_text":"I will record… Is that right?","audio_path":"/v1/device/audio/audio_1","audio_paths":["/v1/device/audio/audio_1","/v1/device/audio/audio_2"],"record_type":null,"record_id":null}},"error":null}
```

`event` is `null` while accepted/processing and may be expired when recovered; the durable payload still identifies the outcome, while expired audio must not be fetched or played. Raw WAV is removed after successful transcription or terminal failure.

`turn.result.payload.audio_paths` is the ordered complete reply. `audio_path` repeats its first item for older firmware. The array contains at most 20 same-device relative paths; every asset is independently validated mono signed 16-bit PCM WAV at 16 kHz and at most 20 seconds, and the sequence is at most 120 seconds. The backend splits text on word boundaries at no more than 160 characters per synthesis request and recursively splits any returned clip that exceeds 20 seconds; it does not silently truncate the spoken content. Firmware plays all assets sequentially with capture disabled and retains the single `context_id` for the next deliberate turn.

`GET /v1/device/audio/{asset_id}` returns an owned, unexpired validated WAV. A reminder asset becomes unavailable immediately when its medication plan is cancelled or replaced, even if the asset's time expiry has not elapsed. `GET /v1/device/pending-commands` returns:

```json
{"current_plan_version":2,"commands":[{"protocol_version":1,"event_id":"evt_…","type":"reminder.play","device_id":"dev_…","server_time":"…","expires_at":"…","payload":{"command_id":"cmd_…","dose_instance_id":"dose_…","plan_version":2,"context_id":"ctx_…","audio_path":"/v1/device/audio/audio_…"}}],"checkins":[{"protocol_version":1,"event_id":"evt_…","type":"checkin.play","device_id":"dev_…","server_time":"…","expires_at":"…","payload":{"command_id":"checkin_…","context_id":"ctx_…","greeting_text":"Hello Mei. This is your daily check-in. How are you today?","audio_path":"/v1/device/audio/audio_…","audio_paths":["/v1/device/audio/audio_…"]}}]}
```

`POST /v1/device/acks` body `{"ack_id":"<UUID>","command_id":"cmd_…","stage":"received|playback_started|playback_completed|interrupted|failed|expired","device_time":"…"}` is idempotent for medication reminders and check-ins. `playback_started` is rejected for a stale medication plan. Playback state does not modify the dose report state.

`WSS /v1/device/events` uses the same Bearer header. Events use the command envelopes above or `type:"turn.result"`. Device messages are `{"type":"heartbeat","battery_mv":3950,"rssi":-55,"firmware_version":"0.1.0"}`. Optional measurements may be omitted. The server replies `{"protocol_version":1,"type":"heartbeat.ack","device_id":"dev_…","server_time":"…"}` after committing each heartbeat. Firmware may ignore that additive event; connection-check tools use it to verify the authenticated channel. Sockets also receive due durable outbox events. Five seconds is the demo heartbeat target and 15 seconds marks a dashboard connection stale; a closed socket is offline immediately when the server observes closure. Every outbound WSS event and the complete pending-commands response is capped at 16 KiB; the server closes an oversize WSS event with code `4400` and fails an oversize polling response closed.

## Errors

Errors use `{"detail":"human-readable stable explanation"}`. Expected statuses include `400` malformed content, `401` unauthenticated/invalid credential, `403` unauthorised or revoked/unbound device, `404` inaccessible object, `409` stale proposal/idempotency/state conflict, `410` expired shared view, `413` audio too large, `422` invalid structured payload, `429` claim throttled, and `503` provider unavailable/retryable processing failure.

## Native phone companion (implementation in progress)

Phone APIs use `Authorization: Bearer <installation credential>`. The credential is 32 random bytes encoded as 64 lower-case hex characters, generated by the native installation and retained in SecureStore. It is never the displayed pairing code. No phone bearer token grants a browser session. Native enrollment requires HTTPS outside tests; enrollment responses are `Cache-Control: private, no-store`.

- `POST /v1/phone/enrollments`: `Idempotency-Key: <UUID>`, JSON `{ "platform": "ios" | "android", "display_name": "..." }`. Returns `201` on creation or `200` for the exact retry; pending response contains `device_id`, `code`, `expires_at`, `poll_after_seconds: 5`, and `status: awaiting_approval`. No patient data is exposed before binding. Codes expire after ten minutes; expired installations return `410`, revoked ones `403`, mismatched identity/key reuse `409`. Create limit: eight requests per peer per ten minutes.
- `GET /v1/phone/enrollments/current`: status using that installation's credential, at most 120 requests per peer/minute. Paired response contains only device/platform and patient ID/chosen name. An expired enrollment requires a new installation identity/key.
- `POST /v1/app/phone-enrollments/approve`: browser owner/device-management scope, CSRF and allowed Origin; `{ "code": "P-...", "patient_id": "..." }`. Single-use atomic binding, with the existing failed-claim rate limit. The old `/app/devices/claim` accepts pendant codes only.
- `DELETE /v1/phone/installation`: revoke the authenticated bound phone and close its device sockets; saved clinical records remain. Pendant credentials are rejected.
- `GET /v1/phone/home`: bounded same-patient preferences, checked medication plan, doses, recent notes/readings, preventive tasks, support/follow-up status and permissible recipients. Includes the current proposal originating from this phone, voice-service readiness and routing schema state. No caregiver credentials, account emails or sharing administration are returned.
- `POST /v1/phone/turns`: `Idempotency-Key`, optional `X-Context-Id`; binary `audio/mp4`/`audio/x-m4a` AAC in M4A or canonical `audio/wav`; maximum 2 MiB. The adapter normalizes real media then uses the same worker/confirmation services as the pendant. Original bytes determine retry identity. `202` is receipt, never proof of a saved fact. `429` can indicate the decoder concurrency bound; `503` indicates decoder/provider unavailability.
- `GET /v1/phone/turn-receipts/{UUID}`: recover an accepted turn ID after a lost `202`, scoped to this installation. `404` means no receipt was found, not that another operation was saved. Continue with existing authenticated `GET /v1/device/turns/{id}` and `/v1/device/audio/{id}`.
- `POST /v1/phone/proposals/{id}/confirm`: `{ "context_id": "...", "confirmed": true }`; exact phone, patient, source turn and context binding. Uses the shared commit service; an exact retry returns the same record. Stale/expired/cancelled read-backs cannot commit.
- `POST /v1/phone/proposals/{id}/revise`: `{ "context_id": "...", "payload": {...} }`; shared validation creates a fresh proposal and invalidates the old one. The new read-back requires a new confirmation.
- `POST /v1/phone/proposals/{id}/cancel`: `{ "context_id": "..." }`; invalidates an unsaved current proposal; repeated cancellation is idempotent.
- `POST /v1/phone/proposals/{id}/speech`: `{ "context_id": "..." }`; generates authenticated speech for a still-current read-back or `Saved.` for a committed record. Returns `{ expires_at, payload: { status, spoken_text, context_id, audio_paths, record_id } }`. One to twenty clips, no more than 120 seconds total. Provider failure here does not undo an existing commitment; the caller must keep those states distinct.

### Reminder routing and native notifications

Enrollment does not select a reminder target. Owners use `PUT /v1/app/patients/{patient_id}/active-companion` with browser session/CSRF authorization and `{ "device_id": "dev_…", "expected_generation": 1, "other_pendants_powered_off": true }`. `device_id: null` pauses delivery. Stale generations return `409`. An old pendant must be physically powered off; switching away from a selected phone requires that phone's cleanup acknowledgement first.

- `POST /v1/phone/quiesce`: `{ "playback_stopped": true, "local_alerts_cleared": true }`. The native client must stop audio and verify alert removal before sending. This narrowly scoped cleanup also accepts that installation's revoked credential; it exposes no care data.
- `GET /v1/phone/reminder-schedule`: a no-store response containing `device_id`, `server_time`, `active_companion`, `revision`, `valid_until`, `covered_until`, `truncated`, generic `title`/`body`, and `alerts`. Each alert has `identity`, `occurrence_id`, `route_generation`, `due_at` and `expires_at`. Only the selected phone receives future medication/check-in alerts, at most 60 within 24 hours. No clinical content is returned in notification text.
- `PUT /v1/phone/notification-registration`: `{ "token": "ExpoPushToken[…]" }`, or `null` to unregister. Returns `registered`, `push_configured` and `version`, never the token. Registration is bound to the authenticated phone and rejects a token already registered to another installation. Replacement, revocation and permission denial invalidate pending hints.
- `PUT /v1/phone/presence`: `{ "lifecycle": "foreground|background", "microphone_permission": "granted|denied|undetermined|unknown", "notification_permission": "granted|provisional|denied|undetermined|unknown", "schedule_revision": "…", "scheduled_until": "…" }`. Optional schedule fields may be null. The server timestamps receipt and bounds reported coverage to 24 hours. This is a client capability report, not OS delivery evidence.
- `POST /v1/phone/notification-events`: `{ "event_id": "<UUID>", "identity": "<own alert or push identity>", "stage": "scheduled|opened|suppressed|cancelled" }`. Exact retries are idempotent. Evidence is separate from reminder acknowledgements and never updates medication report state.
- `GET /v1/phone/reminders/{command_id}`: checks ownership, selected route/generation, plan and expiry, then returns the current reminder envelope. Stale state returns `409`. Native foreground playback also uses existing `/v1/device/pending-commands`, `/v1/device/audio/{id}` and `/v1/device/acks` with its own credential.

One logical medication/check-in occurrence retains separate delivery attempts. A route change may requeue only an unplayed route-cancelled attempt within its original expiry. Downloaded, started or uncertain playback is not automatically repeated. Newly generated read-back and medication-explanation audio also checks its proposal/plan context on retrieval; invalid context returns `410`.

Push hints carry only generic text and opaque identifiers. Expo ticket/receipt acceptance is recorded separately from device delivery. Real APNs/FCM delivery and native lifecycle behavior remain unverified; see `docs/careloop/Phone-Companion-Verification.md`.

Phone recovery retries terminal acknowledgement evidence from its protected local ledger even when the command has left the pending queue. `/v1/device/acks` accepts a new `playback_completed` or `interrupted` acknowledgement after expiry/route change only for the same unrevoked phone, a still-started/unknown attempt, and an existing server-recorded `playback_started` acknowledgement for that attempt. This updates historical delivery evidence only: audio/start authorization, current routing and medication report state remain unchanged. A conflicting terminal state is rejected. Exact acknowledgement retries retain their existing idempotent behavior; pendant authorization rules are unchanged.

Accepted voice-turn recovery remains read-only. The native client keeps the original turn key/context in protected storage until it has fetched the result and refreshed current care state. Background/resume or an uncertain network result does not upload another recording or confirm a proposal. Automatically recovered speech requires an explicit Repeat action; expired or replaced read-backs cannot play.
