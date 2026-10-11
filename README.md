# Parse

**Turn everyday voice updates into coordinated care.**

Tencent Cloud Hackathon Singapore 2026 · Healthcare Track — NTU LKC Medicine

**Challenge 2: AI Healthier Every Day — Intelligent Support for Long-Term Self-Care**

Parse helps older adults record concerns, report medication status and blood pressure, and ask their care circle for help between appointments. A person speaks, reviews what Parse understood, and confirms the update. Permitted caregivers can then follow through, and reviewed records can support the next doctor or pharmacist conversation.

The primary software path is a **browser companion + caregiver dashboard + shared backend**. A native phone app and an ESP32-S3 cardholder use the same care system. The cardholder is an alternative voice interface for people who prefer a physical talk button.

[Architecture and AI harness](docs/architecture/README.md) · [User journey](docs/careloop/User-Workflow.md) · [Run locally](docs/careloop/Local-Demo.md) · [All documentation](docs/README.md)

For the current shared dashboard and ESP32 recording flow, see [Hosted Parse and voice tools](sites/README.md), the [tool-calling guide](sites/parse-shared-voice/docs/voice-tool-calling.md), and the [laptop relay setup](tools/ESP32_VOICE_RELAY.md). The [11 October voice handover](docs/careloop/ESP32-Voice-Handover-2026-10-11.md) records the paused bench session, audible tones and unresolved speech distortion. Laptop playback remains the default.

## The care journey

Consider an older adult managing hypertension: a medicine is difficult to collect, a home blood-pressure reading needs recording, and a concern may otherwise be forgotten before the next appointment. Parse connects these small updates to a reviewable record and a named person's follow-through. This is the project's target scenario; intended-user and health-outcome validation remain to be completed.

| The person needs to… | Parse supports… |
| --- | --- |
| Understand an entered medication | Spoken explanations from reviewed instructions and source text |
| Keep track of a routine | Scheduled reminders and separately confirmed taken / skipped / not-yet / uncertain reports |
| Ask for practical help | A support request to a permitted caregiver, with human acknowledgement and an explicit outcome |
| Remember symptoms and readings | Confirmed health notes and externally measured blood pressure with time and source |
| Follow an existing preventive-care plan | Confirmed task updates and linked follow-ups |
| Prepare for a care conversation | Source-linked doctor-visit, family-handoff and weekly summaries with review before sharing |

## System architecture

The diagram shows the self-hosted components and supplied deployment configuration. The Tencent Cloud host is that deployment's target; live provider and public-backend operation need separate verification. The hosted Sites prototype and its laptop relay are described in the [hosted voice guide](sites/README.md).

```mermaid
flowchart TB
    Patient["Older adult<br/>Browser / native app / ESP32-S3"]
    Caregiver["Owner and permitted caregivers<br/>React dashboard"]

    subgraph Host["Tencent Cloud host"]
        Web["Caddy<br/>HTTPS and frontend / API routing"]
        App["FastAPI application<br/>AI harness, care services and scheduler"]
        DB[("PostgreSQL<br/>Proposals, records and delivery state")]
        Web <--> App
        App <--> DB
    end

    AI["External speech and interpretation<br/>Tencent ASR / configured LLM / Tencent TTS"]
    Patient <-->|"Record, review and confirm"| Web
    Caregiver <-->|"Permitted care actions"| Web
    App <-->|"Server-side provider calls"| AI

    classDef client fill:#edf5ff,stroke:#527cad,color:#16334d;
    classDef app fill:#eaf5f0,stroke:#4c8a72,color:#173d2e;
    classDef provider fill:#f4effb,stroke:#8c70ae,color:#3e2857;
    class Patient,Caregiver client;
    class Web,App,DB app;
    class AI provider;
    style Host fill:#f8fafc,stroke:#94a3b8,color:#16334d
```

FastAPI runs the API, voice processing and scheduler in one process. Local demos use SQLite; Compose configures PostgreSQL. The self-hosted ESP32 firmware implements direct Wi-Fi over HTTPS/WSS. The current bench uses the Bluetooth laptop relay; direct hotspot testing is paused after brownout resets. [Architecture details, trust boundaries and trade-offs →](docs/architecture/README.md)

## From speech to a care record

```mermaid
flowchart TB
    Speak["1. Record<br/>a short update"] --> Transcribe["2. Tencent ASR<br/>produces a transcript"]
    Transcribe --> Interpret["3. LLM selects intent<br/>and extracts care fields"]
    Interpret --> Route{"Backend routes<br/>the interpretation"}
    Route -->|"Care proposal"| Validate["4. Validate fields,<br/>references and permissions"]
    Route -->|"Missing facts / question / chat"| Reply["Clarify or reply<br/>No care-record commit"]
    Validate -->|"Valid"| Review["5. Read back<br/>Review and correct"]
    Validate -->|"Invalid"| Retry["Report failure<br/>No care-record commit"]
    Review -->|"Correction"| Interpret
    Review -->|"Explicit confirmation"| Save["6. Recheck and save<br/>Show to permitted caregivers"]

    classDef client fill:#edf5ff,stroke:#527cad,color:#16334d;
    classDef app fill:#eaf5f0,stroke:#4c8a72,color:#173d2e;
    classDef provider fill:#f4effb,stroke:#8c70ae,color:#3e2857;
    classDef pause fill:#f8fafc,stroke:#94a3b8,color:#334155;
    class Speak,Review client;
    class Route,Validate,Save app;
    class Transcribe,Interpret provider;
    class Reply,Retry pause;
```

The model returns **one** `{ intent, kind, payload, spoken_text }` object per utterance. The six care categories are **health note, medication report, measurement, preventive task, support request and follow-up**. The backend creates the care read-back, checks the current proposal again at confirmation, and commits the record transactionally. A recording receipt and reminder playback are tracked separately from a confirmed care fact. [Prompt, categories and worked example →](docs/architecture/README.md#how-the-ai-interprets-speech)

## Start here

| I want to… | Open |
| --- | --- |
| See the product quickly | [60-second browser walkthrough](docs/careloop/demo/parse-web-companion-demo.mp4) — fictional data, scripted speech |
| Use the shared voice dashboard and ESP32 relay | [Hosted Parse](sites/README.md), [voice tool calling](sites/parse-shared-voice/docs/voice-tool-calling.md), and [Bluetooth relay](tools/ESP32_VOICE_RELAY.md) |
| Run and test the browser workflow | [Local demo guide](docs/careloop/Local-Demo.md) — dependencies, fixture accounts and checks |
| Deploy the backend and use live speech | [Deployment](deploy/README.md) and [provider configuration](docs/careloop/PROVIDERS.md) |
| Upload firmware to the ESP32-S3 | [Setup and upload guide](firmware/README.md), then [hardware pairing](docs/careloop/Hardware-Pairing-Runbook.md) |
| Continue physical assembly and audio testing | [Hardware wiring handover](docs/careloop/Hardware-Handover-2026-10-09.md) and [11 October voice results](docs/careloop/ESP32-Voice-Handover-2026-10-11.md) |
| Understand setup for a patient and caregiver | [First-use guide](docs/careloop/First-Use-Guide.md) |

For a dashboard-only demo after installing the [dependencies](docs/careloop/Local-Demo.md#browser-and-dashboard-requirements):

```sh
python3 tools/run_demo.py
```

The launcher starts services at `http://127.0.0.1:5173` with fictional records and live speech unconfigured. The separate [browser fixture](docs/careloop/Local-Demo.md#try-the-browser-flow-locally) exercises recording and confirmation with explicitly scripted interpretations.

## Implementation and evidence

| Area | Recorded status |
| --- | --- |
| Software care workflow | 2 October: 231 backend tests on each of SQLite and PostgreSQL 15; 132 frontend tests; 28 Chrome workflow checks. Speech responses were mocked or scripted. |
| Native phone app | 2 October: 143 compatibility tests and TypeScript check; physical-device acceptance remains separate. |
| ESP32-S3 hardware | 11 October: handover-configured tones audible; Bluetooth return transfer and driver completion passed, but speech remained distorted, including with Bluetooth disabled. Laptop reference speech was clear. Testing and the local relay are paused. |
| ESP32 and relay software | 11 October: 47 host C cases and 16 Python tests passed without board access. Direct hotspot operation and clear onboard speech remain unverified. |
| Live AI and hosting | The hosted Sites prototype and tool-calling source are in `sites/`. Self-hosted Tencent deployment operation and live-provider accuracy need separate acceptance. |
| Submission evidence | Actual CodeBuddy / WorkBuddy development history and at least three chat screenshots still need to be assembled and verified. |

These results retain their dates and scope. [Software verification](docs/careloop/VERIFICATION.md), the [hardware handover](docs/careloop/Hardware-Handover-2026-10-09.md), and the [latest voice session](docs/careloop/ESP32-Voice-Handover-2026-10-11.md) contain the remaining acceptance work. Durable offline voice capture is disabled. Clinical effectiveness and intended-user usability have not been established.

The [product films](demos/parse-product-demo/README.md) provide a longer concept story and software tour. They were recorded on 23 September with the earlier visual design, fictional data and simulated pendant/speech interaction.

## Repository map

| Directory | Purpose |
| --- | --- |
| [`frontend/`](frontend/README.md) | React browser companion and caregiver dashboard |
| [`backend/`](backend/README.md) | FastAPI, care rules, provider adapters and persistence |
| [`mobile/`](mobile/README.md) | React Native / Expo companion |
| [`firmware/`](firmware/README.md) | ESP32-S3 cardholder firmware |
| [`deploy/`](deploy/README.md) | HTTPS and container deployment |
| [`tools/`](tools/README.md) | Local fixtures, browser checks and demo tooling |
| [`sites/`](sites/README.md) | Hosted shared voice dashboard, tool calling and phone/laptop bridge |
| [`docs/`](docs/README.md) | Architecture, product guides, submission preparation and evidence |
