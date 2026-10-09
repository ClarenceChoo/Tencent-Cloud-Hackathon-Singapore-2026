# Add reviewed care-space vocabulary and provider capability handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve recognition of reviewed medicine and person names without silently rewriting transcripts or resolving ambiguous care facts.

**Architecture:** Store a versioned patient vocabulary controlled by manage:profile access and audited on update. Separate safe interpreter hints from ASR-specific capabilities; unsupported or unverified ASR adapters receive no vocabulary extension.

**Tech Stack:** FastAPI, Pydantic, SQLAlchemy, Alembic, React, existing provider adapters, pytest and Vitest

**Spec:** [Parse workflow improvements](../specs/2026-10-02-parse-workflow-improvements-design.md), section F05. The scope below repeats the decisions needed to execute this plan.

**Priority:** P2 · second delivery wave. **Dependencies:** F04.

**GitHub issue:** [#12](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/12). The complete implementation plan is also embedded in the issue.

**Research basis:** [Pocket reference](https://docs.heypocketai.com/docs/features/device/dictionary); benefits for Parse users require validation.

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

- Similar-sounding medicines, quantities or negation: never apply blind text replacement (Task 2).
- Concurrent owner edits: reject stale expected_version with 409 (Task 1).
- Expired/revoked caregiver grant or cross-patient request: deny vocabulary and suggestions (Task 1).
- Unsupported provider or invalid hint: normal ASR continues with explicit applied=false (Task 2).
- Provider restart or changed active plan: use the reviewed current vocabulary snapshot without stale unapproved suggestions (Tasks 2 and 3).

---

## Scope and interfaces

Owner/profile-manager settings, reviewed terms and aliases, and transparent provider capability. Initial bounds: at most 100 canonical terms, 80 characters per term, 5 aliases per term, 80 characters per alias. Trim and Unicode-normalize for duplicate detection; preserve display spelling. Reject ambiguous duplicate aliases mapping to different canonical terms.

Create backend/app/vocabulary_service.py:
- read_vocabulary(db: Session, patient_id: str) -> VocabularyView.
- update_vocabulary(db: Session, patient_id: str, actor_id: str, expected_version: int, terms: list[VocabularyTerm]) -> VocabularyView.
- VocabularyView = {version, terms, reviewed_by_user_id, reviewed_at}; VocabularyTerm = {canonical, aliases, category: 'medicine'|'person'|'other'}.
- GET/PUT /v1/app/patients/{patient_id}/vocabulary require manage:profile; PUT requires CSRF. Initial empty version is 0. Suggested terms are separate and never marked reviewed automatically.

### Task 1: Add versioned vocabulary management

Files: create backend/app/vocabulary_service.py and backend/tests/test_vocabulary.py; modify backend/app/models.py, backend/app/schemas.py and backend/app/main.py; create backend/migrations/versions/0006_care_vocabulary.py after 0005_capture_intent; extend backend/tests/test_migrations.py.

- [ ] Write cases for bounds, normalized collisions, cross-patient access, expired grants, missing CSRF and stale versions. Pin assertions: stale PUT.status_code == 409; unauthorized GET.status_code == 403; suggestion generation does not increment reviewed version.
- [ ] Run cd backend && uv run pytest tests/test_vocabulary.py tests/test_migrations.py; confirm the absent route/model fails.
- [ ] Persist current vocabulary and immutable update audit entries with actor/time/version. Add nullable VoiceTurn.vocabulary_version in the same 0006 migration, referencing the reviewed snapshot used for that turn. Lock the patient for updates and compare expected_version atomically.
- [ ] Derive suggestions from the active checked medication plan and permitted recipient names. Do not copy private notes into vocabulary or auto-approve suggestions.
- [ ] Run SQLite/PostgreSQL migration and service tests; commit as feat: manage reviewed patient vocabulary.

### Task 2: Integrate advisory hints and capability reporting

Files: modify backend/app/providers.py, backend/app/worker.py and backend/app/device_setup.py; create backend/tests/test_provider_vocabulary.py; extend tests/test_providers.py.

- [ ] Define SpeechVocabulary = {version: int; terms: list[str]}; add transcribe_audio(wav: bytes, *, vocabulary: SpeechVocabulary | None = None) and capabilities() reporting vocabulary support. Update all fixture/unconfigured/live adapters and mocks together.
- [ ] Write intercepted-request tests: unsupported adapter receives no extra provider parameter; reviewed canonical hints may be included only by a verified adapter; aliases never trigger a post-transcription replacement. Assert unchanged numeric and negated transcript output in representative fixtures.
- [ ] Before enabling any Tencent hint, verify the current official API field, engine availability, limits and account support. Record the evidence in PROVIDERS.md. If unavailable, leave ASR vocabulary disabled and ship reviewed interpreter hints with capability status; do not invent a request field.
- [ ] Add the current reviewed vocabulary version to interpretation context. Persist that version in VoiceTurn.vocabulary_version once the processing snapshot is selected; never log terms/transcripts. Revalidate current care facts at confirmation as today.
- [ ] Run provider/vocabulary/phone-audio suites; validate provider restart and plan-update cases. Commit as feat: apply reviewed vocabulary through supported providers.

### Task 3: Build settings and acceptance evidence

Files: create frontend/src/CareVocabulary.tsx and frontend/src/__tests__/care-vocabulary.test.tsx; modify frontend/src/App.tsx, frontend/src/api.ts and frontend/src/styles.css; create docs/careloop/Care-Vocabulary.md; update backend/API.md, docs/careloop/PROVIDERS.md and docs/careloop/VERIFICATION.md.

- [ ] Add tests for reviewing suggestions, explicit save, conflicting edits, bounds and no profile permission. Assert unsupported ASR is described as unavailable rather than improved recognition.
- [ ] Implement canonical/alias editing, review provenance and version-conflict refresh. A conflicting update preserves the user's unsaved editor draft in memory for comparison, never in browser storage.
- [ ] Run frontend tests/build and backend vocabulary/provider/migration suites.
- [ ] Prepare a fictional evaluation set with near-sounding names, numbers, negation and the language combinations actually supported by the chosen provider. Compare exact material-term errors and harmful substitutions before/after. Label live calls separately from intercepted tests.
- [ ] Document ownership, limits, conflict recovery, provider fallback and evaluation results; commit as docs: document reviewed vocabulary and provider support.

## Acceptance criteria

- [ ] Every applied vocabulary is explicitly reviewed and patient-scoped.
- [ ] Concurrent writes, invalid aliases and unauthorized reads are handled deterministically.
- [ ] No transcript is silently rewritten, and ambiguous material facts still require clarification.
- [ ] Provider support is truthful and backed by documented API/account evidence.
- [ ] User and API guides explain limits and fallback; validation distinguishes fixture from live recognition.

## Rollout

Deploy schema and management API, then enable the settings UI. Keep ASR hints off until provider acceptance passes. Disable hint application independently if recognition regresses; keep review history. Use additive columns/tables during rollback and do not destroy the audit.
