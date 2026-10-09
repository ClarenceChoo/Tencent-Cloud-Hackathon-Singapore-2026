# Pocket workflow research for Parse

Research date: 2 October 2026 (Singapore). Parse baseline: `ce742b8`.

## Recommendation

Borrow Pocket's immediate capture, visible processing, and clear follow-through. Preserve Parse's explicit confirmation, scoped sharing, immutable proposals, and distinction between reminder playback and a medication report.

The first implementation should improve three existing journeys: recording receipt, setup completion, and caregiver action triage. These reuse current care APIs. Offline capture, general conversational search, and consultation recording need separate backend or device work.

This is a research and source-review brief, not a usability test or an implemented redesign. No application behavior was changed.

## Scope and evidence limits

Audience: older adults using the browser/native companion or physical cardholder; owners who configure the care space; caregivers who receive permitted updates. The study examines capture, pairing, processing, correction, organization, action handoff, recovery, and sharing.

Sources include Pocket's live product page, setup guide, feature documentation, public changelog, trust page, and specific community reports. Public searches also covered Reddit, GitHub, Hacker News, Stack Overflow, X, and YouTube. Pocket's own documentation and community were the strongest usable sources. Broad searches produced unrelated Pocket products and promotional material; those were not treated as evidence. An App Store review page could not be fetched directly. No private connectors, paid account, authenticated Pocket app, or physical device were used.

The product landing page was visually inspected. Parse was reviewed through its source and documentation, rather than a newly executed browser test. Repository evidence describes earlier local checks; those do not establish current live speech quality or physical acceptance.

Official documentation establishes advertised/documented behavior, not measured reliability. Community reports establish that a person reported a problem, not its root cause, prevalence, or persistence in the latest app. The January/February reports below predate later changelog fixes. Benefits proposed for older adults are hypotheses to test with that audience.

## Workflow comparison

| Stage | Pocket's documented pattern | Parse at the reviewed revision | Useful adaptation |
| --- | --- | --- | --- |
| Start | Physical recording button; distinct recording indication | Browser tap/send; cardholder hold/release | Keep capture prominent and deliberate; teach each device's actual gesture |
| Connectivity | Record offline and sync later | Web page must remain active; cardholder uses Wi-Fi and transient audio | Explain boundaries now; evaluate durable offline capture separately |
| Processing | Recording moves through upload and analysis toward a summary | Accepted turn, interpretation, expiring read-back, confirmation | Show honest milestones and preserve one turn identity |
| Review | Summaries, transcript-related tools, templates | Validated typed proposals with explicit confirm/revise/cancel | Simplify presentation while retaining exact material-field review |
| Follow-through | Central checklist and calendar handoff | Support, follow-ups, preventive tasks and doses across views | Consolidate permitted actions without merging their meanings |
| Retrieval | Ask Pocket and recording filters | Timeline category filters; specific voice status/explanation intents | Add bounded, source-linked record search |
| Sharing | Export/integrations and share flows | Reviewed summaries with expiring, revocable links | Add purpose-specific summaries and optional reviewed exports |

Pocket's documented workflow is capture → sync → understand → act. Parse should make its own loop equally legible: capture → receive → review → confirm → make available to the chosen caregiver → follow up. Pocket's [Day 1 guide](https://guide.heypocket.com/step-3-your-day-1-with-pocket/5Y1rhXpY44j9q19XGBhum6/your-day-1-with-pocket/5Y1rhXpY45Br4dBS1HJt98) and [docs overview](https://docs.heypocketai.com/docs) ground the comparison.

## Ranked opportunities

### 1. Give every recording a clear receipt and next action

**Problem and user goal:** After speaking, a person needs to know whether anything arrived and what to do next. This is especially important after a timeout, reload, or failed spoken reply.

**Evidence:** Pocket documents distinct processing stages and recovery from recording details. A February community report describes a playable device file that never appeared in the app despite normal recording feedback. This supports the importance of separate capture and receipt states, not a conclusion that Pocket always loses recordings. [Processing documentation](https://docs.heypocketai.com/docs/features/productivity/summary), [reported sync failure](https://community.heypocket.com/t/recording-appears-to-start-and-stop-correctly-but-files-do-not-sync-or-appear-in-app/1431).

**Parse baseline:** `Companion.tsx` already has recording/sending/waiting/reply phases, pending-turn recovery, and a Check recording action. `turns.py` binds each key to audio digest and context and rejects conflicting reuse. The opportunity is clearer presentation of existing guarantees.

**Proposed behavior:** Show one persistent interaction card with honest milestones: recording captured, receipt unknown or received, processing, ready to review, confirmed and saved. Unknown receipt offers Check recording; it must not silently send another recording. A final receipt identifies the record, reported event time, confirmation time, and permitted recipients. Say that content is available to Jamie, not that Jamie saw it. Only an explicit support acknowledgement establishes that acknowledgement.

Do not invent percentages or ETA from a generic waiting state. Do not describe transient audio as safely saved locally. Keep the caregiver's private content out of diagnostic receipts.

**Rank:** High severity when state is ambiguous; repeated public sync signals but no failure-rate estimate. High confidence in the design need and current code mapping; medium confidence in the effect on older adults. Effort: small for UI milestones, medium for richer server receipts. Validation: users distinguish received from confirmed, uncertain receipt does not cause duplicate uploads, and retries yield one record.

### 2. End onboarding with the first successful care loop

**Problem and user goal:** A paired device is not necessarily connected, selected for reminders, capable of speech, or successfully sharing records.

**Evidence:** Pocket onboarding includes a practice interaction and then directs users to a first recording. [Pairing guide](https://guide.heypocket.com/step-1-pair-your-pocket/5Y1rhXpY43ws81igeswUKB/pair-your-pocket/5Y1rhXpY45yyMkFYP2MacQ).

**Parse baseline:** `DeviceSetup.tsx` already separates pairing, connection/selection and trying a conversation. It presents instructions, but there is no guided end-to-end completion journey. Browser approval spans companion and owner dashboard.

**Proposed behavior:** Build on those steps: connect → approve the correct care space → check connection → choose reminder destination → test speaker and microphone → record a practice update → review/cancel or explicitly save it → verify visibility under the intended caregiver account. Offer a labelled practice mode that leaves no clinical-looking record. Where a demonstration creates a real fictional record, say so and make cleanup explicit. Delay optional settings until completion. A QR link can open the correct companion origin; it must not embed a patient identifier, bearer credential, or automatic approval.

Keep owner and patient roles distinct. Pairing success must not bypass account provisioning or access grants. The web route allowlist already exposes a speaker-check operation that a guided journey could use.

**Rank:** High setup impact; documentation proves the interaction pattern, but no Parse abandonment data exists. Confidence: high in the gap, medium in expected usability improvement. Effort: medium. Validation: time and assistance needed to complete setup, wrong-patient approvals, and completion of a first confirmed update visible to the intended recipient.

### 3. Create a caregiver action inbox

**Problem and user goal:** A caregiver needs a short answer to “What needs me now?” rather than checking several sections.

**Evidence:** Pocket consolidates action items and links tasks back to their recording. [Action Items](https://docs.heypocketai.com/docs/features/productivity/tasklist).

**Parse baseline:** Today has a pending-review banner and several care cards; Support has acknowledgement/resolution and follow-up controls. Preventive tasks and medication reports have separate screens. These are existing capabilities, not missing data models.

**Proposed behavior:** Add a grouped action panel: proposals the viewer may review, support requests assigned to the viewer, permitted follow-ups due, and care-plan tasks due. Each item shows owner, due time when known, source record, status, and one primary next action. Missing information remains visibly unknown. Link into existing controls.

Do not turn an unanswered dose into a missed-dose claim, acknowledgement into completion, or overdue follow-up into an automatic outcome. Reuse backend visibility rules before computing counts; private items must not leak through badges. Begin with read-only aggregation of authorized dashboard data before expanding notifications or assignment behavior.

**Rank:** Medium-to-high workflow impact; no observed Parse completion or caregiver load metrics. Confidence: high in data availability, medium in usability benefit. Effort: small/medium for an initial view. Validation: correct next action selection and no unauthorized records or counts.

### 4. Make capture and correction purpose-specific

**Problem and user goal:** Speaking naturally is convenient, but a person may not know how to request a medication report, reading, note, or help request. A long read-back can also hide the one detail that needs correction.

**Evidence:** Pocket uses context-specific summary themes. Its current speaker tools and earlier community discussions illustrate why inferred identities and downstream summaries need correction paths. [Templates](https://docs.heypocketai.com/docs/features/productivity/templates), [speaker tools](https://docs.heypocketai.com/docs/features/ai/speaker-management), [January beta discussion](https://community.heypocket.com/t/pocket-app-revamp-beta/1204?page=6).

**Parse baseline:** Browser capture is generic. The review card displays material payload fields; typed wording revision is available for health notes, while voice correction can revise other proposal types.

**Proposed behavior:** Keep the main Talk control and add optional prompts: Report medicine, Record a reading, Share a note, Ask for help. A selection supplies context rather than proving intent. Render domain labels instead of schema-derived field labels. Ask for a missing date or recipient at the point it matters. Offer targeted corrections that generate a replacement proposal and a fresh read-back. Show the actual recipient before confirmation.

**Rank:** Medium impact; historical Pocket correction anecdotes are not evidence of current defects or Parse prevalence. Confidence: high in current generic presentation, medium in target-user benefit. Effort: medium. Validation: correction accuracy and fewer irrelevant or repeated clarification turns.

### 5. Add a reviewed vocabulary for each care space

**Problem and user goal:** Names, medicine names, and familiar phrases should be recognized without repeated correction.

**Evidence:** Pocket documents custom vocabulary and recurring word corrections. [Word Dictionary](https://docs.heypocketai.com/docs/features/device/dictionary).

**Parse baseline:** The interpreter receives active-plan medicine names, preferences, and permitted recipients. That context does not establish that the ASR provider uses a per-patient vocabulary; a dedicated vocabulary feature was not found.

**Proposed behavior:** Owners review terms and aliases, initially drawn from checked plans and permitted names. Use supported provider vocabulary hints where available. Show interpreted material terms in the read-back and ask when alternatives are ambiguous. Do not blindly replace medicine names, numbers, doses, negation, or reported times. Do not equate a high model-confidence score with correctness.

**Rank:** Potentially high care-data impact, but no measured local ASR error rate. Confidence: high in Pocket's documented pattern; medium in benefit pending actual provider testing. Effort: medium. Validation: medicine/name accuracy, preservation of negation and numbers, and English plus the actual multilingual/code-switching scenarios supported by configured providers.

### 6. Offer a small set of summary purposes

**Problem and user goal:** A doctor visit, family handoff, and weekly review need different presentations of the same verified information.

**Evidence:** Pocket documents reusable templates and combining related recordings while preserving originals. [Custom Templates](https://docs.heypocketai.com/docs/features/productivity/templates), [Combining Recordings](https://docs.heypocketai.com/docs/features/organization/combining-conversations).

**Parse baseline:** `make_summary` builds source-linked sections deterministically from care records. Summaries must be reviewed before sharing; source changes invalidate them.

**Proposed behavior:** Start with Doctor visit, Family handoff, and Weekly care review. Change selection, grouping, and language of existing confirmed evidence, preserving every source ID/version. Add a Questions to ask section as a user-authored draft, separate from reported facts. Optional PDF/print export comes after review. An export cannot be revoked after download, unlike an expiring link; communicate that at the choice point.

**Rank:** Medium impact; exact template demand is unmeasured. Confidence: high in feasibility and current provenance, medium in prioritization. Effort: medium. Validation: evidence coverage, no invented events, and invalidation after correction/deletion/sharing changes.

### 7. Introduce bounded Ask Parse retrieval

**Problem and user goal:** A caregiver should be able to find a reported fact without scrolling through days of records.

**Evidence:** Ask Pocket offers questions filtered by date and recordings. [Ask Pocket](https://docs.heypocketai.com/docs/features/ai/ask-pocket).

**Parse baseline:** Timeline has category filtering. Voice handling supports specific medication explanations and support/follow-up status, but not a general authorized historical question-answering interface.

**Proposed behavior:** First offer deterministic queries such as unresolved requests, latest reported reading, and medication report state for a chosen date. Return linked records and their dates. Expand to semantic retrieval only after permission-filtered query behavior is reliable. Retrieve authorized records before constructing model context. A query returns knowledge; it cannot confirm or resolve a record. Distinguish no report found from an event not happening.

**Rank:** Medium impact; Pocket feature presence does not prove demand among Parse users. Confidence: medium. Effort: medium for bounded queries, large for general retrieval. Validation: factual support, source coverage, access revocation, and zero private information in snippets or counts.

### 8. Research durable offline capture separately

**Problem and user goal:** A patient may need to capture a concern during a network outage and review it later.

**Evidence:** Pocket advertises on-device offline recording and documents Bluetooth, Wi-Fi and USB-C transfer options. [Product page](https://heypocket.com/pages/pocket), [Syncing Methods](https://docs.heypocketai.com/docs/features/device/syncing).

**Parse baseline:** The cardholder stores capture temporarily in PSRAM, not a durable recording queue. The browser stores recovery identifiers but not captured audio or care text. Accepted-turn recovery is already implemented and is distinct from retaining unsent audio offline.

**Proposed behavior:** Evaluate protected, capacity-bounded storage on the native app or purpose-built hardware first. Give each retained item an identity, capture timestamp, retention policy, and explicit unsent state. After reconnecting, reconcile using the original key, process in an appropriate fresh context, and request a new confirmation. A delayed recording must not confirm a stale proposal. Be explicit that no caregiver has received an unsent item. Assess whether browser storage is suitable before promising it.

**Rank:** High benefit if connectivity is a real user problem; prevalence unmeasured. Confidence: high in architectural gap, medium in need. Effort: large. Validation: power loss, capacity exhaustion, clock uncertainty, interrupted upload, duplicate suppression, and revocation/deletion behavior.

## Things to keep out of the first iteration

- Long consultation/call recording: a separate product mode, not an increased value of the current 20-second limit. It needs consent UX, storage, diarization, source correction, and review of extracted facts.
- Voiceprint-based authorization: speaker identification may help presentation; it must not establish permission to change care records.
- Automatic external publishing: calendar exports can be useful after review, but broad integrations/MCP would introduce recipient and data-scope decisions. Pocket's [Calendar Hub](https://docs.heypocketai.com/docs/features/productivity/calendar) and [MCP docs](https://docs.heypocketai.com/docs/mcp) are patterns to evaluate later.
- Mind maps and model selectors: lower priority than reliable receipts and caregiver action clarity for this audience.
- A switch to click-to-toggle physical capture without user testing: Pocket documents that gesture, but holding the current button also gives Parse a deliberate capture boundary. Test dexterity, accidental recording, and forgetting to stop before choosing.
- A pricing or retention model copied from marketing: the live page describes 30-day free summary history while a January community announcement described 90 days. Treat this as conflicting public guidance, not a resolved current entitlement. [Landing page](https://heypocket.com/pages/pocket), [plan discussion](https://community.heypocket.com/t/changes-to-the-free-plan-whats-happening-and-why/1364?page=2).

## Delivery order and evaluation

**First iteration:** clear turn receipt, plain-language review labels, guided first-use journey, and an authorized caregiver action panel. Reuse current APIs. Evaluate a short set of tasks with older adults and caregivers; record assistance, comprehension of states, correction success, and task completion. This is a suggested study, not existing evidence.

**Following iterations:** summary purposes, reviewed vocabulary, bounded record retrieval, and optional reviewed calendar/file exports. Only promote improvements supported by live provider and user tests.

**Separate feasibility work:** durable offline capture, consultation recording, speaker recognition, and background delivery. Browser behavior must continue to state that closed/suspended-page alerts are unavailable until an implemented and tested transport supports them.

## Implementation map

| Recommendation | Existing touchpoints | Material addition |
| --- | --- | --- |
| Turn receipt | `frontend/src/Companion.tsx`, `backend/app/turns.py`, `backend/app/worker.py` | Coherent state UI; optional receipt fields |
| Guided setup | `frontend/src/DeviceSetup.tsx`, `/v1/web/speaker-check`, owner approval routes | Role-specific first-use flow and safe practice behavior |
| Action inbox | `frontend/src/App.tsx` Today/Support, authorized dashboard response | Grouped presentation; later server aggregation if needed |
| Purpose/correction | `Companion.tsx`, `backend/app/services.py`, `backend/app/phone.py` | Context hints and typed correction controls |
| Vocabulary | `backend/app/providers.py`, `backend/app/worker.py` | Reviewed vocabulary storage and provider support |
| Summary purposes | `backend/app/services.py:make_summary`, summary routes in `main.py` | Purpose selector and versioned evidence-preserving output |
| Ask Parse | dashboard access rules, provenance helpers | Permission-filtered query/retrieval interface |
| Offline capture | firmware audio/network layer, native storage, turn acceptance | Protected audio queue, retention, recovery and time semantics |

## Additional source observations

Pocket's [public changelog](https://feedback.heypocket.com/announcements) describes sync progress, transcript playback, personalized getting-started guidance, vocabulary, accessibility work, and repeated recording/sync fixes. These are useful signals about where product effort went; they are not independently measured improvement rates.

The [January processing report](https://community.heypocket.com/t/possible-sync-processing-bug-older-recording-overwritten-by-newer-transcription/1274) alleges cross-recording confusion; support said it would investigate. Preserve Parse's content/key/context binding and evidence versioning. Do not present the allegation as a verified cause or security breach.

Pocket explains its data journey on a [trust page](https://heypocket.com/pages/pocket-trust). Parse can adopt that concrete communication style—what is recorded, sent, retained, confirmed and shared—using only controls verified in its own deployment. Pocket's security and compliance statements were not audited in this research. Parse's Singapore hosting alone does not establish every speech provider's processing region.

The [data-management guide](https://docs.heypocketai.com/docs/features/organization/data-management) offers recovery and export patterns. Parse already soft-deletes health notes and invalidates related summaries; a restore interface would be additional behavior and would need fresh sharing/access checks rather than automatically restoring prior distribution.
