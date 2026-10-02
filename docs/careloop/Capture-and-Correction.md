# Capture purposes and reviewed corrections

The browser companion starts in **Speak freely** mode. A person may optionally select **Health note**, **Medicine update**, **Blood pressure**, or **Ask for help** to see a suggested way to speak. Selection alone does not turn on the microphone, upload audio, or save a care record. Recording still requires a tap. When a turn is being recorded or sent, or when a proposal awaits review, the purpose choices cannot be changed.

## Turn contract

`POST /v1/web/turns`, `/v1/phone/turns`, and `/v1/device/turns` accept an optional `X-Care-Intent` header with one of `health_note`, `medication_report`, `measurement`, or `support_request`. Omission means free speech. An empty or unknown value returns `422`. Existing clients can omit the header. The accepted nullable value is stored on `voice_turns.capture_intent` and sent only as advisory context to the language interpreter. The transcript and an active `X-Context-Id` proposal take priority. The hint cannot fill missing material facts or count as confirmation.

Turn idempotency binds the device, key, original audio digest, conversation context and capture intent. An exact retry returns the original turn ID. Reusing the key with a different hint returns `409`, including when another request won the insert race. This prevents a retry from relabeling accepted audio. The browser sends no purpose hint for a spoken correction within a current proposal context. Its session storage retains only the enum and opaque recovery identifiers, never care text or audio.

## Typed correction and confirmation

The current proposal card displays material details with human-readable names rather than raw recipient or dose IDs. The browser offers correction controls for all four prompted types: note wording, symptom, stated time and sharing; scheduled dose, report state and stated taken time; blood-pressure numbers, stated time and source; support request text, urgency, barrier and permitted recipient. Dose and recipient choices come from the current Home response. The revised request carries the required unchanged fields plus edits to `POST /v1/web/proposals/{id}/revise`.

The server validates the full revised payload, checks that the old proposal is still pending and unexpired, and rejects stale medication plans, dose reports or recipient access. A successful revision invalidates the old proposal, returns a new proposal ID and context, and produces a new read-back. The browser disables confirmation while the correction form is open or a revision is in flight. Only a fresh explicit confirmation of the replacement can save the care fact. Confirmation of an obsolete proposal returns `409`; an exact retry of an already committed proposal returns the same result without creating a second record.

Received audio, a proposed update, a confirmed care record, permitted sharing, recipient acknowledgement and resolution remain separate states. Task and follow-up corrections continue through the existing voice/dashboard flow.
