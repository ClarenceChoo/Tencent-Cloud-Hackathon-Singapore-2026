# Add purpose-specific capture and targeted proposal corrections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Help browser users express common care updates and correct material details while keeping every saved record explicitly confirmed.

**Architecture:** Add an optional validated capture-intent hint bound to each voice turn and present four task prompts in the browser. Use existing typed payload validation and replacement proposals for corrections; current conversation context outranks a hint.

**Tech Stack:** React, TypeScript, FastAPI, Pydantic, SQLAlchemy, Alembic, Vitest, pytest

**Spec:** [Parse workflow improvements](../specs/2026-10-02-parse-workflow-improvements-design.md), section F04. The scope below repeats the decisions needed to execute this plan.

**Priority:** P2 · second delivery wave. **Dependencies:** F01.

**GitHub issue:** [#11](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/11). The complete implementation plan is also embedded in the issue.

**Research basis:** [Pocket reference](https://docs.heypocketai.com/docs/features/productivity/templates); benefits for Parse users require validation.

## Global Constraints

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

## Review Focus

- Retry with identical audio/key but changed intent: reject with 409 (Task 1).
- Hint contradicts spoken content or an active proposal: clarification/context wins (Task 2).
- Changed dose plan or recipient access during correction: reject stale proposal and require fresh review (Task 3).
- Double confirm after edit or old async reply: commit only the current validated proposal (Task 3).
- Legacy clients omit hint and public preview blocks capture: preserve old behavior (Tasks 1 and 3).

---

## Scope and interfaces

CaptureIntent = 'health_note' | 'medication_report' | 'measurement' | 'support_request'. Omission is null/free speech. These four purposes get typed correction controls. Do not require choosing a purpose before recording.

Wire contract: optional X-Care-Intent on POST /v1/web/turns, /v1/phone/turns and /v1/device/turns; unknown nonempty values return 422. Add nullable VoiceTurn.capture_intent. Extend accept_turn(..., background, *, capture_intent: str | None = None). Include this value in idempotency comparisons and in advisory interpretation context. Existing clients continue to pass no hint.

Create frontend/src/carePurpose.ts with prompt definitions and material-field labels; create frontend/src/ProposalDetails.tsx and ProposalCorrection.tsx. A revised payload is sent to the existing proposal revise route, producing a new proposal ID.

### Task 1: Add and bind the optional hint

Files: modify backend/app/models.py, schemas.py, turns.py, phone.py and main.py; create backend/migrations/versions/0005_capture_intent.py and backend/tests/test_capture_intent.py; extend tests/test_migrations.py.

- [ ] Add API tests for each allowed hint, omission, invalid values, and same-key changed-hint retries. Assert invalid => 422; changed hint => 409; equal hint/audio/context => original turn_id. Include web forwarding/origin/CSRF assertions.
- [ ] Run cd backend && uv run pytest tests/test_capture_intent.py tests/test_migrations.py; confirm new assertions fail for the missing field/validation.
- [ ] Add nullable column via Alembic after 0004_phone_notifications. Update both uniqueness-race and normal existing-turn comparison paths. Do not modify the raw-audio hash to conceal metadata differences.
- [ ] Pass the validated hint consistently through native, web and device adapters. Existing idempotency keys remain valid with null hints.
- [ ] Test SQLite/PostgreSQL upgrade and legacy client requests; commit as feat: bind capture purpose to voice turn identity.

### Task 2: Add purpose prompts and interpretation context

Files: modify backend/app/worker.py and providers.py; create frontend/src/carePurpose.ts; modify frontend/src/Companion.tsx and companionApi.ts; extend mobile/src/contracts.ts PendingTurn with an optional captureIntent; create frontend/src/__tests__/capture-purpose.test.tsx.

- [ ] Extend backend/tests/test_capture_intent.py with intercepted-provider tests asserting the hint is advisory, current proposal context is retained and disallowed output kinds still fail validation. Use a scripted contradictory interpretation to prove that selection alone cannot create/confirm a fact.
- [ ] Add UI tests that selecting a purpose does not record, upload or mutate a care record; sending includes the chosen hint; changing purpose is disabled while a turn or current proposal requires completion.
- [ ] Run focused backend and frontend tests; confirm new behavior is absent.
- [ ] Implement four optional prompt buttons, a free-speech default and plain suggested wording. Persist only the intent enum beside existing opaque recovery IDs. For correction of an active proposal, preserve its context and do not inject a conflicting hint.
- [ ] Run focused suites and mobile typecheck for the additive contract; commit as feat: guide common care recordings by purpose.

### Task 3: Make material corrections explicit

Files: create frontend/src/ProposalDetails.tsx, frontend/src/ProposalCorrection.tsx and frontend/src/__tests__/proposal-correction.test.tsx; modify frontend/src/Companion.tsx, frontend/src/companion.css and backend/tests/test_phone_care_journeys.py.

- [ ] Add tests for blood-pressure/time correction, dose selection/status correction, note wording/sharing and support recipient correction. Assert api.revise receives all required unchanged fields plus edits, original proposal is invalidated, and confirm remains disabled until replacement is received and reviewed.
- [ ] Test plan-version drift, revoked recipient, expired proposal, old reply arriving late and double clicks. Assert 409 or fresh review and never a commit of the obsolete version.
- [ ] Run focused tests, then implement domain labels and controls using the current Home choices. Do not display raw IDs or permit arbitrary recipient/dose IDs to bypass validation.
- [ ] Run confirmation/companion tests, backend care/security/phone suites and frontend build. Verify keyboard, large text and preview behavior.
- [ ] Update backend/API.md, docs/careloop/Web-Companion.md and docs/careloop/PROVIDERS.md; create docs/careloop/Capture-and-Correction.md with intent, idempotency and correction rules.
- [ ] Commit as feat: add reviewed material-detail corrections.

## Acceptance criteria

- [ ] Four optional prompts coexist with free speech.
- [ ] The hint is validated, persisted and bound to request identity across all clients.
- [ ] A hint never substitutes for spoken intent, required facts or confirmation.
- [ ] Typed corrections create a replacement proposal and require fresh review.
- [ ] Legacy clients and the inert preview remain compatible.
- [ ] Migration, API and user documentation explain the new contract.

## Rollout

Deploy the additive migration/API first, then the browser controls. If the UI is rolled back, existing clients omit hints. Keep the nullable column and server idempotency checks; a rollback must not accept a changed hint on an already accepted turn.
