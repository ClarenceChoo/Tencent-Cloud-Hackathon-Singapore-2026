# Parse: users and connected workflow

This map describes the implemented connection paths. The demo people are fictional: Alex is the care-space owner, Mei is the patient, and Jamie is the caregiver. An owner is the person managing a patient's care space; they do not have to be the patient.

## Who connects to what

```mermaid
flowchart TB
    Admin["Setup administrator / developer<br/>Creates accounts and patient care space via CLI"]

    subgraph People["People and their interfaces"]
        direction LR
        Owner["Owner: Alex"] --> OwnerUI["Owner dashboard<br/>Care records, settings and sharing"]
        Patient["Patient: Mei"] --> Companion["Paired patient companion<br/>Browser OR native app OR ESP32 cardholder"]
        Caregiver["Caregiver: Jamie"] --> CareUI["Caregiver dashboard<br/>Permitted records and assigned requests"]
    end

    Admin -.->|Initial provisioning| Backend
    OwnerUI -.->|Approves pairing; selects reminder companion| Companion
    OwnerUI -.->|Grants or revokes access| CareUI

    OwnerUI <-->|Care updates and settings| Backend["Shared Parse backend<br/>Checks identity, permissions and confirmation"]
    Companion <-->|Recordings, review, confirmation and reminders| Backend
    CareUI <-->|Permitted care updates and support outcomes| Backend

    Backend <-->|Speech to text, interpretation and spoken replies| Speech["Configured speech and AI providers<br/>Tencent ASR / TTS and configured LLM"]
    Backend <-->|Save only after explicit confirmation; filter reads by access| Records[("Shared care database")]

    OwnerUI -->|Prepare, review, then explicitly share| Summary["Visit / family / weekly summary<br/>Expiring read-only link or printed copy"]
    Summary --> Recipient["Doctor or other chosen recipient<br/>Reads the shared summary"]

    classDef person fill:#e6f3ed,stroke:#53816b,color:#163d2b;
    classDef interface fill:#e9f0ff,stroke:#6c82b5,color:#183254;
    classDef system fill:#f0eafb,stroke:#8a72af,color:#342248;
    classDef external fill:#fff1dc,stroke:#b39155,color:#503a19;
    class Owner,Patient,Caregiver person;
    class OwnerUI,Companion,CareUI interface;
    class Backend,Records system;
    class Admin,Speech,Summary,Recipient external;
```

The owner and caregiver use the same dashboard application with different access grants. Each companion communicates with the shared backend independently. The ESP32 cardholder uses Wi-Fi; the implemented path does not relay its recordings through Bluetooth or through the native app.

Dashed connections represent setup and access decisions. The backend enforces them; one dashboard does not directly authorize requests made by another dashboard or companion.

## A patient's voice update

```mermaid
flowchart TB
    Start["1. Mei records a concern or medication report"]
    Receive["2. Paired companion sends recording to the backend"]
    Interpret["3. Configured providers transcribe and interpret<br/>Backend validates a proposed update"]
    Review["4. Mei reviews the read-back and sharing choice<br/>Nothing has been saved as a care record yet"]
    Decision{"Confirm, correct, or cancel?"}
    Correct["Correct the wording<br/>A replacement proposal needs fresh review"]
    Cancel["Cancel<br/>No care record is committed"]
    Save["5. Explicit confirmation saves the care record"]
    OwnerView["Owner can view the saved record"]
    Sharing{"Caregiver permitted to see this record?"}
    CareView["6. Jamie sees it in the caregiver dashboard<br/>Health notes also require explicit sharing"]
    Private["Record stays outside Jamie's view"]
    Request["If it is a support request assigned to Jamie:<br/>Jamie explicitly acknowledges it and reports its outcome"]

    Start --> Receive --> Interpret --> Review --> Decision
    Decision -->|Correct| Correct --> Review
    Decision -->|Cancel| Cancel
    Decision -->|Confirm| Save
    Save --> OwnerView
    Save --> Sharing
    Sharing -->|Yes| CareView --> Request
    Sharing -->|No| Private
```

The owner and a permitted caregiver can also enter care updates through the dashboard. Their care facts follow the same proposal, review and explicit-confirmation process. AI interpretation, reminder playback, and successful upload never count as confirmation of a care fact.

## Other connected workflows

- **Setup:** the administrator provisions accounts and the patient care space; the owner grants caregiver access, approves companions, and chooses the reminder companion.
- **Reminders:** the backend schedules checked medication-plan reminders and optional check-ins for the selected companion. A patient's explicit medication report is separate from whether a reminder played. Browser reminders require an open, active companion page.
- **Caregiver follow-through:** an assigned support request appears in the authorized caregiver's care view. Only its assigned recipient can acknowledge it; reporting a later outcome is a separate action.
- **Appointments and handoffs:** the owner prepares a summary from permitted confirmed records, reviews it, then separately shares a read-only expiring link or prints it. Printed or downloaded copies cannot be revoked.

## Accounts and boundaries

| Person | How they access Parse | Responsibility |
| --- | --- | --- |
| Owner | `owner@careloop.invalid` in the dashboard | Patient settings, companion setup, care records, caregiver access, sharing and summary review |
| Caregiver | `caregiver@careloop.invalid` in the dashboard | Permitted records, reviewed care updates, assigned support requests and outcomes |
| Patient | Owner-approved browser, native app or cardholder | Reports concerns, reviews proposals, explicitly confirms updates and receives reminders |
| Setup administrator | Provisioning commands on the backend | Creates accounts, care spaces and hardware credentials; this is an operational responsibility, not a third dashboard login role |
| Doctor / other summary recipient | Explicitly shared link or printed copy | Reads the reviewed summary; no doctor dashboard account or clinical-system integration is implied |

The current `tools/run_demo.py` session runs the dashboard and backend with fictional data and `CARELOOP_PROVIDER=unconfigured`. Live speech needs separate provider and HTTPS setup. The browser flow has scripted local test evidence; native physical-device acceptance and physical cardholder operation remain unfinished.

Source guides: [First use](First-Use-Guide.md), [browser companion](Web-Companion.md), [native companion](Phone-Companion-Setup.md), [hardware pairing](Hardware-Pairing-Runbook.md), [providers](PROVIDERS.md), [summaries](Summary-Purposes.md), and [verification](VERIFICATION.md).
