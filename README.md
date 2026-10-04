# Parse — Tencent Cloud Hackathon Singapore 2026

Parse helps older adults record concerns, report medication status and share confirmed updates with permitted caregivers. The current hosted prototype combines the care dashboard and live phone audio on ChatGPT Sites, with the Aurora Pearl theme and current Parse logo. The original React/FastAPI implementation, ESP32-S3 cardholder and native app are also retained in this repository.

The original FastAPI browser companion runs at `/companion` beside its dashboard. It needs no installed phone app or pendant provisioning. Pair it from the owner's dashboard, then use the phone browser to review and confirm care updates that appear in the permitted caregiver timeline. The hosted Sites demo has the separate pairing and review flow below.

The [first-use guide](docs/careloop/First-Use-Guide.md) covers the owner, patient and caregiver handoff. Browser updates have [recording receipts](docs/careloop/Recording-Receipts.md) and [optional capture prompts with reviewed corrections](docs/careloop/Capture-and-Correction.md). The dashboard adds an [Attention panel](docs/careloop/Caregiver-Action-Inbox.md), [reviewed care names](docs/careloop/Care-Vocabulary.md), [source-linked care questions](docs/careloop/Ask-Parse.md), and [purpose-specific summaries with reviewed printing](docs/careloop/Summary-Purposes.md).

For the recorded walkthrough, see the [60-second browser companion demo](docs/careloop/demo/parse-web-companion-demo.mp4). It uses fictional data and simulated speech.

## Hosted dashboard and voice tool demo

Open the [Parse dashboard](https://parse-shared-voice.iians0n.chatgpt.site/) on a laptop using an invited ChatGPT account. The [public phone companion](https://parse-phone-companion.iians0n.chatgpt.site/phone) needs no ChatGPT sign-in, but it must be paired and approved by a dashboard account before recording.

1. In **Phone & voice**, create a pairing QR and scan it with the phone's camera. Open the link in Safari on iPhone, choose **Connect this phone**, compare the six-digit code, and approve it on the laptop.
2. On the laptop, choose **Listen live**; on the phone, choose **Start recording**. Keep the phone page open and visible. Clips are limited to 20 seconds.
3. Say one request, then tap **Stop recording**. Audio streams while you speak; transcription happens after Stop.
4. When the transcript appears on the laptop, choose **Review care update**. This triggers OpenAI function calling for that recording.
5. For a proposed change, check the server read-back and choose **Confirm and save**. For a status question, medicine explanation or clarification, read the response in **Phone & voice**; no care record is added.

Use fictional demo information. Record a new clip for every new request, correction or spoken confirmation. Reopening the same recording reuses its interpretation. Finish each proposal before starting an unrelated request; pending proposals expire after two minutes.

### Things to say

Replace bracketed names and dates with the values shown in your dashboard. These examples cover all **11 implemented voice functions**; the exact response depends on the current records and any missing details.

| Functionality | Example to say | Function | Expected result |
| --- | --- | --- | --- |
| Private care note | “Please record that I enjoyed a short walk in the garden this morning. Keep this note private.” | `propose_health_note` | A private note proposal; after confirmation, find it in **Timeline**. |
| Medication report | “I have not yet taken the Daily medicine dose scheduled for [date] at nine a.m. Singapore time.” | `report_medication` | A report for that dose in **Medications** after confirmation. Pick an **unconfirmed**, **not yet** or **uncertain** dose; the initial first dose is already marked taken. |
| Reported blood pressure | “Please record my blood pressure as 120 over 80, measured using my home blood pressure monitor this morning. I am the patient reporting this reading.” | `record_measurement` | A reading proposal with both values, source and approximate time; after confirmation, check **Timeline** and the blood-pressure chart in **Today**. |
| Existing care-plan task | “The existing task to review the care plan at a routine appointment needs discussion.” | `update_preventive_task` | A status-change proposal for the matching task in **Care plan**. Use a task whose current status permits that transition. |
| Ask a permitted person for support | “Please ask [name shown in Care circle] to help me collect groceries. This is a routine request.” | `request_support` | A proposal addressed to that permitted person; after confirmation, find the open request in **Support**. It does not send an email or dispatch help. |
| Resolve an existing follow-up | “Close the follow-up called Check that transport is arranged. I have arranged the ride.” | `update_followup` | A resolution proposal containing your reported outcome; after confirmation, the open transport follow-up becomes resolved in **Support**. |
| Review the current proposal by voice | “Yes, those details are correct.” | `confirm_current_update` | Reopens the one current, unexpired proposal. You must still click **Confirm and save** on the laptop. |
| Read medicine instructions | “What instructions are recorded for Daily medicine?” | `get_medication_explanation` | Shows the active checked plan's stored instructions and source in **Phone & voice**. |
| Check a support request | “What is the status of the request to arrange a ride to the appointment?” | `get_support_status` | Shows the stored open, acknowledged or resolved status of the matching request, including any recorded human outcome. |
| Check a follow-up | “What is the status of the follow-up called Check that transport is arranged?” | `get_followup_status` | Shows the matching follow-up's stored status and any human-reported outcome. |
| Ask for a missing detail or chat | “My blood pressure was 120 over 80.” Or: “Good morning, how are you?” | `respond_to_user` | The incomplete reading should prompt a question about missing facts; the greeting gets a brief nonclinical reply. Neither saves a care record. |

To demonstrate correction, leave exactly one note proposal pending, close its review window without saving, and record: **“Actually, change the note to say I enjoyed a short walk in the garden yesterday afternoon. Keep it private.”** Choose **Review care update**, inspect the revised read-back, then confirm it. Corrections use the original proposal function; they are not a twelfth function.

The [complete voice demo guide](docs/careloop/Voice-Tool-Demo.md) includes a suggested walkthrough, more medication and follow-up examples, sharing setup, repeat-demo tips and current verification limits.

### Other dashboard functions

- **Today**: attention items, confirmed-note counts, open support requests and reported blood-pressure readings.
- **Ask Parse**: preset questions with links to permitted source records, including the latest reading, open support requests and dose reports. These are separate from the phone's voice function calls.
- **Timeline, Medications, Care plan and Support**: saved care history, checked medication plans, reported doses, task transitions, request acknowledgement and recorded outcomes. **Add entry** also supports manual proposals and review.
- **Visit summary**: purpose-specific drafts with source records, editing, review, printing and controlled sharing. Changing a source can invalidate an earlier review or share link.
- **Settings**: care profile, reviewed names and sharing permissions for already invited teammates. Each account starts with its own fictional care space; a Site invitation alone does not share another account's care records or recordings.

The hosted demo supports live audio, transcription after Stop, and one application function per reviewed recording. Background reminders, push notifications and generated spoken replies are not enabled. OpenAI API use is billed separately from hosting. The instructions below cover the retained FastAPI/local implementation; its `/companion` routes and fictional local logins differ from the hosted Sites demo.

## Product films

The [Parse product films](demos/parse-product-demo/README.md) include [From her voice to her care circle](demos/parse-product-demo/exports/parse-companion-story.mp4), a 102-second concept story, and the [software walkthrough](demos/parse-product-demo/exports/parse-product-demo.mp4), a 93.8-second dashboard tour. Both are captioned, with editable source in the demo folder. Recorded on 23 September 2026, they use the earlier terracotta design and fictional data; the pendant and speech connection are simulated.

## Upload the ESP32-S3 firmware

Start with the **[ESP32-S3 setup and upload guide](firmware/README.md)**. It walks through installing ESP-IDF v5.4.2, configuring the actual board, finding its USB port, building and uploading the firmware, provisioning the device, connecting Wi-Fi, and checking the first recording. It includes macOS, Linux and Windows instructions, troubleshooting, and a map of the firmware source files.

The board specified for this setup is a **44-pin Type-C development board with an ESP32-S3-WROOM-1 N16R8 module: 16 MB flash and 8 MB Octal PSRAM**. The firmware guide includes its memory settings and a first-upload check using the development board alone. Confirm the seller's USB-port arrangement and pin labels before adding peripherals; Espressif documents the module's memory in its [WROOM-1 datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf).

The ESP32-S3 is the cardholder's voice interface. Hold its talk button to record a short message, then release it to send the complete recording over Wi-Fi to the backend. The backend handles speech recognition and the care conversation; the cardholder plays the returned speech. It also plays backend-issued medication reminders and nonclinical check-ins. Saving a confirmed care update and sharing it with a permitted caregiver happen through the backend's confirmation and access rules.

To get a working physical unit, follow this sequence:

1. Confirm the N16R8 module marking and the actual board's pin labels. For voice use, add the microphone, amplifier/speaker and a separate talk button, and record their wiring. The repository defaults leave these hardware pins unassigned; the onboard BOOT button is used for uploading firmware.
2. Install ESP-IDF v5.4.2 and use a project directory whose path has no spaces, such as `~/esp/parse`. In `firmware/`, select `esp32s3`, configure 16 MB flash and Octal PSRAM with `idf.py menuconfig`, and build. The guide explains how to check the bare board first and then enable the wired audio peripherals.
3. Connect a USB data cable, identify the serial port, and flash the firmware using the upload guide's commands. A successful upload establishes that the image was written; recording and playback need their own checks.
4. Use the [hardware pairing runbook](docs/careloop/Hardware-Pairing-Runbook.md) to prepare and flash this unit's private device credential, pair it to the owner's care space, and connect it to 2.4 GHz Wi-Fi and the deployed HTTPS backend.
5. Follow the upload guide's first-use checks: verify the physical unit is online, record a fictional note, hear the response, confirm the note, and check the permitted caregiver's dashboard.

The repository records a successful source build, but physical cardholder testing is still outstanding. The [firmware guide](firmware/README.md) explains the implemented behavior and remaining board checks in detail.

## Browser and dashboard requirements

- Python 3.11 or newer, with `uv`
- Node.js 22 or newer, with `npm`
- FFmpeg and FFprobe on `PATH` for audio normalization

Clone the repository and install the dependencies from its root:

```sh
git clone https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026.git
cd Tencent-Cloud-Hackathon-Singapore-2026
cd backend
uv sync --frozen --extra test
cd ../frontend
npm ci
npm run build
cd ..
```

## Try the browser flow locally

Use the loopback fixture for a safe, repeatable browser demonstration. It binds to `127.0.0.1`, creates a new fictional database under the ignored `runtime/` directory, and refuses to reuse an existing fixture directory.

```sh
backend/.venv/bin/python tools/web_companion_fixture.py \
  --data-dir runtime/web-companion --port 5190
```

Open [http://127.0.0.1:5190/companion](http://127.0.0.1:5190/companion) in a browser. The dashboard is at [http://127.0.0.1:5190/](http://127.0.0.1:5190/). To try the paired flow:

1. On the companion, select **Connect this browser** and keep the one-use code visible.
2. In the dashboard, sign in as `owner@web.invalid` with password `fictional-web-only`.
3. Open **Settings**, choose **Parse browser** as the companion type, enter the code, and select **Approve browser**.
4. Return to `/companion` and select **Check connection**.
5. The caregiver demo account is `caregiver@web.invalid`, also with password `fictional-web-only`.
6. For the guided setup, select the paired browser under **Settings → Reminder companion**, refresh the companion, and follow its speaker and microphone checks. Its static example sends no audio. The automated runner supplies the scripted first update and checks it through the caregiver's separate account.

These loopback URLs work on the computer running the fixture. To use a separate physical phone, follow the HTTPS deployment setup below. Use separate browser profiles or a private window if you want owner and caregiver dashboards open at the same time.

Both accounts and all fixture records are fictional and local to this demonstration. The fixture has no live speech recognition: a recording needs an explicitly armed scripted utterance to produce a transcript. A manual recording by itself will not be transcribed. The automated browser check and demo recorder arm these scenarios explicitly; replies are tones.

To run the automated Chrome scenario checks, install the locked Playwright dependency and start with a fresh fixture directory (the check revokes its browser pairing when it finishes):

```sh
npm ci --prefix tools
PARSE_WEB_FIXTURE_DIR=runtime/web-companion \
  node tools/browser_web_companion.cjs
```

Google Chrome must be installed for this runner. It uses synthetic microphone input. It checks real browser recording and upload through the audio decoder and care flow, while transcript/interpretation remain scripted. It does not test live ASR, a physical phone microphone, clinical effectiveness, or closed-browser alerts.

## Use a live, deployed companion

For live speech, deploy the dashboard and backend on the same HTTPS origin, configure speech/AI providers, and provision the owner account, patient care space and appropriate caregiver access. The `/v1/web` companion API rejects non-HTTPS requests outside testing; use the loopback fixture above for local browser-flow work. The fixture's scripted provider and fictional accounts must never be deployed.

1. Follow [deployment setup](deploy/README.md) to configure the host, domain, HTTPS proxy, database, and application.
2. Configure the [speech and AI providers](docs/careloop/PROVIDERS.md), then follow the deployment guide's explicit account provisioning steps.
3. Open the deployed dashboard and `/companion` on the same HTTPS hostname. On the companion choose **Connect this browser**; in owner **Settings**, choose **Parse browser**, enter the one-use code, and **Approve browser**.
4. Return to the companion and check the connection. Grant microphone permission when prompted.

Browser pairing does not require pendant firmware or a hardware provisioning pack. Browser recording works only while its page is open and active. It does not provide background or closed-browser alerts. Browser support and security details are in the [web companion guide](docs/careloop/Web-Companion.md).

## Dashboard-only local demo

The standard `tools/run_demo.py` launcher is for the local dashboard walkthrough at port 5173. It starts with `CARELOOP_PROVIDER=unconfigured`, `CARELOOP_TESTING=false`, and no provider credentials. It does not start the browser-companion fixture or provide live speech. Use the separate local fixture instructions above to exercise `/companion` without provider setup.

After installing the dependencies, run from the repository root:

```sh
python3 tools/run_demo.py
```

Open `http://127.0.0.1:5173/`. The fictional owner login is `owner@careloop.invalid` / `fictional-demo-only`; the caregiver login is `caregiver@careloop.invalid` / `fictional-caregiver-only`. This launcher preserves its demo records under `runtime/software-demo/`. Stop it with Ctrl+C.

## Run the checks

From the repository root:

```sh
(cd backend && uv run pytest)
npm --prefix frontend test
npm --prefix frontend run build
```

The Chrome scenario command above needs a running fresh web fixture. The [developer tools guide](tools/README.md) covers other fixtures and checks.

## Existing verification

The web companion guide records the latest repository evidence, dated 29 September 2026:

- Backend suite: 148 tests passed on SQLite and on an isolated PostgreSQL database.
- Frontend suite: 35 tests passed; production build passed.
- Chrome: 13 browser checks passed, including four synthetic MediaRecorder uploads and owner pairing, review/confirmation, caregiver updates, permission denial, and revocation.
- Layout checks passed at 320, 390, 768, and 1440 pixels; mobile and caregiver screenshots were visually reviewed. Safari, physical-phone audio, and closed-browser delivery were not tested in that run.

See the [browser evidence JSON](docs/careloop/evidence/web-companion-ui-2026-09-29.json), [mobile screenshot](docs/careloop/evidence/web-companion-mobile-2026-09-29.png), and [caregiver screenshot](docs/careloop/evidence/web-companion-caregiver-2026-09-29.png). For current test commands and broader product status, see [verification status](docs/careloop/VERIFICATION.md).

## More detail

- [Voice tool demo guide](docs/careloop/Voice-Tool-Demo.md): phrases for all eleven hosted voice functions, expected results and a demonstration sequence.
- [Web companion guide](docs/careloop/Web-Companion.md): product behavior, browser limits, demo and test evidence.
- [Deployment instructions](deploy/README.md): HTTPS, provider configuration and explicit production provisioning.
- [Backend setup](backend/README.md): local backend and administrator commands.
- [ESP32-S3 setup and upload guide](firmware/README.md): detailed hardware onboarding, firmware behavior, USB flashing and troubleshooting.
- [Implemented API contract](backend/API.md): dashboard, device and browser API behavior.
- [Verification status](docs/careloop/VERIFICATION.md): tested behavior and remaining validation.

## Repository map

| Directory | Purpose |
| --- | --- |
| `frontend/` | Browser companion at `/companion` and caregiver dashboard at `/` |
| `backend/` | Care records, pairing, access controls and speech-provider adapters |
| `deploy/` | HTTPS proxy and container setup |
| `tools/` | Local fixtures, browser tests and demo recording tools |
| `mobile/` | Retained native phone companion |
| `firmware/` | ESP32-S3 cardholder firmware |

For the physical cardholder, see the [hardware pairing runbook](docs/careloop/Hardware-Pairing-Runbook.md). Native app setup and its separate validation status are in the [phone companion guide](docs/careloop/Phone-Companion-Setup.md).
