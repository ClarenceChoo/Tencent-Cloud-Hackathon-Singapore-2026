# Parse voice actions

The shared Parse website is the control surface for the microphone, transcript, reply, and care update. The laptop relay handles ESP32 transport and reply audio. It does not decide what gets saved.

## What happens after a recording

1. The approved relay uploads a clip under a stable recording ID. Upload retries keep that ID.
2. The voice service transcribes the audio with `gpt-4o-mini-transcribe`.
3. `interpretRecording` sends the transcript, current permitted care records, the profile timezone, and up to eight recent turns from the same recording connection to `gpt-4.1` through the Responses API with temperature zero for consistent extraction.
4. The model selects exactly one of eleven strict functions. The server validates its name, completion, argument schema, referenced records, permissions, and care-state transitions.
5. A write function creates a pending proposal. Parse displays the proposed change and reads back its details. A separate **Confirm and save** action applies the change to the dashboard. Read functions return current supplied records; a clarification asks for a missing detail.
6. The laptop relay converts the returned reply to speech. Speech synthesis is the response stage; speech recognition is the input stage.

## Available functions

| Function | Result |
| --- | --- |
| `propose_health_note` | Propose a private health observation, with explicitly requested permitted sharing when applicable. |
| `record_measurement` | Propose a reported external blood-pressure reading with source and occurrence time. |
| `report_medication` | Propose taken, skipped, not-yet, or uncertain status for one scheduled dose in the checked plan. |
| `update_preventive_task` | Propose a permitted care-plan transition or an explicitly described care-plan task. |
| `request_support` | Propose a request for an identified permitted recipient. This does not dispatch help. |
| `update_followup` | Propose a follow-up or a human-reported resolution of an existing follow-up. |
| `get_medication_explanation` | Read reviewed instructions and their stored source. |
| `get_support_status` | Read stored request status and explicit acknowledgement, if present. |
| `get_followup_status` | Read stored follow-up status and reported outcome, if present. |
| `confirm_current_update` | Bring the identified current proposal to dashboard review. Voice confirmation alone never saves it. |
| `respond_to_user` | Ask one clarification question, respond to conversation, or explain an unsupported action. |

Medication reminders, medication plan changes, calls, and outgoing messages are outside these voice functions. Existing medication controls remain available on the dashboard.

## Conversation and retry rules

Recent context is scoped to the same owner and recording room, lasts at most ten minutes, and includes at most eight completed turns. It can supply a clear answer to the preceding question, such as “this morning, with my home monitor” after “my blood pressure was 120 over 80.” A newly paired connection has separate conversation context.

The current proposal comes only from the preceding turn on that connection and must still be pending and unexpired. A spoken correction creates a replacement proposal. Reviewing an earlier recording still identifies that earlier recording's action. A manual revision of the same recording can be followed to its current revision.

Multiple distinct actions in one utterance produce a question about which one to handle first. Missing or ambiguous material facts should produce a clarification. For blood-pressure reports, the server also checks that an approximate time and measurement source quote the current utterance or its active clarification conversation; missing time or an unstated source returns a question without a proposal. Negation and hypothetical speech must not become a taken-dose report. Skipped, not-yet, and uncertain reports cannot include a taken time under the tool schema.

One processing job per connection prevents overlapping interpretations. Job leases and workspace version checks stop late or conflicting requests from overwriting newer results. A failed recording gets at most three interpretation attempts; the daily limit applies to distinct recording jobs. Completed recordings reuse their cached result without another model call. An expired proposal is reported as expired instead of being silently recreated from old audio.

The model remains probabilistic. Strict schemas and server validation prevent malformed or unauthorized writes; the dashboard review is where the person verifies that the transcript and proposed details reflect what they intended. Chat and clarification wording are model-generated. No hardware availability or clinical accuracy is implied by a passing software evaluation.

## Validation

Run these checks from the site checkout. They create fictional local D1/R2 storage and do not open a board connection:

```sh
node scripts/verify-care-intents.mjs
node scripts/verify-care-voice-jobs.mjs
node scripts/verify-care-dashboard.mjs
node scripts/verify-esp32-relay.mjs
node scripts/verify-care-activity.mjs
node scripts/verify-public-phone.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

An optional bounded semantic evaluation sends fictional phrases and fictional care context to OpenAI. Its API key must already be approved for the project; pass an absolute env-file path, never a key value:

```sh
node scripts/verify-care-intents.mjs --use-approved-demo-key --key-file=/absolute/path/to/approved.env
```

The live evaluation limits requests to twenty per run and keeps all proposed care records in isolated local storage. It exercises complete reports, missing details, unsupported reminders, medication negation, grounded reads, corrections, prompt injection, multiple actions, and a two-recording clarification.
