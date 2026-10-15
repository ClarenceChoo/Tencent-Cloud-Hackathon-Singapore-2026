# Parse

<p align="center">
  <img src="docs/readme-assets/parse-cover.jpg" width="1200" alt="Parse: Everyday care, in view. The Parse logo beside a real filmed demonstration of the cardholder.">
</p>

**Turn everyday voice updates into coordinated care.**

Tencent Cloud Hackathon Singapore 2026 · Healthcare Track — NTU LKC Medicine

**Challenge 2: AI Healthier Every Day — Intelligent Support for Long-Term Self-Care**

Parse helps older adults record concerns, report medication status and blood pressure, and ask their care circle for help between appointments. A person speaks, reviews what Parse understood, and confirms the update. Permitted caregivers can then follow through, and reviewed records can support the next doctor or pharmacist conversation.

The primary software path is a **browser companion + caregiver dashboard + shared backend**. A native phone app and an ESP32-S3 cardholder use the same care system. The cardholder is an alternative voice interface for people who prefer a physical talk button.

[Product preview](#product-preview) · [Hardware gallery](#from-bench-to-cardholder) · [Architecture and AI harness](docs/architecture/README.md) · [User journey](docs/careloop/User-Workflow.md) · [Run locally](docs/careloop/Local-Demo.md) · [All documentation](docs/README.md)

## The care journey

Consider an older adult managing hypertension: a medicine is difficult to collect, a home blood-pressure reading needs recording, and a concern may otherwise be forgotten before the next appointment. Parse connects these small updates to a reviewable record and a named person's follow-through. This is the project's target scenario; intended-user and health-outcome validation remain to be completed.

<table>
  <tr>
    <td width="50%"><img src="docs/readme-assets/care-at-home.jpg" width="560" alt="Illustrated care scenario: an older woman beside a notebook in a Singapore home."></td>
    <td width="50%"><img src="docs/readme-assets/chosen-caregiver.jpg" width="560" alt="Illustrated care scenario: an older adult and chosen caregiver reviewing a notebook together."></td>
  </tr>
  <tr>
    <td><strong>Care between visits</strong><br>Keep the small updates that might otherwise be forgotten.</td>
    <td><strong>A care circle chosen by the person</strong><br>Share reviewed updates with people permitted to help.</td>
  </tr>
</table>

*Editorial illustrations of fictional care scenarios.*

| The person needs to… | Parse supports… |
| --- | --- |
| Understand an entered medication | Spoken explanations from reviewed instructions and source text |
| Keep track of a routine | Scheduled reminders and separately confirmed taken / skipped / not-yet / uncertain reports |
| Ask for practical help | A support request to a permitted caregiver, with human acknowledgement and an explicit outcome |
| Remember symptoms and readings | Confirmed health notes and externally measured blood pressure with time and source |
| Follow an existing preventive-care plan | Confirmed task updates and linked follow-ups |
| Prepare for a care conversation | Source-linked doctor-visit, family-handoff and weekly summaries with review before sharing |

## Product preview

The cream, teal and navy interface brings care updates, reviews and follow-through into one place. These captures show the hosted dashboard's version 16 interface with fictional preview records; the local React/FastAPI demo has its own setup and verification.

<p align="center">
  <img src="docs/readme-assets/care-dashboard.jpg" width="1000" alt="Parse dashboard with attention items, a reported medication status and a support request, using fictional preview records.">
</p>

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/readme-assets/review-proposal.png" width="520" alt="Review a proposed note, edit its wording, then choose the separate Confirm and save action. Fictional preview data."></td>
    <td width="50%" valign="top"><img src="docs/readme-assets/sharing-choice.png" width="520" alt="Choose who can see a care note, or leave everyone unselected to keep it private. Fictional preview data."></td>
  </tr>
  <tr>
    <td><strong>Review before saving</strong><br>Check what Parse understood and correct the proposed wording.</td>
    <td><strong>Choose who can see it</strong><br>Keep a note private or share it with a permitted caregiver.</td>
  </tr>
</table>

### Prepare for the next care conversation

Reviewed summaries link statements back to care records, so the person can check the sources before sharing a copy.

<p align="center">
  <img src="docs/readme-assets/summary-sources.png" width="1000" alt="Visit summary review with statements linked to their care-note and reading sources. Fictional preview records.">
</p>

[Image sources and capture details](docs/readme-assets/README.md)

## System architecture

The diagram shows the implemented components and the supplied deployment configuration. The Tencent Cloud host is the deployment target; live provider and public-backend operation need separate verification.

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

FastAPI runs the API, voice processing and scheduler in one process. Local demos use SQLite; Compose configures PostgreSQL. The ESP32 connects directly over Wi-Fi using HTTPS/WSS. [Architecture details, trust boundaries and trade-offs →](docs/architecture/README.md)

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
| Run and test the browser workflow | [Local demo guide](docs/careloop/Local-Demo.md) — dependencies, fixture accounts and checks |
| Deploy the backend and use live speech | [Deployment](deploy/README.md) and [provider configuration](docs/careloop/PROVIDERS.md) |
| Upload firmware to the ESP32-S3 | [Setup and upload guide](firmware/README.md), then [hardware pairing](docs/careloop/Hardware-Pairing-Runbook.md) |
| Continue physical assembly and audio testing | [9 October hardware handover](docs/careloop/Hardware-Handover-2026-10-09.md) |
| Understand setup for a patient and caregiver | [First-use guide](docs/careloop/First-Use-Guide.md) |

For a dashboard-only demo after installing the [dependencies](docs/careloop/Local-Demo.md#browser-and-dashboard-requirements):

```sh
python3 tools/run_demo.py
```

The launcher starts services at `http://127.0.0.1:5173` with fictional records and live speech unconfigured. The separate [browser fixture](docs/careloop/Local-Demo.md#try-the-browser-flow-locally) exercises recording and confirmation with explicitly scripted interpretations.

## From bench to cardholder

The physical direction is a familiar cardholder with a deliberate talk button. The photographs show the filmed object and bench electronics; the CAD frames show the enclosure design.

<table>
  <tr>
    <td width="50%"><img src="docs/readme-assets/real-cardholder.jpg" width="560" alt="Real Parse cardholder held during the filmed introduction."></td>
    <td width="50%"><img src="docs/readme-assets/bench-prototype.jpg" width="560" alt="Real ESP32-S3 bench prototype with audio peripherals and breadboard wiring."></td>
  </tr>
  <tr>
    <td><strong>The cardholder in hand</strong><br>A frame from the product introduction.</td>
    <td><strong>The bench build</strong><br>ESP32-S3, audio peripherals and prototype wiring.</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/readme-assets/enclosure-render.jpg" width="560" alt="CAD render of the Parse cardholder enclosure with side button and speaker openings."></td>
    <td width="50%"><img src="docs/readme-assets/enclosure-assembly.jpg" width="560" alt="Exploded CAD view of the cardholder enclosure and side-button assembly."></td>
  </tr>
  <tr>
    <td><strong>Enclosure design</strong><br>A frame from the cardholder rotation render.</td>
    <td><strong>Side-button assembly</strong><br>An exploded view of the enclosure.</td>
  </tr>
</table>

The enclosure views and bench build show separate stages. Complete physical voice acceptance remains outstanding; see the [hardware handover](docs/careloop/Hardware-Handover-2026-10-09.md) for the recorded checks and remaining work.

## Implementation and evidence

| Area | Recorded status |
| --- | --- |
| Software care workflow | 2 October: 231 backend tests on each of SQLite and PostgreSQL 15; 132 frontend tests; 28 Chrome workflow checks. Speech responses were mocked or scripted. |
| Native phone app | 2 October: 143 compatibility tests and TypeScript check; physical-device acceptance remains separate. |
| ESP32-S3 hardware | 9 October: bench build/flash, microphone and button checks passed. Amplifier playback remains unresolved; complete physical voice flow is unverified. |
| Live AI and hosting | Provider adapters and deployment configuration are present. Repository evidence does not establish live-provider accuracy or an operational public backend. |
| Submission evidence | Actual CodeBuddy / WorkBuddy development history and at least three chat screenshots still need to be assembled and verified. |

These are dated results, not a new test run. [Software verification](docs/careloop/VERIFICATION.md) and the [hardware handover](docs/careloop/Hardware-Handover-2026-10-09.md) contain the scope and remaining acceptance work. Durable offline voice capture is disabled. Clinical effectiveness and intended-user usability have not been established.

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
| [`docs/`](docs/README.md) | Architecture, product guides, submission preparation and evidence |

<p align="center">
  <img src="docs/readme-assets/parse-close.jpg" width="1200" alt="Parse: Care that stays in view. Original Parse logo on pearl, teal and navy artwork.">
</p>
