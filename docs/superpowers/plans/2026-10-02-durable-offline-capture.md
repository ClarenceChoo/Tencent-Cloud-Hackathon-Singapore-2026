# Validate and pilot protected native offline note capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine whether native devices can safely retain unsent audio, then deliver an opt-in private-note pilot on validated platforms.

**Architecture:** Put a native protected audio vault behind a small queue adapter and keep it separate from accepted-turn recovery. A queued note retains its original identity and capture metadata; upload creates a fresh private-note proposal requiring explicit review.

**Tech Stack:** Expo 57, React Native, iOS/Android protected storage, FastAPI, SQLAlchemy, Alembic, Vitest and physical-device lifecycle tests

**Spec:** [Parse workflow improvements](../specs/2026-10-02-parse-workflow-improvements-design.md), section F08. The scope below repeats the decisions needed to execute this plan.

**Priority:** P3 · feasibility gate, then limited pilot. **Dependencies:** F01, F04, F06.

**GitHub issue:** [#15](https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026/issues/15). The complete implementation plan is also embedded in the issue.

**Research basis:** [Pocket reference](https://docs.heypocketai.com/docs/features/device/syncing); benefits for Parse users require validation.

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

- Process death between file write and journal commit: recover or remove orphans without duplicate uploads (Tasks 1 and 2).
- Response lost after server acceptance: query the original receipt before deciding whether the original bytes may be resent (Task 3).
- Logout, reinstall, account switch or known revocation: previous-identity audio remains inaccessible and cannot upload (Tasks 1 and 2).
- Clock change, expiry, storage full or locked device: preserve honest state and never silently evict an unsent note (Tasks 2 and 4).
- Old medication or reminder context in queued audio: cannot trigger a stale confirmation or shared care action (Task 3).

---

## Scope and gates

The feasibility study may start now. Pilot implementation follows F01's receipt semantics and F04's intent binding; F06 is only an integration dependency so the next Alembic revision follows 0007_summary_purposes.

Pilot: native app, explicit opt-in, private health notes only, at most 10 clips, 20 seconds and 2 MiB per clip, maximum 24-hour retention. No browser/pendant queue, automatic sharing, medication reports, reminder responses or closed-app delivery promise. Foreground reconnection offers Send queued notes; the user initiates sending and later confirms each proposal.

Gate G1 must demonstrate encrypted atomic storage, crash recovery, installation identity binding, key protection, cleanup and backup exclusion on each supported OS. Record OS/device/build and limitations in the ADR. SecureStore is suitable for small secrets; do not store audio there or assume a plaintext file is protected sufficiently. A platform that fails G1 remains disabled. Completing only the study does not close this feature as implemented.

Native interface in mobile/src/offlineQueue.ts:
- enqueueOfflineNote(input: {fileUri: string; durationMs: number; capturedAt: string; monotonicMs: number; installationId: string}): Promise<QueuedNote>
- listQueuedNotes(installationId: string): Promise<QueuedNote[]>
- removeQueuedNote(id: string, reason: 'sent'|'discarded'|'expired'|'identity_reset'): Promise<void>
- QueuedNote = {id, idempotencyKey, installationId, capturedAt, captureTimeTrust: 'device_unverified', durationMs, byteLength, state: 'queued'|'sending'|'receipt_unknown'|'received', expiresAt}. The protected adapter owns file locations/keys; UI metadata contains no transcript.
- ProtectedAudioVault in mobile/src/audioVault.ts exposes writeAtomic, readForUpload, remove, purgeIdentity and reconcile. It encrypts both audio and sensitive journal metadata with OS-protected, non-backup keys. Select and pin the concrete implementation only after G1; this is the one deliberately gated platform choice.

New server metadata: optional X-Capture-Mode: offline_note, X-Captured-At: ISO timestamp and X-Capture-Time-Trust: device_unverified, restricted to the phone route. Reject unknown combinations, any context_id, or a purpose other than health_note. These fields are nullable for existing turns and are bound to the original idempotency key along with bytes/context/intent. Server receipt time remains authoritative; device capture time never supplies an unconfirmed clinical occurrence time.

### Task 1: Prove the protected-storage boundary

Files: create docs/adr/2026-10-02-native-offline-capture.md and a disposable fixture harness under mobile/test/manual/offline-vault/; inspect mobile/src/storage.ts, operations.ts and turnRecovery.ts.

- [ ] Compare a maintained compatible encrypted-storage adapter with a minimal native Expo module using current official platform documentation. Record encryption/key access, atomicity, backup, lock-state, uninstall/reinstall and testability behavior; do not select based on marketing alone.
- [ ] Build a fictional-audio spike outside the production feature path. Demonstrate interruption at file/journal boundaries, locked/unlocked reboot, low storage, logout/reinstall and backup/restore on physical iOS and Android devices.
- [ ] Record the pass/fail matrix and residual limitations. Select the adapter/package version and exact native file layout in the ADR only when G1 passes. No app-wide dependency upgrade is bundled into the pilot.
- [ ] Commit the ADR and reproducible fixture harness as docs: validate native protected audio storage. Keep pilot disabled on any unproven platform.

### Task 2: Implement the bounded native queue

Files: create mobile/src/audioVault.ts, mobile/src/offlineQueue.ts, mobile/test/offlineQueue.test.ts and mobile/test/audioVault.test.ts; extend mobile/src/storage.ts and operations.ts. Add only the native module/package files selected in Task 1 and update the lockfile.

- [ ] Write tests for 10-clip capacity, 20,000 ms duration, 2,097,152-byte size, 24-hour expiry, identity mismatch, repeated deletion, interrupted journal writes and orphan reconciliation. Assert an 11th clip is rejected without evicting the existing 10.
- [ ] Run npm --prefix mobile run test:unit; confirm absent queue behavior fails.
- [ ] Implement the protected adapter and serial queue journal, keeping the pending accepted-turn journal separate. Generate one idempotency key before durable enqueue; never regenerate it during retry.
- [ ] Check expiry and identity before any audio read or upload. Within a boot, use monotonic elapsed time in addition to wall time; after reboot or backward clock movement, if retention cannot be established safely, expire the note rather than extend retention.
- [ ] Purge on explicit logout/reset and known revocation; reconcile before listing on launch. An OS-suspended process cannot promise immediate physical deletion at the expiry instant: document cleanup at the next execution opportunity and block reads/uploads first.
- [ ] Run mobile unit/adapters/typecheck suites and the selected vault's physical-device cases. Commit as feat: queue protected private-note audio.

### Task 3: Bind offline metadata and recover accepted uploads

Files: modify backend/app/models.py, backend/app/phone.py, backend/app/turns.py, backend/app/worker.py and backend/app/schemas.py; create backend/migrations/versions/0008_offline_capture_metadata.py and backend/tests/test_offline_capture.py; extend tests/test_migrations.py; modify mobile/src/api.ts, mobile/src/contracts.ts and mobile/src/turnRecovery.ts; create mobile/test/offlineUpload.test.ts.

- [ ] Test optional-field legacy compatibility, context/purpose rejection, invalid timestamp, same key with altered capture metadata returning 409, and insertion-race binding. Assert a queued medication/reminder instruction cannot commit a medication report or change a reminder.
- [ ] Add nullable capture_mode/captured_at/capture_time_trust columns after 0007_summary_purposes. Store original metadata without treating device time as clinical evidence.
- [ ] Enforce a private health-note proposal with no recipients for this mode. If interpretation requests a different kind or sharing, return a clarification/unsupported result; never silently execute the other action. Review still shows exact note wording and unknown occurrence time.
- [ ] On reconnection, send with the original key and bytes. For a lost response set receipt_unknown; first use existing receipt recovery. The existing recovery helper deliberately treats 404 as unknown and must remain read-only. Add a separate user-initiated Resend original action in the offline uploader after an authenticated not-found response; it reuses the same key/bytes/metadata, so an in-flight acceptance still converges through server idempotency. Timeouts, 5xx and identity errors never authorize a new key. Confirmation remains explicit. Once acceptance is established, remove local raw audio and use normal server turn recovery.
- [ ] Run cd backend && uv run pytest tests/test_offline_capture.py tests/test_phone_recovery.py tests/test_migrations.py; run npm --prefix mobile test and npm --prefix mobile run typecheck. Validate SQLite/PostgreSQL migrations. Commit as feat: recover offline note uploads without duplication.

### Task 4: Add queue controls and close the pilot

Files: create mobile/src/OfflineNotes.tsx and mobile/test/native/offlineNotes.test.tsx; modify mobile/src/App.tsx and mobile/src/useVoice.ts; create docs/careloop/Offline-Capture.md; update backend/API.md, docs/careloop/VERIFICATION.md and the ADR.

- [ ] Test opt-in explanation, capacity/error state, explicit send/discard, unknown receipt and expired note. Assert queued text never says saved to care space or delivered to a caregiver.
- [ ] Render timestamps as device-reported, show expiry and storage/lock errors, and require a fresh foreground session before sending. Preserve normal online recording without opt-in.
- [ ] Run airplane-mode → record → process kill → restart → reconnect → lost response → recover → review → confirm on every enabled platform. Assert one server turn and one final private record; record real-device evidence separately from mocked tests.
- [ ] Test reset/revocation during send and stale installation responses; ensure no subsequent upload or display under the new identity.
- [ ] Document supported OS versions, foreground-only sending, bounds, expiry behavior, encryption model, server retention after upload, permission effects and manual discard. Commit as docs: document native offline note pilot.

## Acceptance criteria

- [ ] G1 passes with reproducible physical-device evidence for each enabled OS.
- [ ] Bounded unsent audio survives the tested lifecycle without plaintext backups or identity crossover.
- [ ] Original turn identity prevents duplicate records after lost responses or retries.
- [ ] Queued, receipt-unknown, received, review and committed states remain distinct.
- [ ] Only a reviewed private health note may be created; no stale context or automatic confirmation.
- [ ] Unsupported platforms remain disabled, and limits/cleanup timing are documented.
- [ ] All four tasks are complete before treating the feature as shipped; a failed feasibility gate remains a recorded blocker.

## Rollout

Start with a small opt-in native pilot after G1, migrations and physical-device acceptance. Keep the default online flow. A rollout disable stops new enqueue and upload, but retains protected discard/expiry cleanup controls for queued files. Rollback must not strand readable plaintext or erase pending notes without the documented retention/discard behavior.
