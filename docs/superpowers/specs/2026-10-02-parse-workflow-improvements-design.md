# Parse workflow improvements — design specification

Date: 2026-10-02. Baseline: ce742b89060d92d35c648adc1ed84882b738bd9c.
Status: proposed implementation scope requested by the owner; product implementation has not started.

## Purpose

Make capture, review, and caregiver follow-through easier for older adults, care-space owners, and permitted caregivers. This specification turns the eight recommendations in [the Pocket research](../../research/pocket-workflow-research-2026-10-02.md) into independently tracked work. Product choices below are explicit planning defaults that can be revised in the relevant issue.

## Shared requirements

- Python 3.11+ and Node.js 22+; retain the repository's pinned Python, frontend, and native dependencies.
- Preserve explicit confirmation, immutable replacement proposals, idempotency, plan-version checks, and record-level access rules.
- Received audio, confirmed care records, permitted sharing, recipient acknowledgement, and resolution are distinct states.
- Unknown dates, recipients, outcomes, and report states remain unknown; do not infer clinical events from silence.
- Browser use requires the existing HTTPS/origin/CSRF controls. The current browser has no closed-page delivery or durable audio storage.
- Care text and audio must not enter analytics, URLs, application logs, or browser local/session storage. Existing opaque recovery identifiers may remain.
- Existing native and firmware clients remain compatible with additive API changes; new optional fields have backward-compatible defaults.
- Public UI preview remains fictional and inert: no microphone, API mutations, pairing, or provider calls.
- Changes to source records or access invalidate dependent summaries and retrieval results. Aggregate counts obey the same visibility rules as records.
- Use Alembic migrations for schema changes, test SQLite and PostgreSQL, and serialize migration integration in F04 → F05 → F06 → F08 order. If the repository advances, rebase the named migration and down_revision together before merging.
- Browser tasks include keyboard, screen-reader status, 200% text-size, narrow-screen, expired-session, and patient-switch checks.
- Execution requires current dependency installation and relevant tests. Tests described in these plans have not been run or passed as part of planning.

## Feature specifications

### F01 — Recording receipts

Browser-first persistent interaction card with capture, unknown receipt, received/processing, review, committed, cancelled, failed, and expired states. Derive receipt state from server evidence. Recovery never uploads, confirms, or automatically plays speech. Rich final details use the freshly authorized home response and committed record identity. Retain only opaque identifiers for recovery; no audio queue. A committed fact remains committed when its spoken reply expires.

### F02 — Guided first-use journey

Browser/owner guided setup: enrollment and approval, matching patient, connection, reminder selection, speaker check, explicit microphone permission, and an actual first update. Offer a locally displayed tutorial clearly marked as a demonstration; it must not count as a live voice check. An actual saved care record always uses ordinary review and confirmation. The microphone exercise can be cancelled before upload. Caregiver visibility is explicitly verified under that recipient's account; the owner view never declares that the recipient viewed a record. Native and hardware guides explain their own controls.

### F03 — Caregiver action inbox

Read-only aggregation of the already-authorized dashboard into actionable review, assigned support, follow-up, and preventive-task groups. Keep the source types and their existing write controls. No automatic assignment, new alerting, inferred missed doses, or changed permissions. Show unknown due times separately and expired proposals as unavailable for confirmation.

### F04 — Purpose-specific capture and correction

Four optional capture purposes (health_note, medication_report, measurement, support_request); omission means free speech. A purpose is a hint, never proof of intent. Persist and bind the hint to turn identity. Explicit proposal context takes precedence; reject purpose changes on an existing idempotency key. Add domain-specific review labels and typed correction controls for the four purposes, retaining server-created replacement proposals and fresh confirmation. Future task/follow-up corrections retain their current voice/dashboard path.

### F05 — Reviewed vocabulary

Owner-controlled, patient-scoped canonical terms and aliases with review metadata and optimistic version checks. Initial seed suggestions come from the checked medicine plan and permitted names; suggestions require review. No automatic transcript replacement. Provider vocabulary use is capability-gated and disabled until verified against that provider's official API and account. Unsupported providers retain normal ASR and report that vocabulary was not applied. Interpreter aliases remain advisory and cannot resolve an ambiguous material fact automatically.

### F06 — Purpose-specific summaries

Doctor visit (default), family handoff, and weekly care review presentations of confirmed, source-linked evidence. Persist purpose and template version. Author-entered questions are explicitly separate from facts and have a confirmed author identity; missing fields remain unknown. Existing date-range and current-context semantics stay visible. Review and source invalidation continue to govern share links. Provide print layout; explain that printed/downloaded copies cannot be revoked. No clinical recommendations or background auto-sharing.

### F07 — Bounded Ask Parse

Dashboard-only first release with three deterministic query intents: latest reported reading, open support requests, and medication reports for a patient-local date. Use explicit inputs and result source links. Filter access before computation; no remote LLM or embeddings in this release. Return no-report evidence honestly, distinguish empty from forbidden, and keep queries read-only. Source links remain within the current care space and are revalidated on opening. Latest reading means the latest recorded, non-superseded blood-pressure entry, with occurred-at shown separately; medication queries use the date on which doses were scheduled. Multi-row queries return at most 50 items with explicit truncation.

### F08 — Durable offline capture feasibility and pilot

Native-first opt-in pilot for unsent private health notes, after a documented device-storage feasibility gate. Browser and pendant offline capture remain separate future decisions. Proposed bounds: 10 clips, 20 seconds each, 2 MiB input per clip, 24-hour maximum queue retention. Protected atomic audio storage, original idempotency key, capture time with trust level, current installation binding, explicit queued/unknown/received states, foreground user-initiated sending, and cleanup on known revocation/reset are required. Upload after reconnection creates a fresh proposal with no stale conversation context. Caregiver delivery and medication-report confirmation are never inferred from queued audio. If encryption, crash recovery, or cleanup cannot be demonstrated on a target OS, the pilot remains disabled there.

## Delivery and dependency decisions

F01 is the foundation for F02 and the review integration of F04. F03 can proceed independently. F05 depends on F04's vocabulary/intent context boundaries and migration order. F06 follows F05 for migration integration; it has no product dependency on vocabulary being enabled. F07 follows F03's source-navigation conventions and implements a focused authorized query service; F03 itself remains a frontend selector. F08's feasibility work can start independently; its enabled pilot follows F01 and F04, with F06 preceding its schema migration.

The first delivery wave is F01/F02/F03. The second is F04/F05/F06/F07. F08 has a research gate and a separately validated pilot. Issue priorities describe relative delivery order, not clinical urgency or promised dates.

## Validation

Use repository fixtures with fictional data for automated checks. The web runner requires a fresh fixture directory and clearly simulated speech. Live ASR, physical microphones, native lifecycle, and hardware behavior require their own acceptance evidence. Collect task completion, assistance needed, receipt comprehension, and correction accuracy in a consented study with older adults and caregivers; these are planned measurements, not existing research results.
