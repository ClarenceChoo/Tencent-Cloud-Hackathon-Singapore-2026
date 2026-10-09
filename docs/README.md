# Parse documentation

Start with the [project overview](../README.md), then choose the guide for your task. Older files use the name **CareLoop**; they describe the same project and its existing API/configuration names.

## Understand the project

| I want to… | Read |
| --- | --- |
| Understand the problem, product and demo | [Project overview](../README.md) |
| See the system architecture and speech-to-record workflow | [Architecture and AI workflow](architecture/README.md) |
| Follow the patient, owner and caregiver journeys | [Users and connected workflow](careloop/User-Workflow.md) |

## Use the product

| Guide | Covers |
| --- | --- |
| [First use](careloop/First-Use-Guide.md) | Pairing, reminder selection, audio checks and the first confirmed update. |
| [Browser companion](careloop/Web-Companion.md) | Browser recording, proposal review, confirmation and caregiver visibility. |
| [Capture and correction](careloop/Capture-and-Correction.md) | Optional capture purposes and reviewed changes before saving. |
| [Recording receipts](careloop/Recording-Receipts.md) | Recording, upload, processing and recovery states. |
| [Dashboard navigation and activity log](careloop/Activity-Log.md) | Today, Timeline, Medications, Care and Log. |
| [Caregiver action inbox](careloop/Caregiver-Action-Inbox.md) | Pending proposals, requests, follow-ups and care tasks. |
| [Reviewed care names](careloop/Care-Vocabulary.md) | Patient-specific names used as advisory interpretation context. |
| [Care summaries](careloop/Summary-Purposes.md) | Doctor visits, family handoffs, weekly reviews and printing. |
| [Ask Parse](careloop/Ask-Parse.md) | Three bounded care-record questions with permission checks and source links. |

## Run or integrate the software

| Guide | Covers |
| --- | --- |
| [Local demo](careloop/Local-Demo.md) | Local dashboard and scripted browser demonstrations. |
| [Backend setup](../backend/README.md) | Dependencies, database migrations, development and tests. |
| [Implemented API](../backend/API.md) | Authentication, device/companion transport and care-record contracts. |
| [Speech and interpretation providers](careloop/PROVIDERS.md) | Tencent ASR/TTS, the configured language model and provider modes. |
| [Deployment](../deploy/README.md) | Backend and dashboard deployment configuration. |
| [Vercel preview](../deploy/VERCEL.md) | Frontend hosting, backend routing and fictional UI-preview limits. |
| [Developer tools](../tools/README.md) | Fixtures, browser verification and reproducible demo tooling. |

## Work on the cardholder or native app

| Guide | Covers |
| --- | --- |
| [Hardware handover — 9 October 2026](careloop/Hardware-Handover-2026-10-09.md) | Latest recorded bench wiring, tested modules and unresolved amplifier output. |
| [Firmware setup](../firmware/README.md) | ESP32-S3 build, configuration and flashing. |
| [Hardware pairing runbook](careloop/Hardware-Pairing-Runbook.md) | Pairing, per-device setup and integration acceptance. |
| [Hardware/software interface](careloop/Hardware-Software-Integration.md) | Audio, commands and the hardware integration contract. |
| [Supplier checklist · 中文](careloop/Supplier-Handoff-Checklist-ZH.md) | Prototype assembly and supplier handoff requirements. |
| [Native app source](../mobile/README.md) | Mobile project entry point. |
| [Phone development setup](careloop/Phone-Companion-Setup.md) | Backend connection, foreground voice and reminders. |
| [Native builds and installation](careloop/Phone-Companion-Native-Build.md) | Android preview builds, installation and recorded checkpoints. |

## Check what has been demonstrated

Read evidence with its date and environment. Scripted fixtures establish software behavior; live providers, physical devices and intended-user trials have separate acceptance requirements.

| Record | Scope |
| --- | --- |
| [Software verification ledger](careloop/VERIFICATION.md) | Recorded backend, frontend, browser and firmware checks, plus remaining acceptance work. |
| [Workflow evidence — 2 October 2026](careloop/evidence/2026-10-02-workflows/README.md) | Selected browser reports, screenshots and a fictional printed summary. |
| [Native companion verification](careloop/Phone-Companion-Verification.md) | Native app tests, emulator observations and physical-phone acceptance gaps. |
| [Hardware handover — 9 October 2026](careloop/Hardware-Handover-2026-10-09.md) | Physical bench results: ESP32 flashing, microphone and button verified; amplifier audio remains unresolved. |
| [Offline capture decision record](adr/2026-10-02-native-offline-capture.md) | Feasibility study and unpassed physical-device gate; offline capture remains disabled. |

The **9 October hardware handover is the latest recorded hardware status**. Earlier PRD status statements and historical verification entries predate those bench tests. The integrated cardholder voice journey still needs its own end-to-end evidence.

## Read the design history

These documents preserve requirements, design decisions and implementation plans. Their proposals and original status statements are dated context; use the guides and evidence above to assess current behavior.

| Document | Purpose |
| --- | --- |
| [Original product requirements](careloop/CareLoop-PRD.md) | Original cardholder MVP and care-record requirements. |
| [Phone companion requirements](careloop/Phone-Companion-PRD.md) | Native phone scope and acceptance criteria. |
| [Original implementation contract](careloop/IMPLEMENTATION-CONTRACT.md) | Early interface agreement and ownership, with the later phone amendment. |
| [Phone implementation handoff](careloop/Phone-Companion-Handoff.md) | Historical build-task brief. |
| [Workflow design](superpowers/specs/2026-10-02-parse-workflow-improvements-design.md) | Design for capture, review, summaries and care-record questions. |
| [Implementation plans](superpowers/plans/) | Dated work plans; completion must be checked against implementation and evidence. |
| [Pocket workflow research](research/pocket-workflow-research-2026-10-02.md) | Research that informed the workflow improvements. |
