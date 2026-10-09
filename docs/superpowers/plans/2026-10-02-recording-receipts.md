# Show recording receipts and reliable recovery states — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a browser companion user tell whether a recording arrived, needs review, or produced a confirmed care record, and recover uncertain requests without duplicate effects.

**Architecture:** Add a pure receipt-view adapter and a presentational card around the existing Companion state machine. Reuse receipt/status/home endpoints; enrich presentation from fresh authorized records rather than retaining care text or adding another upload path.

**Tech Stack:** React 18, TypeScript, FastAPI, SQLAlchemy, Vitest, pytest

**Spec:** [Parse workflow improvements](../specs/2026-10-02-parse-workflow-improvements-design.md), section F01. The feature scope below repeats the decisions needed to execute this plan.

**Priority:** P1 · first delivery wave. **Dependencies:** None.

**GitHub issue:** [#8](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/8). The complete implementation plan is also embedded in the issue.

**Research basis:** [Pocket reference](https://docs.heypocketai.com/docs/features/productivity/summary); benefits for Parse users require validation.

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

- Receipt timeout after server acceptance: checking status must not upload a second time (Task 2).
- Expired reply audio after commit: the saved record still shows as committed (Task 1).
- Patient switch or revoked installation during a late callback: clear old content (Task 2).
- Deleted record or changed sharing before receipt enrichment: omit stale details and recipients (Task 2).
- Keyboard/large-text/screen-reader use and fictional preview: truthful, accessible, inert states (Task 3).

---

## Scope and interfaces

Browser first; native recovery remains compatible and its existing tests run if shared contracts change. No new audio retention, delivery acknowledgement, or backend schema.

Create frontend/src/turnReceipt.ts:
- ReceiptPhase = 'capturing' | 'sending' | 'receipt_unknown' | 'processing' | 'review' | 'committed' | 'cancelled' | 'failed' | 'expired'.
- deriveReceipt(input: ReceiptInput): ReceiptView; ReceiptInput contains current phase, pending opaque turn key/id, optional TurnStatus, current Proposal, fresh Home, optional explicit confirmation result, and nowMs.
- ReceiptView contains phase, title, detail, primaryAction ('check' | 'review' | 'record' | null), recordId, and recipient display names derived only from current authorized data. If Home omits the recipient identity for a record kind or the record falls outside its bounded list, show a generic saved result and omit those details; never guess a match.
- Add optional record_type to TurnEvent.payload in mobile/src/contracts.ts to match worker results where present, and type companionApi.confirm as returning {status: string; record_type?: string; record_id?: string} to expose the server's existing confirmation identity. Never infer commit merely because a proposal disappeared.

Create frontend/src/TurnReceipt.tsx with props {view: ReceiptView; busy: boolean; onCheck(): void; onReview(): void}. Domain text stays in the adapter; component owns accessible presentation.

### Task 1: Define receipt semantics and component

Files: create frontend/src/turnReceipt.ts, frontend/src/TurnReceipt.tsx and frontend/src/__tests__/turn-receipt.test.tsx; modify frontend/src/companion.css and mobile/src/contracts.ts.

- [ ] Write table-driven deriveReceipt tests. Assert accepted/transcribed/processing => processing; awaiting_confirmation plus current unexpired proposal => review; confirmed result => committed; expired pending proposal => expired; an expired playback asset never downgrades committed.
- [ ] Add test snippets pinning behavior: expect(view.phase).toBe('committed'); expect(view.primaryAction).toBe(null); expect(view.detail).not.toMatch(/seen|delivered/i) for a saved shared note without acknowledgement.
- [ ] Run npm --prefix frontend test -- src/__tests__/turn-receipt.test.tsx and confirm failures identify the missing adapter/component.
- [ ] Implement the adapter and card. Show textual milestones without invented percentages. Avoid repeating the entire read-back inside the receipt.
- [ ] Re-run the focused test; all cases pass. Commit this unit as feat: add recording receipt presentation.

### Task 2: Integrate recovery and fresh committed details

Files: modify frontend/src/Companion.tsx, frontend/src/companionApi.ts and frontend/src/__tests__/companion.test.tsx; create frontend/src/__tests__/receipt-recovery.test.tsx.

- [ ] Add deferred-promise tests for timeout-after-acceptance, reload recovery, revocation, patient/device replacement, and deleted or newly private records. Use the existing mocked companionApi and Home fixture pattern. Assert api.upload is called once, api.confirm is never called by recovery, playback is not automatic, and late callbacks cannot restore cleared content.
- [ ] Run npm --prefix frontend test -- src/__tests__/receipt-recovery.test.tsx; observe missing receipt behavior.
- [ ] Feed the adapter from existing state. After confirmation, fetch home before displaying record details; match the explicit record_id and record_type. When the refresh fails, retain only the verified saved status and say details are unavailable. Persist only opaque recovery identifiers.
- [ ] Ensure Check recording uses existing read-only receipt/turn calls. Cancellation before transmission and proposal cancellation show different truthful outcomes.
- [ ] Run receipt-recovery, companion and record-source frontend tests. If shared contract changes affect native types, run npm --prefix mobile run typecheck and npm --prefix mobile test.
- [ ] Commit as feat: integrate recoverable recording receipts.

### Task 3: Verify browser behavior and document states

Files: modify tools/browser_web_companion.cjs, docs/careloop/Web-Companion.md and docs/careloop/VERIFICATION.md; create docs/careloop/Recording-Receipts.md.

- [ ] Extend the browser scenario to delay a receipt, reload, recover, confirm once, and observe the permitted caregiver record. Assert exactly one record and no automatic playback/confirmation.
- [ ] Check keyboard operation, status announcements that do not repeat on every poll, 200% text, and a 320px viewport. The public UI demo must remain inert.
- [ ] Run frontend tests/build and backend tests/test_web_companion.py plus tests/test_phone_recovery.py. Run the browser fixture command documented in the roadmap with a new runtime directory.
- [ ] Document each displayed state, what is retained locally, retry semantics, recipient wording, audio expiry, and how to troubleshoot an unknown receipt. Add dated verification results only after checks execute.
- [ ] Commit as docs: document and verify recording receipts.

## Acceptance criteria

- [ ] A user can distinguish uploaded/received, awaiting review, confirmed, and failed states.
- [ ] Unknown receipt recovery creates neither another upload nor another care record.
- [ ] A saved result never claims recipient viewing or acknowledgement without corresponding evidence.
- [ ] Expired audio, stale proposal, failed refresh, revocation, and reload have accurate outcomes.
- [ ] No new audio/care-text browser persistence; preview and existing native/pendant contracts still work.
- [ ] Documentation and browser evidence describe the implemented state model.

## Rollout

Ship the browser presentation as the default after focused and regression checks pass. Rollback removes the card/adapter integration while keeping the existing recovery ledger and API behavior. No database migration or data rollback is required.
