# Add purpose-specific care summaries and reviewed print output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce doctor-visit, family-handoff and weekly-review summaries from confirmed evidence, with clearly separate authored questions and reviewed print output.

**Architecture:** Keep deterministic source-linked summary generation and add versioned presentation templates plus persisted purpose. Retain the existing review/share/invalidation pipeline and explicitly distinguish authored questions from source-backed facts.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, React, browser print, pytest and Vitest

**Spec:** [Parse workflow improvements](../specs/2026-10-02-parse-workflow-improvements-design.md), section F06. The scope below repeats the decisions needed to execute this plan.

**Priority:** P2 · second delivery wave. **Dependencies:** F05.

**GitHub issue:** [#13](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/13). The complete implementation plan is also embedded in the issue.

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

- Corrected/deleted or newly private source after generation: invalidate summary/share/print preparation (Task 2).
- Unknown event date and current care context outside the selected period: label scope accurately (Task 1).
- Authored question mentions an unrecorded event: it remains a question, never a sourced fact (Tasks 1 and 2).
- Legacy summary and clients omit purpose/template fields: default doctor_visit without losing data (Task 1).
- Permission change during print preparation: revalidate before rendering; downloaded copies cannot be revoked (Task 3).

---

## Scope and interfaces

SummaryPurpose = 'doctor_visit' | 'family_handoff' | 'weekly_review'; default doctor_visit. Template version begins at 1. Continue respecting existing summary-management permission; no broadened caregiver access.

Add purpose and template_version to VisitSummary. Extend SummaryCreate with optional purpose and questions (at most 10, each 500 characters). Persist questions with author/time as separate JSON metadata. SummaryUpdate accepts reviewed questions and changes their authorship metadata only when text changes. Existing sections/source_refs remain the basis for fact provenance.

Create backend/app/summary_templates.py:
- present_summary(purpose: str, evidence_sections: list[dict], questions: list[AuthoredQuestion]) -> list[dict].
- AuthoredQuestion = {text: str; author_id: str; author_display_name: str; authored_at: datetime}; API requests supply only text, with identity/time supplied by the authenticated server.
- This function rearranges/titles existing evidence; it does not invent, diagnose, change source IDs or discard selected evidence silently.
- Serialize question sections with an explicit kind='authored_questions', no source_id, and visible author attribution. Extend validators to distinguish that known section type from ordinary evidence sections.

F05 is an integration dependency for ordered Alembic revisions, not a requirement to enable vocabulary.

### Task 1: Persist purpose and implement templates

Files: modify backend/app/models.py, backend/app/schemas.py and backend/app/services.py; create backend/app/summary_templates.py, backend/migrations/versions/0007_summary_purposes.py and backend/tests/test_summary_purposes.py; extend backend/tests/test_migrations.py.

- [ ] Add tests for all three purposes, default legacy requests, question limits, unknown occurrence time, date-range filtering and current-context sections. Assert the set of evidence source IDs/versions is preserved across presentations; authored questions carry no invented source.
- [ ] Run cd backend && uv run pytest tests/test_summary_purposes.py tests/test_migrations.py; confirm missing fields/behavior.
- [ ] Add additive schema after 0006_care_vocabulary. Existing summaries receive doctor_visit/version 1 and empty questions. Implement layouts: doctor visit prioritizes concerns/readings; family handoff prioritizes unresolved work; weekly review groups period reports and separately labels current context.
- [ ] Keep complete source references and original wording available. No LLM or new clinical recommendation generation is introduced.
- [ ] Run SQLite/PostgreSQL upgrade and summary tests; commit as feat: add versioned care summary purposes.

### Task 2: Preserve review and access semantics

Files: modify backend/app/main.py summary routes, backend/app/services.py source validation, frontend/src/api.ts and frontend/src/App.tsx; create frontend/src/__tests__/summary-purposes.test.tsx; extend backend/tests/test_security_and_care.py and frontend/src/__tests__/public-summary-access.test.tsx; create backend/tests/test_summary_access.py.

- [ ] Test edits invalidate prior links, changed questions require review, source correction/deletion/sharing changes invalidate the summary, and public serialization labels questions without leaking internal actor IDs or email.
- [ ] Run focused suites; existing access cases remain regression guards while new purpose/question cases fail until implemented.
- [ ] Add purpose and question controls, source-linked preview and existing omission controls. Require explicit review after changing purpose, content, questions or omissions. Purpose change regenerates a draft; it never silently overwrites a shared reviewed version.
- [ ] On expiry/revocation/403/410, clear visible share content according to existing behavior. Preserve distinctions between authored questions and reported care.
- [ ] Run summary/access/frontend confirmation tests; commit as feat: review purpose-specific summary content.

### Task 3: Add reviewed print handoff and documentation

Files: create frontend/src/SummaryPrint.tsx and frontend/src/__tests__/summary-print.test.tsx; modify frontend/src/styles.css, frontend/src/useSharedSummary.ts and the summary UI in frontend/src/App.tsx; create docs/careloop/Summary-Purposes.md; update backend/API.md and docs/careloop/VERIFICATION.md.

- [ ] Test print preparation fetches the current authorized reviewed summary, blocks stale/unreviewed results, and contains dates, source references, purpose, generation time and authored-question labels.
- [ ] Implement a print stylesheet and explicit Print / Save as PDF action using the browser print dialog after revalidation. Explain that physical/downloaded copies cannot be revoked. Do not cache summary HTML or persist it in browser storage.
- [ ] Verify multi-page layout, long names/questions, 200% text, no clipped source rows, and expired share links. Public preview prints only fictional samples if enabled.
- [ ] Run frontend tests/build and backend summary/security/migration suites.
- [ ] Document template selection, date semantics, questions, regeneration, invalidation, link expiry and export permanence. Commit as docs: document reviewed care summary handoff.

## Acceptance criteria

- [ ] Three purposes preserve evidence identity and distinguish selected-period facts from current context.
- [ ] Questions are authored and labelled; no question becomes a reported fact.
- [ ] All sharing still requires current reviewed content and permitted access.
- [ ] Source changes invalidate affected outputs; print requires fresh validation.
- [ ] Legacy summaries/clients survive migration and default handling.
- [ ] Documentation covers purpose, review, export and source-change behavior.

## Rollout

Deploy additive fields/API and then the selector/print UI. Existing default requests remain doctor_visit. Rollback can hide the new controls while retaining purpose/question metadata and existing read access; do not strip questions into unlabelled factual sections.
