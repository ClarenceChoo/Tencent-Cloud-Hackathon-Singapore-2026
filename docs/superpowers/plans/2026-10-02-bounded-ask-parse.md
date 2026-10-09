# Add bounded source-linked Ask Parse queries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer three everyday care-record questions with current permissions, explicit dates and inspectable sources.

**Architecture:** Use deterministic, authorized database queries in a dashboard-only interface. Keep retrieval read-only and use the inbox's source-navigation conventions without requiring an LLM, embeddings or a new chat history.

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic, React, pytest and Vitest

**Spec:** [Parse workflow improvements](../specs/2026-10-02-parse-workflow-improvements-design.md), section F07. The scope below repeats the decisions needed to execute this plan.

**Priority:** P2 · second delivery wave. **Dependencies:** F03.

**GitHub issue:** [#14](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/14). The complete implementation plan is also embedded in the issue.

**Research basis:** [Pocket reference](https://docs.heypocketai.com/docs/features/ai/ask-pocket); benefits for Parse users require validation.

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

- Revoked grants and another recipient's support requests: exclude records, totals and source details (Tasks 1 and 2).
- More than 100 historical doses: query the requested date directly rather than the dashboard's capped dose list (Task 1).
- Unknown occurrence time and patient-local daylight-saving boundary: label reported versus occurred time explicitly (Task 1).
- Corrected, superseded or deleted source: revalidate source detail and discard stale results on refresh (Task 2).
- Patient switch or late network response: never render the previous care space's answer (Task 3).

---

## Scope and interfaces

Offer three presets, with no unrestricted natural-language box in the first release:
- latest_reading: latest confirmed, non-superseded blood-pressure record by recorded-at time; show occurred-at separately and explicitly when unknown.
- open_support: permitted support requests that are not resolved, with their existing status.
- medication_reports: doses scheduled on a selected patient-local date, their confirmed report history and explicit unknown/unreported state.

F03 supplies source-navigation conventions; its frontend selector is not an authorization service. Keep existing _patient_access authorization and mirror the dashboard's category and record-level visibility in a focused backend service. Test parity rather than broadly restructuring main.py.

POST /v1/app/patients/{patient_id}/queries accepts QueryRequest {kind, local_date?}; require local_date only for medication_reports, reject unsupported combinations with 422. Apply existing session/origin/CSRF checks even though this POST performs no care mutation. Missing category permission returns 403, not an empty answer.

Create backend/app/care_queries.py:
- run_care_query(db: Session, patient: Patient, viewer_user_id: str, scopes: list[str], query: QueryRequest) -> QueryResponse.
- QueryResponse = {kind, generated_at, timezone, date_basis, local_date, items, truncated}; no invented total.
- items contain source_type, source_id, source_version (nullable where the model has none), recorded_at, occurred_at, permitted domain values and existing provenance. Latest reading returns at most 1; others return at most 50, fetched with limit 51 to detect truncation.
- load_query_source(db: Session, patient: Patient, viewer_user_id: str, scopes: list[str], kind: Literal['measurement','support_request','dose'], source_id: str) -> QuerySource.
- GET /v1/app/patients/{patient_id}/query-sources/{kind}/{source_id} revalidates category, patient and row access. Use 404 for unavailable source IDs; never reveal a cross-patient or hidden record.
- Responses use Cache-Control: no-store. Query content is not persisted or sent to an external model.

### Task 1: Implement authorized deterministic query service

Files: create backend/app/care_queries.py and backend/tests/test_care_queries.py; modify backend/app/schemas.py and main.py.

- [ ] Write tests with owner and scoped caregivers, two patient timezones, a DST transition, more than 100 historical doses, same-time readings and an unreported dose. Assert forbidden categories return 403; hidden support IDs never occur; a historical local date returns the appropriate doses outside the dashboard's latest 100.
- [ ] Pin ordering: latest reading by created_at descending then ID; support by created_at descending then ID; doses by scheduled_at then ID. Filter medication dates with timezone-aware half-open UTC bounds computed from the two local midnights.
- [ ] Run cd backend && uv run pytest tests/test_care_queries.py; expect absent routes/service to fail.
- [ ] Implement query and schema validation. Filter visibility before limiting/counting. Include only confirmed evidence; an absent report is unreported and never interpreted as missed/taken.
- [ ] Run query and tests/test_security_and_care.py suites; commit as feat: query permitted care evidence.

### Task 2: Implement source validation and privacy regressions

Files: extend backend/app/care_queries.py, main.py and backend/tests/test_care_queries.py; create backend/tests/test_query_source_access.py.

- [ ] Add assertions for private/other-patient source 404, revoked category 403, corrected measurement exclusion, changed support status, and no-store on both result/detail responses.
- [ ] Implement source-detail loading with the same row policy as query selection. Return current evidence rather than trusting values or versions sent by the client.
- [ ] Keep the current dashboard authorization behavior unchanged. Compare each query's permitted IDs to dashboard IDs for overlapping fixture ranges; test historical doses separately.
- [ ] Run cd backend && uv run pytest tests/test_care_queries.py tests/test_query_source_access.py tests/test_security_and_care.py. All must pass; no care record, proposal or acknowledgement is created by a query.
- [ ] Commit as feat: validate Ask Parse evidence on opening.

### Task 3: Build presets, evidence cards and user documentation

Files: create frontend/src/AskParse.tsx and frontend/src/__tests__/ask-parse.test.tsx; modify frontend/src/App.tsx, api.ts and styles.css; create docs/careloop/Ask-Parse.md; update backend/API.md and docs/careloop/VERIFICATION.md.

- [ ] Test preset/date validation, 403 versus empty result, truncated responses, source loading, unknown timestamps and late responses after patient switch. Assert an answer for patient A never appears after selecting patient B.
- [ ] Add AskParse props {patientId: string; timezone: string}. Store only transient in-memory request/result state; reset it on patient/session change. Use request generation checks or AbortController to discard stale responses.
- [ ] Display the exact question and date basis, reported facts, timestamps and a View source action that fetches current source details. Show truncation explicitly and route to the existing detailed view where applicable. Do not show unsupported clinical advice or imply exhaustive results when truncated.
- [ ] Run npm --prefix frontend test -- src/__tests__/ask-parse.test.tsx and npm --prefix frontend run build, then the backend query/access suites.
- [ ] Verify keyboard navigation, readable empty states, 200% text and narrow screens; public preview uses fictional results only.
- [ ] Document the three supported questions, permissions, date semantics, unknown states, 50-result limit, source validation and deliberate absence of mutation. Commit as docs: document bounded Ask Parse retrieval.

## Acceptance criteria

- [ ] Three supported questions return deterministic, source-linked evidence.
- [ ] Historical medication dates are not limited by the dashboard's latest 100 doses.
- [ ] Private records and hidden counts cannot leak through results or source routes.
- [ ] Unknown, empty, forbidden and truncated results are visibly distinct.
- [ ] Queries create no care changes and invoke no external AI provider.
- [ ] Patient/session changes discard previous results; source opening revalidates access.

## Rollout

Ship the read-only routes before exposing the dashboard entry. No schema migration or index is required initially; measure fixture-scale query performance and add a justified index in a separate migration only if needed. Rollback hides the entry and disables the routes without changing records.
