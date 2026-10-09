# Consolidate permitted caregiver actions in a single inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caregiver find and act on permitted pending reviews, assigned requests, due follow-ups and care-plan tasks from one view.

**Architecture:** Build a pure selector over the existing authorized dashboard response and a reusable action panel. Reuse current source-specific controls and permissions; avoid a new universal task model or notification system.

**Tech Stack:** React 18, TypeScript, FastAPI authorization, Vitest and pytest

**Spec:** [Parse workflow improvements](../specs/2026-10-02-parse-workflow-improvements-design.md), section F03. The feature scope below repeats the decisions needed to execute this plan.

**Priority:** P1 · first delivery wave. **Dependencies:** None.

**GitHub issue:** [#10](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/10). The complete implementation plan is also embedded in the issue.

**Research basis:** [Pocket reference](https://docs.heypocketai.com/docs/features/productivity/tasklist); benefits for Parse users require validation.

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

- Hidden records or expired grants: neither rows nor badge counts disclose them (Task 2).
- Overlapping IDs across record kinds: stable composite keys prevent lost actions (Task 1).
- Unknown due times and patient-local midnight: honest grouping and stable sorting (Task 1).
- Expired proposals or another recipient's requests: no invalid action buttons (Task 2).
- Patient switch, stale refresh or double click: existing mutations remain scoped and idempotent where supported (Task 3).

---

## Scope and interfaces

Keep the existing Today and detailed views. Add an attention panel; a source row remains the only authority for its action. Exclude unreported medication doses from inferred missed-dose actions. Do not change assignment, acknowledgement or resolution semantics.

Create frontend/src/careActions.ts:
- CareAction = {key: string; kind: 'proposal'|'support_request'|'followup'|'preventive_task'; sourceId: string; title: string; dueAt: string|null; dateOnly: string|null; group: 'review'|'assigned'|'due'|'undated'; action: 'review'|'acknowledge'|'record_outcome'|'open'; targetView: 'timeline'|'support'|'care'}.
- buildCareActions(data: Dashboard, viewerUserId: string, nowMs: number): CareAction[].
- Stable key is kind + ':' + sourceId. Evaluate date-only care-plan dates in the patient's IANA timezone, never by converting midnight UTC into a date.

Create CareActionInbox props {items: CareAction[]; onOpen(item: CareAction): void}. It receives no broader data than the authorized dashboard.

### Task 1: Implement aggregation and sorting

Files: create frontend/src/careActions.ts and frontend/src/__tests__/care-actions.test.ts.

- [ ] Write fixture-based tests for kind/ID collisions, unknown dates, due-today boundaries, resolved rows, expired proposals and unsupported states. Assert two kinds sharing an ID remain two items and an unconfirmed dose never produces a missed-dose action.
- [ ] Define sort order: review, assigned requests, due follow-ups/tasks, undated; within a group sort known due timestamps ascending and then composite key. For date-only tasks compare patient-local calendar dates.
- [ ] Run npm --prefix frontend test -- src/__tests__/care-actions.test.ts and confirm the missing selector fails.
- [ ] Implement the selector using existing permission helpers and source states. Return navigation for items without permission to mutate.
- [ ] Re-run the test; commit as feat: derive caregiver attention items.

### Task 2: Pin permissions and build the panel

Files: create frontend/src/CareActionInbox.tsx and frontend/src/__tests__/care-action-inbox.test.tsx; modify frontend/src/App.tsx and frontend/src/styles.css; create backend/tests/test_action_inbox_access.py.

- [ ] Add backend fixtures with owner, two differently scoped caregivers, private notes/proposals and individually assigned requests. Assert dashboard JSON omits forbidden records and no derived count/summary returns their existence. Tests use existing routes; add no broader list endpoint.
- [ ] Add UI tests: another recipient cannot acknowledge; read-only viewers cannot review/mutate; expired proposals cannot be confirmed; empty authorized data displays no actions.
- [ ] Run the new backend and frontend tests; security assertions may already pass and must remain regression guards.
- [ ] Render the panel on Today. Route each action to the existing proposal dialog or source view; pass a source ID to focus the selected item. On action completion refresh dashboard and recompute instead of maintaining a second task state.
- [ ] Run the focused tests plus dashboard-access, public-summary-access and confirmation tests; commit as feat: add permitted caregiver action inbox.

### Task 3: Verify live refresh and document action meanings

Files: extend tools/browser_web_companion.cjs; create docs/careloop/Caregiver-Action-Inbox.md; modify docs/careloop/VERIFICATION.md and frontend/README.md.

- [ ] Add browser cases for a newly confirmed shared request arriving, recipient acknowledgement, follow-up resolution through review, access revocation, patient switching, and repeated clicks while a mutation is pending.
- [ ] Verify large-text layout, keyboard focus after navigation, and useful accessible empty states.
- [ ] Run frontend tests/build, backend tests/test_action_inbox_access.py and tests/test_security_and_care.py, then the fresh browser scenario.
- [ ] Document each source/action meaning, date/time treatment, permissions, refresh behavior, and why unreported doses are not labelled missed.
- [ ] Commit as docs: document caregiver action workflow.

## Acceptance criteria

- [ ] Permitted work is reachable from one panel with source identity and one clear action.
- [ ] Counts and rows obey existing record privacy and grant expiry.
- [ ] Existing acknowledgement, confirmation and outcome rules still govern writes.
- [ ] Date-only, unknown-time, expired and completed records are handled explicitly.
- [ ] Switching patients or revoking access cannot retain the previous patient's actions.
- [ ] No new background notifications or implicit medication conclusions are introduced.

## Rollout

Ship a read-only aggregation over existing server data. Rollback removes the attention panel; detailed screens and care records remain usable. No database migration is needed.
