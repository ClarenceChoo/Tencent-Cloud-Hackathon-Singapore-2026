# Guide companion setup through the first confirmed update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guide an owner and patient from pairing through an actual first confirmed update, with accurate connection and reminder readiness.

**Architecture:** Add a browser setup journey whose state is derived from enrollment, current Home and explicit checks. Reuse approval, active-companion and speaker endpoints; store no patient content or completion assertion in browser storage.

**Tech Stack:** React 18, TypeScript, existing browser companion API, Vitest and pytest

**Spec:** [Parse workflow improvements](../specs/2026-10-02-parse-workflow-improvements-design.md), section F02. The feature scope below repeats the decisions needed to execute this plan.

**Priority:** P1 · first delivery wave. **Dependencies:** F01.

**GitHub issue:** [#9](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/9). The complete implementation plan is also embedded in the issue.

**Research basis:** [Pocket reference](https://guide.heypocket.com/step-1-pair-your-pocket/5Y1rhXpY43ws81igeswUKB/pair-your-pocket/5Y1rhXpY45yyMkFYP2MacQ); benefits for Parse users require validation.

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

- Paired but not selected or offline: readiness remains incomplete (Task 1).
- Wrong patient, expired code, revoked installation or stale tab: never advance from old evidence (Task 2).
- Microphone permission denial or late grant after leaving: release capture and preserve retry path (Task 2).
- Tutorial or simulated provider: cannot count as verified live voice or a saved record (Task 2).
- Recipient lacks note access: owner setup must not claim caregiver visibility (Task 3).

---

## Scope and interfaces

Browser-first journey; update native and hardware instructions to explain differences. Provisioning users/grants remains an administrator/owner prerequisite. No automatic approval, automatic recording, notification permissions, or QR credential exchange.

Create frontend/src/setupJourney.ts:
- SetupStep = 'approve' | 'connection' | 'reminders' | 'speaker' | 'microphone' | 'first_update' | 'done'.
- deriveSetupProgress({enrollment, home, speakerPlayed, microphoneChecked, firstCommittedRecordId, nowMs}): SetupProgress.
- SetupProgress = {step: SetupStep; completed: SetupStep[]; voiceMode: 'live'|'simulated'|'unavailable'; reminderAvailability: string; liveVoiceVerified: boolean}. Derive matching device/patient from current responses. Inputs include lastTurnSimulated: boolean|null and lastTurnCompleted: boolean; liveVoiceVerified requires a completed non-simulated voice turn from this identity, not a speaker sample or tutorial.

Create CompanionOnboarding with props {progress; onSpeakerCheck; onMicrophoneCheck; onStartFirstUpdate; onDismiss}. Completion evidence is session-local and conservative after reload; pairing and current configuration are re-read.

### Task 1: Model truthful readiness

Files: create frontend/src/setupJourney.ts and frontend/src/__tests__/setup-journey.test.ts; modify frontend/src/DeviceSetup.tsx.

- [ ] Write cases for awaiting approval, paired/unselected, selected with voice unavailable, simulated provider, and completed saved update. Assert pairing alone is not done and selected browser reminders say page-open only.
- [ ] Pin the tutorial rule: expect(progress.liveVoiceVerified).toBe(false) when only a tutorial or simulated response was used; no server voice verification claim is persisted.
- [ ] Run npm --prefix frontend test -- src/__tests__/setup-journey.test.ts; confirm the missing implementation fails.
- [ ] Implement the selector and integrate consistent status copy into DeviceSetup. Preserve distinct owner and companion sessions.
- [ ] Re-run the test and pairing tests; commit as feat: model companion setup readiness.

### Task 2: Build guided speaker, microphone and first-update flow

Files: create frontend/src/CompanionOnboarding.tsx and frontend/src/__tests__/companion-onboarding.test.tsx; modify Companion.tsx, companion.css and companionApi.ts only where necessary.

- [ ] Test explicit speaker playback, denied microphone, blur during permission request, dismiss/resume, changed patient and stale completion callbacks. Assert no microphone call before a user gesture and no upload during the cancelled microphone exercise.
- [ ] Run the focused test and confirm the absent journey is the cause of failure.
- [ ] Add a clearly labelled static walkthrough with authored example text; do not send it to care APIs or count it as successful live processing.
- [ ] Implement actual first update using the normal recorder, F01 receipt, proposal review and confirmation. The user chooses whether to save; do not create a special auto-confirm path. Existing records are never used as proof that this device passed its first-use test.
- [ ] Refresh enrollment/home on resume, code expiry and access errors. Clear ephemeral progress on device/patient identity change.
- [ ] Run onboarding/companion/pairing tests and frontend build; commit as feat: guide browser companion first use.

### Task 3: Validate owner-to-caregiver handoff and write setup guide

Files: extend tools/browser_web_companion.cjs; modify README.md, docs/careloop/Web-Companion.md, docs/careloop/Phone-Companion-Setup.md, docs/careloop/Hardware-Pairing-Runbook.md and docs/careloop/VERIFICATION.md; create docs/careloop/First-Use-Guide.md.

- [ ] Add an owner-pairing and recipient-session scenario using fictional accounts. A permitted caregiver sees the explicitly shared first update; an unapproved caregiver cannot. The owner screen labels verification as an instruction until independently completed.
- [ ] Test unavailable providers, expired enrollment and changing reminder destination midway. Existing reminder routing generation must be respected.
- [ ] Run backend tests/test_pairing.py, tests/test_web_companion.py and tests/test_reminder_routing.py, frontend tests/build and the fresh browser fixture.
- [ ] Document prerequisites, the role handoff, each device's controls, troubleshooting, tutorial versus live checks, privacy choices, and first-record cleanup by an authorized user when using a fictional demo.
- [ ] Commit as docs: add verified first-use care journey.

## Acceptance criteria

- [ ] Pairing, network connection, reminder selection and speech checks are separate.
- [ ] The journey supports denial, interruption, expiry, reload and revocation.
- [ ] A tutorial cannot create care data or claim live-provider success.
- [ ] An actual first record requires ordinary review and explicit confirmation.
- [ ] Caregiver visibility is tested through that caregiver's authorized session.
- [ ] Browser closed-page limits and platform-specific controls are clearly documented.

## Rollout

Expose the guided path to newly paired browsers, with a dismiss/reopen control for existing installations. Rollback returns to current inline setup instructions; pairing, records and reminder routes remain authoritative server state.
