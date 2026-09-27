# Build handoff: Parse phone companion

27 September 2026 · This handoff starts implementation of [Phone-Companion-PRD.md](Phone-Companion-PRD.md).

## Active goal for the new task

Build an installable Parse phone companion for iPhone and Android that replaces the physical pendant when it is unavailable, implements every P0 requirement in Phone-Companion-PRD.md, and uses the existing Parse backend and caregiver dashboard. Deliver real microphone capture and spoken responses, secure pairing, explicit confirmation and sharing, the complete medication/health/preventive/support/check-in journeys, native reminder alerts and phone/pendant routing, recovery, compatible data migrations, tests, install instructions, evidence and a reviewable pull request. Keep this goal active until its full acceptance criteria are met, or report a verified external blocker without substituting a mock or reduced scope.

The user explicitly requested a new task with a goal to build this. At the start of that task, use `get_goal`; if there is no unfinished goal, call `create_goal` with the objective above and no token budget. Then begin implementation, not another PRD-writing round. Follow the host's goal completion and blocked-audit rules. A later user answer about target phones may refine the platform requirement; otherwise the PRD assumes both.

## Source and starting point

- Repository: https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026
- PRD branch: `codex/phone-companion-prd`.
- This branch includes hardware-pairing baseline `8cda8c5`, which is not in `main` at handoff time. Inspect GitHub state before choosing the implementation PR base.
- Local source checkout, for read-only context or making an isolated checkout: `/Users/ansonng/.codex/.chatgpt-projects/g-p-6ab20033ce6c81919ade9b07ecb6b94f/tmp/tencent-cloud-hackathon-singapore-2026`.
- The saved Hackathon project is a project-reference mirror. Treat `sources/` as read-only and do not implement in synced reference files. Use an isolated checkout/worktree under your writable task workspace, based on the committed PRD branch; do not modify the parent's shared checkout while it may still be in use.
- Create a separate implementation branch. Do not merge the hardware-pairing or PRD pull requests just to get started, and do not reset existing databases.

Read the new PRD first, then `backend/API.md`, `backend/app/{main,worker,services,providers,models,security}.py`, `frontend/src/{App,DeviceSetup,api}.tsx` / `.ts` as applicable, and the current verification and integration docs. Old statements excluding phone voice are superseded by the new user request and PRD. Existing permissions, confirmation and medication safeguards remain authoritative.

## First implementation steps

1. Verify the exact baseline and current tests; inspect available native build tools without reading unrelated credentials. Record SDK and installation assumptions. Ask for missing real-phone/cloud details while continuing independent work.
2. Define phone enrollment, secure installation identity, device type, active companion and routing generation. Replace the scheduler's current first-device selection. Add real migrations for existing populated SQLite and PostgreSQL databases.
3. Scaffold `mobile/` using pinned React Native/Expo native development builds. Keep the existing ivory/terracotta dashboard. Build the older-adult talk/read-back/confirm flow with actual audio and a compatible bounded upload adapter.
4. Integrate all P0 care capabilities with the existing proposal/commit and provider services. Do not fork the clinical data or confirmation logic. Preserve source identity, patient binding, sharing and existing browser CSRF behavior.
5. Implement notification registration, generic OS alerts, foreground speech, mobile lifecycle/recovery and route-change reconciliation. The PRD explicitly covers the limits of cached alerts and legacy pendant playback. Do not pretend a remote cancellation stops an already-playing physical speaker.
6. Exercise the E01–E11 acceptance matrix, publish measured evidence and installation steps, then create/attach an implementation PR with its actual base/dependencies.

## Important implementation boundaries

- The phone connects directly to the existing backend over Wi-Fi/cellular. It is a companion endpoint, not a Bluetooth relay and not just a mobile dashboard.
- Real audio input and audible output are required. Existing fixture WAVs are for automated tests only. The simulator, fixture provider, a video or green mocked tests cannot prove real-device audio, live providers or background notifications.
- Native recorded M4A/AAC must not be mislabeled WAV. Keep the pendant's current WAV endpoint strict; use a verified native PCM path or the specified bounded phone normalization route.
- Authentication for a phone is scoped to its paired patient. A device token must not unlock owner administration or another person's records.
- A reminder, notification, upload receipt or playback receipt never means the medication was taken or a care fact was confirmed.
- Full background/lock-screen alert handling is P0. An always-open foreground demo is an intermediate milestone, not the completed fallback product. Document OS delivery restrictions honestly.
- The current single-process backend/socket registry and existing cloud-provider configuration remain deployment constraints. Do not introduce an unrelated platform rewrite.
- Build/install/signing configuration may require user-supplied accounts or hardware. Do not buy services or invent credentials. Complete all independent work, maintain an explicit evidence ledger and identify the exact remaining gate if external access is missing.
- Existing tests recorded in the repository are historical evidence. Run relevant checks against your actual implementation; do not copy their pass counts as current proof.

## Deliverables

`mobile/` application and native configuration; additive backend APIs/models/migrations; dashboard enrollment/target/status changes; protocol compatibility tests; real audio and lifecycle tests; notification/route-race tests; updated API and deployment docs; `Phone-Companion-Verification.md` mapping every P0 requirement and E01–E11 to actual evidence; `Phone-Companion-Setup.md`; an actual demo recording with simulation clearly labelled where used; and an attached implementation PR.

Continue until the requested product is built and verified. Do not silently redefine completion as a plan, UI prototype, fixture-only demonstration, one health-note flow, missing background behavior or a single platform that the user has not chosen.
