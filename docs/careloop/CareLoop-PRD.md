# CareLoop: product requirements document

Version 0.3 · 22 September 2026 · Proposed MVP specification

**Product:** a voice companion inside a lanyard cardholder for older adults, connected to a phone-friendly care dashboard.

**Ownership:** the supplier assembles and tests the hardware. The project team writes the ESP32 firmware, Tencent-hosted backend, AI integration, and dashboards.

**Status:** this document defines the build. No hardware connection, cloud deployment, battery result, or clinical benefit has been demonstrated yet. Targets below are proposed acceptance criteria, not observed results.

Read alongside [Hardware–software integration](Hardware-Software-Integration.md) and the [Chinese supplier handoff checklist](Supplier-Handoff-Checklist-ZH.md).

## 1. Problem and opportunity

Older adults managing medication may find it difficult to remember their routines, understand instructions, and capture symptoms or questions before appointments. Family caregivers may receive incomplete updates and cannot easily distinguish an unanswered reminder from a reported skipped dose. These are working problem hypotheses based on the user's concept and hackathon brief; interviews have not yet validated their frequency or severity.

CareLoop lets a person speak when a concern occurs, hear a read-back, and save a confirmed record that can be shared with the appropriate supporter. Its defining interaction is **speak → clarify → confirm → record → follow up**.

## 2. Decisions and assumptions

| Item | MVP decision | Basis / remaining uncertainty |
|---|---|---|
| Form | Necklace/cardholder: front card slot, electronics behind, breakaway strap | User requirement; dimensions and weight await supplier |
| Hardware | ESP32-S3, I²S microphone, I²S amplifier, speaker, tactile button, haptic motor and driver, protected rechargeable battery | User's reference component list; final modules and GPIO map must be frozen |
| Processing | Device captures/plays audio; backend interprets it | User requirement |
| Network | Pendant connects over 2.4 GHz Wi-Fi to the project backend hosted on Tencent Cloud | Follows the user's latest Tencent/Wi-Fi specification |
| Phone | Responsive web app, installable as a PWA if useful; reads the same backend | Proposed choice to support phones without a native Bluetooth bridge |
| Phone's role | Dashboard; optionally supplies a Wi-Fi hotspot | Audio does not pass through the phone application in this MVP |
| Prototype approach | Build the voice experience on the ESP32-S3 pendant from the start | The phone-first voice prototype is removed from scope; developer API fixtures are test tools only |
| Audio interaction | Deliberate push-to-talk, short recordings, turn-taking | User requirement; press-and-hold is the initial control mode |
| Initial language | English for the first end-to-end test; language stored per user | Assumption; validate intended users' language before usability testing |
| Cloud location | Prefer Singapore for the application server if available in the team's account | Speech/AI processing locations must be checked separately |
| Data | Fictional profiles and reviewed demonstration medication content during development | Real-user pilot requires separate readiness review |
| Quantity | 1–2 hardware prototypes | Current sourcing plan |
| Deadline | Not supplied; milestone plan rather than a promised delivery date | Owner: project team |

The ESP32-S3 supports BLE but not Classic Bluetooth. The current plan therefore uses Wi-Fi for audio; a future phone-as-audio-gateway design needs a separate native-app transport decision. [Espressif Bluetooth documentation](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/ble/overview.html)

## 3. Goals and measurement

Targets are hypotheses to use during testing, not claims about treatment effectiveness.

| Goal | Measure | Initial success target |
|---|---|---|
| Make a health note without navigating an app | Moderated test: report a symptom, correct one detail, confirm | At least 4 of 5 intended users complete it with no facilitator action after onboarding |
| Preserve medication reporting accurately | Scripted tests covering taken, skipped, ambiguous, and no response | 100% of the scripted cases retain the correct reporting state; no inferred ingestion |
| Provide responsive interaction | Instrumented trials with clips ≤10 seconds on the agreed demo network | Local recording feedback within 300 ms; p95 release-to-reply audio ≤8 seconds across 30 trials |
| Make confirmed information available promptly | Time from database commit to an open authorised dashboard | p95 ≤2 seconds across 30 events |
| Sustain useful wear during a demo | One-hour run with Wi-Fi connected, 20 turns, and 3 reminders | No reset or audio/power failure; report measured battery consumption |
| Preserve reported measurements | Scripted reading, correction, ambiguous-number and lost-acknowledgement cases | All committed fields match the explicitly confirmed values; no duplicate measurements |
| Complete preventive-care follow-through | One fictional care-plan task moves from due to arranged to completed | Each update is confirmed and appears in the timeline and visit summary |

For a later 14-day formative pilot, proposed lagging targets are: 60% of enrolled users use the core flow on at least 8 days, and 80% of shared requests are acknowledged within the individual caregiver's agreed response window. Set a baseline first; these are engagement measures, not evidence of improved health or medication adherence. Measure caregiver workload and unwanted alerts alongside usage.

## 4. Users and stories

| Persona | User story |
|---|---|
| Older adult | As an older adult, I want to report a concern by speaking so that I do not need to remember it until an appointment. |
| Older adult | As an older adult, I want to hear and correct the device's interpretation so that my record reflects what I meant. |
| Older adult | As an older adult, I want medication reminders and a readable history of what I reported so that I can check my routine. |
| Older adult | As an older adult, I want explanations tied to my recorded instructions so that unfamiliar medication terms are easier to understand. |
| Older adult | As an older adult, I want to know when a message failed so that I can use another way to get help. |
| Older adult | As an older adult, I want control over sharing so that personal conversations do not automatically become family updates. |
| Older adult | As an older adult, I want to report a reading from my existing monitor and review its history so that I can prepare useful questions for my next visit. |
| Older adult | As an older adult, I want to keep track of a screening, vaccination or follow-up already in my care plan so that I can arrange and complete it. |
| Family caregiver | As a caregiver, I want a short list of unresolved requests and reported difficulties so that I know what requires follow-up. |
| Clinician | As a clinician reviewing an appointment report, I want the original reports, dates, and uncertainty behind a summary so that I can assess it. |
| Project developer | As the software developer, I want the exact pin map and hardware diagnostics so that I can develop firmware independently of the supplier. |

## 5. MVP requirements

P0 is required for the scoped demonstration. Acceptance tests use fictional data unless otherwise stated.

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| R01 | P0 | Associate one device with one patient profile | A signed-in owner claims a device using a one-use possession code. A second account cannot claim it. Revocation stops device access. The backend derives patient identity from the authorised binding. |
| R02 | P0 | Capture deliberate voice input | Holding the button starts recording after a short haptic cue; release stops it. Recording is capped at 20 seconds. The microphone is inactive during idle and response playback. A short accidental press creates no care record. |
| R03 | P0 | Speak back and confirm health notes | Given a symptom report, the system asks only for necessary missing details, reads back a draft, and saves a confirmed note only after an explicit response. Unstated fields remain unknown. A correction produces a revised draft before confirmation. |
| R04 | P0 | Maintain a checked medication plan | The owner/caregiver enters name, instructions, schedule, timezone, and source. Activation requires checking against the current prescription/label. Editing creates a new version and cancels queued reminders from the previous version. |
| R05 | P0 | Deliver scheduled reminders while connected | A due reminder is queued, delivered, and acknowledged as playback completed separately. In a healthy connected idle device, playback starts within 10 seconds of due time in scripted tests. Expired reminders do not play after reconnection. |
| R06 | P0 | Record medication use as a report | Taken, skipped, not-yet, uncertain, and no-response cases remain distinct. Identify the medicine and scheduled occurrence, read back the reported status and any stated taken time, then require explicit confirmation under R19 before committing a report. Ambiguous references prompt clarification. Delivery never means taken; silence remains unconfirmed. |
| R07 | P0 | Explain known medication instructions | Responses use the active medication record and reviewed reference text, with source/version visible in the app. Unknown medicines and treatment-change questions produce a request to consult the relevant professional. The system does not generate replacement doses or missed-dose instructions. |
| R08 | P0 | Create and acknowledge support requests | A user can confirm a request such as refill assistance, select sharing, and see sent/acknowledged/resolved states. Record a reported adherence barrier without guessing its cause, offer a follow-up check and capture the reported outcome. Silence does not resolve the barrier. The pendant claims a caregiver has seen a request only after explicit acknowledgement; urgent requests show the configured calling route without implying dispatch. |
| R09 | P0 | Provide the phone and caregiver views | An authorised user can see today's reminders, reported dose states, confirmed notes, measurements, preventive tasks, request status, device connection and last-seen time. A caregiver sees only information permitted by the patient. Cross-account access tests fail closed. The phone remains a dashboard, not a voice prototype. |
| R10 | P0 | Track preventive-care tasks from an existing plan | Store the task type, description, source, due date and timezone for a screening, vaccination or follow-up already in the entered care plan. Support planned, due, arranged, completed, declined and needs-discussion states. Read back and confirm user changes. Demonstrate one task moving due → arranged → completed, including appointment and completion dates when known. No automatic eligibility calculation, booking or inferred completion. |
| R11 | P0 | Be clear about failures and retention | Failed upload plays a local failure prompt and never reports success; a lost acknowledgement is described as receipt unconfirmed until reconciled. One unacknowledged clip can remain temporarily in RAM; it expires after 60 seconds and is lost on power-off. No offline persistence is advertised. Deleting/revoking a shared note removes it from future dashboard reads and summaries. |
| R12 | P0 | Provide a respectful companion experience | Use the chosen name, language, short sentences, and one question at a time. Include a greeting and optional daily check-in. Casual conversation creates no clinical note or shared event without confirmation and permission. |
| R13 | P1 | Reduce interaction effort | Add a tap-to-start/tap-to-stop mode and repeat control after testing button usability; each mode has a distinct recording indication and an inactivity limit. |
| R14 | P1 | Extend companionship and language support | Add selected interests, family voice messages, and a second language. Each is opt-in and tested with intended accents; private memory is separable from care records. |
| R15 | P1 | Support stronger offline and battery behaviour | Add an encrypted pending queue and versioned local reminders only after power measurement and stale-schedule rules are agreed. Offline states are visible and conflicts never change treatment instructions automatically. |
| R16 | P2 | Expand hardware and clinical integrations | Explore phone relay, Bluetooth measurement imports, native push notifications, and clinical-system connections only after interoperability and workflow validation. |
| R17 | P0 | Log external readings and show a simple history | Support user-reported blood pressure from an existing monitor for the first demo. Store systolic and diastolic values, mmHg, occurrence time or stated approximation, timezone, source and reporting actor. Read back the material fields and obtain confirmation before saving. Plot confirmed readings with dates, units and sample count; missing readings remain missing. A single reading is not a trend, and numerical differences do not establish a diagnosis, improvement or cause. The pendant does not measure blood pressure. |
| R18 | P0 | Prepare a reviewed appointment summary | On request, draft a summary for a chosen date range with medication reports, symptoms, readings, preventive-task status, unresolved barriers and patient questions. Link statements to entries and distinguish reported information from interpretation. The owner reviews and can correct or omit content before deliberate sharing in the authorised read-only view. Unknown and unconfirmed states remain visible. |
| R19 | P0 | Apply one confirmation policy to record changes | Voice-created health notes, medication reports, measurements, preventive-task updates and support requests require read-back of material fields and explicit confirmation of the current proposal. Corrections create a revised proposal requiring fresh confirmation. In the dashboard, the equivalent is a review screen with an explicit confirm action. Upload acceptance or playback completion never means a record is confirmed or saved. |

### 5.1 Confirmation and record integrity

The backend creates an immutable proposal for each proposed record change. It reads back the relevant medicine and scheduled occurrence, measurement values and units, task state, event time and sharing recipient as applicable. Do not invent an exact occurrence time when the patient gives an approximation; preserve that wording or ask when precision is necessary.

A clear confirmation applies only to the currently identified proposal. A correction replaces the pending proposal and invalidates the old confirmation context. A late, ambiguous or context-free yes requires clarification. A dose proposal references its medication-plan version; if that version changes while confirmation is pending, recheck the reference and clarify rather than silently applying the old proposal.

Use separate states for audio accepted, awaiting confirmation and record committed. Only a successful database commit permits the spoken saved acknowledgement. Retries reconcile the existing proposal and committed record; they never create a duplicate. If the acknowledgement is lost, tell the user the outcome is unconfirmed until the existing record status is recovered.

This confirmation policy applies to user-authored facts and changes. System-derived delivery states, a task becoming due according to its recorded date, and the absence of a response can update automatically, but cannot become a claim about patient behaviour. Pure questions and explanations create no care event without a separate confirmed proposal.

### 5.2 Challenge coverage

| Challenge area | Requirements | Minimum demonstration |
|---|---|---|
| Medication understanding | R07 | Ask about a known medication and hear a sourced explanation |
| Medication management | R04–R06 | Trigger a reminder and save an explicitly confirmed medication report |
| Adherence support | R08 | Record a reported obstacle and demonstrate a follow-up outcome |
| Health tracking | R03, R17 | Confirm a symptom or reading and inspect dated measurement history |
| Preventive health | R10 | Move one care-plan preventive task from due to arranged to completed |
| Healthcare preparation | R18 | Review a source-linked summary and question list before sharing |

Existing requirement IDs remain stable. R17–R19 add measurement tracking, separate visit preparation from R10, and make the common confirmation policy explicit. All six areas are required for the complete scoped demonstration; a partial voice-note demo is an intermediate milestone.

## 6. Scope boundaries

The MVP does not diagnose symptoms, recommend treatment changes, infer that medication was swallowed, or measure vital signs. It does not provide fall detection, continuous listening, or a monitored emergency service. These capabilities would require different evidence, hardware, or operating arrangements.

All-day battery life, waterproofing, a custom PCB, and commercial-product readiness are future engineering outcomes. A read-only appointment report is the first clinician interface; an actively staffed clinician alert dashboard is outside the initial release.

## 7. Core journeys

**Medication:** checked plan → scheduled dose instance → reminder command → device playback acknowledgement → user report → resolve ambiguous medicine or time → spoken read-back → explicit confirmation → committed user-reported state. Delivery, confirmation and database commitment are separate records.

**Health note:** push-to-talk → transcript → draft details → spoken read-back → explicit confirmation → private care note → optional permitted sharing → appointment summary.

**Support request:** spoken request → read-back with recipient → confirmation → shared task → caregiver acknowledges → user can hear that acknowledgement → task resolved with a human-entered outcome.

**Medication explanation:** identify medicine from the active plan → retrieve approved information → brief sourced explanation. If identity or instructions are uncertain, ask a clarifying question or direct the question to a pharmacist/clinician.

**Measurement:** report a reading from an external monitor → identify values, units, source and occurrence time → spoken read-back → explicit confirmation → dated history with provenance. A correction supersedes the earlier value while preserving an audit trail; later summaries use the current confirmed value.

**Preventive care:** enter a task from the existing care plan → task becomes due → patient reports an arrangement → read-back and confirmation → arranged → patient reports completion → read-back and confirmation → completed. Due date and scheduled appointment date are distinct; time passing alone does not establish completion.

**Visit preparation:** choose a date range → draft a summary from current confirmed entries and labelled unconfirmed states → patient reviews and corrects → deliberate sharing. Include readings, preventive-task progress and unresolved concerns. Sharing is never inferred from a person being mentioned.

**Failure:** connection unavailable → local failure indication → no fabricated success → phone/calling alternative. A connected status measures device reachability, not the patient's wellbeing.

## 8. Screens and information structure

| Screen | Essential content |
|---|---|
| Setup | Patient profile, language, timezone, consent, device claim, network status, checked medication plan |
| Today | Next reminders, due preventive tasks, recent self-reports, unconfirmed items, device last seen |
| Health timeline | Confirmed notes and measurements, dated reading chart with units and sample count, user wording, occurrence time versus entry time, corrections, sharing state |
| Preventive care | Task source, due date, arranged appointment date, completion date when known, current state and explicit review/confirmation for edits |
| Caregiver tasks | New/acknowledged/resolved requests with recipient and timestamps |
| Medication details | Source instructions, active version, dose history, clarification questions |
| Visit summary | Chosen time range, reported patterns, measurement history, preventive-task states, medication concerns, unresolved barriers, editable questions, source links and review before sharing |
| Settings | Access grants, retention controls, preferred name/language, device revoke/reset, connection help |

Use large controls and readable text, explicit labels in addition to colour, adjustable audio, and captions. The pendant should not require reading a screen to complete a turn. Haptics complement audio; they do not guarantee accessibility for every user.

## 9. Data and permissions

The principal records are Patient, User, AccessGrant, Device, MedicationPlanVersion, DoseInstance, ReminderDelivery, VoiceTurn, ConfirmationProposal, HealthNote, Measurement, PreventiveTask, VisitSummary, SupportRequest, FollowUp, and AuditEvent. Technical identifiers and examples are in the integration document.

Measurement stores type, named value fields, units, occurrence time or approximation, timezone, source description, reporting actor, source turn, confirmation reference and correction history. PreventiveTask stores care-plan source, task type, due date, appointment/completion dates when known, status and confirmed transition history. VisitSummary stores its date range, source record IDs and versions, owner edits and sharing state. FollowUp records when an agreed check should occur and the reported outcome; it does not automatically declare a barrier resolved. Changes or deletions invalidate affected summaries until regenerated.

Medication source text remains separate from AI summaries. User-confirmed reports retain their original confirmed wording and provenance. Reported symptoms do not become measured medical findings, and apparent associations do not become causal claims.

The patient/authorised owner controls caregiver access. A clinician receives only a deliberately shared, time-limited read-only view for the demo. Caregivers can acknowledge tasks and enter proposed plan changes; AI cannot activate a medication plan. No conversation is routed to a contact simply because the person was mentioned.

Development uses fictional profiles. Raw uploaded audio is transient by default: delete after transcription succeeds or terminal processing failure, with a 24-hour cleanup maximum for abandoned jobs. No raw-audio archive is included in the MVP. Confirmed text and care events remain until owner deletion during the prototype. Before real users, agree retention, backups, data locations, access/revocation and deletion handling with the project owner. Application hosting location alone does not establish where external AI providers process data.

## 10. Architecture and supplier boundary

```mermaid
flowchart LR
  P["Pendant: ESP32 firmware"] <-->|"HTTPS audio and WSS commands"| B["Tencent-hosted application backend"]
  B <--> A["Speech recognition / AI / speech synthesis"]
  B <--> D[("Care records and permissions")]
  U["Phone web app"] <-->|"HTTPS and live updates"| B
  C["Caregiver / clinician views"] <-->|"Authorised access"| B
```

The diagram reflects the hardware-first prototype. A phone hotspot provides network access; it does not process pendant audio. The phone web app is a dashboard, not a substitute voice client. The first end-to-end product demonstration runs on the actual ESP32-S3 hardware.

| Work | Supplier | Project team |
|---|---|---|
| Component selection, wiring, charging/protection, enclosure | Build and document | Approve interface and size before assembly |
| Basic hardware diagnostic program | Run; request source and build notes as part of handoff | Reproduce before application development |
| Application firmware and network protocol | No production software responsibility | Own and implement |
| Tencent backend, AI, app and dashboards | No backend credentials or patient data required | Own and implement |
| Acceptance | Show recording/playback, motor, button, charge and power tests | Run complete care flows on received hardware |

## 11. Delivery plan and dependencies

| Stage | Output | Exit condition |
|---|---|---|
| A. Freeze interfaces, before assembly | Exact board/BOM, GPIO map, power diagram, USB access, acoustic layout | Supplier answers the handoff checklist; incompatible parts resolved |
| B. Backend contract testing, while hardware is built | Developer test harness with WAV fixtures and test-only credentials; no phone voice UI | Upload, reply, confirmation and dashboard updates pass API tests; product acceptance still requires the actual pendant |
| C. Hardware bring-up, indicative 1–2 working days | Record/playback, button, haptics, Wi-Fi, valid HTTPS | Test recording is intelligible at intended wearing position; no power reset |
| D. Connect the vertical slice, indicative 2–3 working days | Real device note → confirmation → dashboard | Thirty scripted turns pass the defined transport and reporting tests |
| E. Care features, estimate to revisit for expanded scope | Medication flow, explanations, caregiver follow-through, confirmed readings/history, preventive tasks and reviewed visit summary | All six challenge areas and the common confirmation tests pass |
| F. Demo rehearsal and formative usability | Measured latency, power, failure behaviour, user task completion | Known limitations recorded; failures fixed or scope changed explicitly |

These are planning estimates for a developer already comfortable with the stack. Stages overlap; sourcing, supplier delivery, learning embedded development, and revisions can dominate the schedule. No calendar deadline is assumed.

The first implementation milestone is **wear pendant → report a symptom → hear read-back → confirm → see the note on the phone**. Only then add scheduled medication reminders.

## 12. Risks and decisions still needed

| Question / risk | Owner | Blocking point | Next action |
|---|---|---|---|
| Exact ESP32-S3 module, available pins and audio modules | Supplier + firmware developer | Before final assembly / pin-specific code | Freeze BOM and signed-off connection map |
| Low volume or clothing noise at chest height | Supplier + UX | Before enclosure freeze | Record and play speech in the actual holder with card inserted |
| 500 mAh versus connected reminder availability | Firmware developer | Before any all-day claim | Measure active/idle current and reminder latency; choose duty cycle |
| Tencent account, region, ASR/TTS/LLM access and credentials | Backend developer | Before live AI integration | Test one synthetic sentence through the chosen provider adapters |
| User language and preferred button behaviour | Product / UX | Before user testing | Confirm with intended users; make defaults explicit |
| Phone platform / hotspot behaviour | App developer | Before mobile rehearsal | Test actual phones and 2.4 GHz connectivity |
| Deadline, team skills and budget | Project owner | Before scheduling commitments | Map stages to available people and received-hardware date |
| Reviewed medication content and help-routing wording | Product + clinical adviser | Before real care use | Review fixed content and escalation wording; no improvised dosing logic |
| Real-user consent, retention and provider processing locations | Project owner | Before a real-user pilot | Record data flow and access decisions; remove test accounts and secrets |

## 13. Definition of done

- Supplier handoff is complete and the received hardware passes the bench checklist.
- All P0 requirements pass on the actual target board and demonstration network, including disconnect, retry, stale reminder, and ambiguous-dose cases.
- Firmware, API and app builds are reproducible; secrets are outside source control.
- Demonstration data is fictional; shared access is explicit and revocable.
- Battery runtime and acoustic performance are reported as measurements with conditions.
- The team can run the core flow from a fresh device setup, and explain the current offline and emergency-service limits accurately.

### 13.1 Required scenario checks

- **Medication ambiguity:** two possible medicines lead to clarification. A read-back and explicit confirmation are required before committing either report; silence leaves it unconfirmed.
- **Measurement correction:** the patient corrects a value during read-back. Only the revised, confirmed proposal is committed; the chart and summary show that value with its unit, source and occurrence time.
- **Lost acknowledgement:** interrupt the connection after commit. Recovery returns the existing record without creating a duplicate or falsely saying it was not saved.
- **Preventive task:** a due fictional task becomes arranged and later completed through separate confirmed updates. Advancing time without a report does not complete it.
- **Barrier follow-through:** record an obstacle and an agreed follow-up; an unanswered follow-up remains unresolved. Record a human-reported outcome when provided.
- **Summary review:** readings and care-task states appear with source links; a correction regenerates the affected summary, and revoked/deleted content is excluded from future access.

### 13.2 Hackathon submission evidence

- Build using at least one of CodeBuddy or WorkBuddy and retain proof of its use, as required by the supplied brief. Tencent hosting alone does not satisfy this tool-usage requirement.
- Retain the development conversation history and at least three screenshots of CodeBuddy or WorkBuddy development chats. Review screenshots for credentials or personal information before submission.
- Identify Challenge Statement 2 in the presentation and show the six-area coverage matrix with actual demonstration evidence. Keep seeded history visibly fictional.

## 14. Evidence and reference notes

The product assumptions come from the supplied Tencent Cloud Hackathon Singapore 2026 brief and subsequent conversation, not completed user research. The supplied PDF `c1b7982c-2730-4fc5-aa8f-7e540f8b1628 (2).pdf`, pages 31–33, defines Challenge Statement 2 and its six areas; page 35 defines CodeBuddy/WorkBuddy usage and development-chat evidence requirements. The brief is competition context, not permission to register, publish or share data. Engineering recommendations remain proposed design decisions. Manufacturer references support capability checks, not proof that the complete prototype works:

- ESP32-S3 I²S input/output capability: [Espressif I²S documentation](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/peripherals/i2s.html).
- BLE/Classic Bluetooth distinction: [Espressif Bluetooth overview](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/ble/overview.html).
- Secure WebSocket implementation starting point: [Espressif WebSocket client](https://github.com/espressif/esp-protocols/blob/master/components/esp_websocket_client/README.md).
- Reviewed medication-management principles: [National Institute on Aging](https://www.nia.nih.gov/health/medicines-and-medication-management/taking-medicines-safely-you-age).

References checked during preparation on 22 September 2026; verify service availability in the project's actual cloud account.
