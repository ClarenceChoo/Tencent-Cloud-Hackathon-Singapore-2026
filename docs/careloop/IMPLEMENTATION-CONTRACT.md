# CareLoop implementation contract

Working interface agreement for the implementation on branch `codex/careloop-mvp`. The PRD v0.3 remains authoritative. Product voice input comes from the ESP32 cardholder; development fixtures are not a phone voice product.

## Ownership

- Backend agent: `backend/`, except `backend/app/providers.py` and `backend/tests/test_providers.py` (root-owned).
- Frontend agent: `frontend/`.
- Firmware agent: `firmware/`.
- Root: provider adapters, developer harness, root tooling/deployment/docs, integration and verification.

## Application API

Use same-origin `/v1` routes. Browser authentication uses an HttpOnly session cookie; require a configured allowed Origin for browser mutations. Production uses HTTPS and secure cookies. Development must be visibly fictional and enabled explicitly. No secret in browser source.

- `POST /v1/auth/login` `{email,password}` → session user and patients.
- `GET /v1/auth/session` → `{user:{id,name,email,role},patients:[{id,name,timezone}],csrf_token}`.
- `POST /v1/auth/logout`.
- `GET /v1/app/patients/{patient_id}/dashboard` → `{patient,devices,medication_plans,doses,notes,measurements,preventive_tasks,support_requests,followups,proposals,permissions}`. All collection keys are arrays. Times are ISO strings; unspecified facts remain null. Permissions are enforced server-side.
- `POST /v1/app/patients/{patient_id}/proposals` `{kind,payload}` → immutable proposal `{id,kind,payload,readback,status,expires_at}`. Kinds: `health_note`, `medication_report`, `measurement`, `preventive_task`, `support_request`, `followup`.
- `POST /v1/app/proposals/{id}/revise` `{payload}` → new proposal, old one invalidated.
- `POST /v1/app/proposals/{id}/confirm` `{confirmed:true}` → `{status:"committed",record_type,record_id}`; retries return the same record.
- `POST /v1/app/patients/{patient_id}/medication-plans` → checked, versioned plan. Explicit human review, source, medicine instructions and schedule required. Never AI-activated.
- `POST /v1/app/support-requests/{id}/acknowledge`; `POST /v1/app/support-requests/{id}/resolve` `{outcome}`.
- `POST /v1/app/devices/claim` `{code,patient_id}`; `POST /v1/app/devices/{id}/revoke`.
- `DELETE /v1/app/notes/{id}` and explicit sharing/grant management must affect subsequent reads and summaries.
- `POST /v1/app/patients/{patient_id}/summaries` `{start_date,end_date}` → source-linked draft.
- `PUT /v1/app/summaries/{id}` → reviewed edits/omissions; `POST /v1/app/summaries/{id}/share` → explicit expiring read-only share. Shared views must fail on expiry/revocation/source invalidation.

Include CSRF token on mutating authenticated requests in `X-CSRF-Token`. Frontend should use a typed API module and adapt its exact response models against the actual backend OpenAPI schema during integration. Backend publishes detailed payload examples early in `backend/API.md` and communicates deviations.

## Device API

Implement the endpoints, envelopes, expiry, confirmation and retry semantics in Hardware-Software-Integration.md. Authenticate HTTPS and WSS using `Authorization: Bearer <unique device credential>`. Audio is 16 kHz, mono, signed 16-bit PCM WAV, 0.3–20 seconds, upload cap 768 KiB. Device emits JSON heartbeat messages over the WSS socket with `type:"heartbeat"` and optional `battery_mv`, `rssi`, `firmware_version`. Never log credentials or raw health content.

Commands use `type:"reminder.play"`, an event ID, server time, expiry, and payload with command ID, dose ID, plan version, context ID and relative audio path. Device acknowledges separately from patient confirmation. Persistent command ledger prevents replay after reboot.

## Provider interface (root-owned)

`backend/app/providers.py` exposes `get_provider()` returning an object with:

```python
async def transcribe_audio(wav: bytes) -> str: ...
async def interpret_turn(transcript: str, context: dict) -> dict: ...
async def synthesise_speech(text: str) -> bytes: ...
```

Interpretation is untrusted JSON: `{"intent":"proposal|confirm|correct|clarify|explain|chat","kind":null,"payload":{},"spoken_text":"..."}`. Context includes the current proposal, active checked medication plan/doses, permitted recipients and current care tasks. Backend validates each field and ID, grounds explanations, identifies ambiguity, applies confirmation transactions, and gates all writes. A model-produced `confirm` intent is insufficient without an explicit confirmation utterance for the current proposal.

Production provider configuration is explicit. A developer test adapter may consume a fixture transcript through a backend-only test harness gated behind explicit test mode; never expose a phone voice UI or claim tone/silence is TTS. Unconfigured live provider calls must fail honestly.

## Verification boundary

Local tests can prove software behavior and compiled firmware. Only a real cardholder can prove acoustics, battery, GPIO wiring and end-to-end physical acceptance. External service accounts and CodeBuddy/WorkBuddy competition evidence must be recorded honestly; never fabricate use or results.
