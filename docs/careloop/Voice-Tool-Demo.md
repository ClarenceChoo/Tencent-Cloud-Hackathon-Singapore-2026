# Parse hosted voice tool demo

This guide describes the hosted prototype as of **4 October 2026**. Use the [private dashboard](https://parse-shared-voice.iians0n.chatgpt.site/) with an invited ChatGPT account. Its pairing QR opens the [public phone companion](https://parse-phone-companion.iians0n.chatgpt.site/phone), which needs no ChatGPT account. Use fictional information throughout the demonstration.

The [README's phrase table](../../README.md#things-to-say) covers all eleven voice functions. This guide adds setup, a demonstration sequence and variants.

## Prepare the demonstration

1. Sign in on the laptop and open **Phone & voice**. On a narrow screen, open the navigation menu to find it.
2. Create a pairing QR, scan it with the iPhone camera and open the link in Safari. Choose **Connect this phone**, compare the six-digit code on both devices, and approve the phone on the laptop. The QR is single-use and expires after ten minutes; an approved phone pairing lasts up to 24 hours.
3. Choose **Listen live** on the laptop. Use headphones to avoid feedback. Allow microphone access on the phone when you start recording; keep Safari open and visible.
4. Check the sample records before recording: **Sample daily medicine** in the active checked medication plan, an eligible scheduled dose in **Medications**, the routine care-plan review task, the request about a ride to an appointment, and the open follow-up **Check that transport is arranged** in **Support**.
5. For a support request, copy an actual permitted person's name from **Care circle**. To use a teammate, add the already invited teammate under **Settings → Sharing permissions**, with the relevant care permissions. A native Site invitation and access to your care space are separate permissions. Notes stay private unless sharing is explicitly selected.

Each dashboard account owns its own recordings and fictional care space. Pair the phone from the account whose dashboard you are demonstrating. Care sharing can expose permitted records to a teammate; it does not expose the owner's recordings, pairing or proposal administration.

## How each spoken request works

On the phone, choose **Start recording**, say one request, and choose **Stop recording**. Clips stop automatically at 20 seconds. The laptop receives audio while you speak. After Stop, the backend transcribes the complete recording.

On the laptop, wait for the transcript and choose **Review care update**. OpenAI selects one of the eleven application functions using the transcript and the current permitted care records. A write function prepares a proposal. Check its read-back and fields, then choose **Confirm and save**. The backend saves that exact reviewed version and rechecks the referenced records and permissions.

Medicine explanations, status checks and clarification responses appear as text in **Phone & voice**, without adding a care record. The demo does not speak those replies aloud.

Use a new recording for every new utterance, including corrections and spoken confirmation. Repeated review of one recording returns its stored interpretation. Resolve or save each pending proposal before an unrelated request: correction and spoken confirmation need exactly one unexpired pending proposal. A proposal expires after two minutes; if it expires, prepare and review a fresh version before saving.

## Suggested walkthrough

1. **Show live audio and create a note.** Say: “Please record that I enjoyed a short walk in the garden this morning. Keep this note private.” Stop, wait for the transcript, and choose **Review care update**. Show the proposal before saving anything.
2. **Correct it.** Close the review window without saving. Record: “Actually, change the note to say I enjoyed a short walk in the garden yesterday afternoon. Keep it private.” Review the new recording and show the revised time in the read-back. This uses `propose_health_note` with a correction operation.
3. **Show spoken confirmation and save.** Close the review window again. Within two minutes, record: “Yes, those details are correct.” Review this recording. It should reopen the same current proposal through `confirm_current_update`. Click **Confirm and save**, then open **Timeline** and show the saved private note. Voice confirmation alone does not save it.
4. **Add a reading.** Record: “Please record my blood pressure as 120 over 80, measured using my fictional home blood pressure monitor this morning. I am the patient reporting this reading.” Review and confirm. Show **Timeline** and the reported reading in **Today**.
5. **Explain a medicine.** Record: “What instructions are recorded for Sample daily medicine?” Review the recording and show the checked plan's instruction text and source in **Phone & voice**. No new report is created.
6. **Report a scheduled dose.** In **Medications**, find an unconfirmed dose and note its exact displayed date and time. Say: “I have not yet taken the Sample daily medicine dose scheduled for [date] at nine a.m. Singapore time.” Replace the date and time with that dose's values. Review and confirm, then show the reported status.
7. **Update the care plan.** If the sample task is still arranged, say: “The existing task to review the care plan at a routine appointment needs discussion.” Review and confirm, then show its new status in **Care plan**.
8. **Create a support request.** Say: “Please ask [name shown in Care circle] to help me collect groceries. This is a routine request.” Use the actual permitted name, review and confirm, then show the open request in **Support**. This updates Parse; it does not email the recipient or dispatch assistance.
9. **Read recorded support status.** Say: “What is the status of the request to arrange a ride to the appointment?” Review the recording and read the stored status. You can acknowledge that existing request using the dashboard's control, then make a fresh recording of the same question to show the updated stored status.
10. **Read and resolve a follow-up.** First ask: “What is the status of the follow-up called Check that transport is arranged?” Then make a new recording: “Close the follow-up called Check that transport is arranged. I have arranged the ride.” Review and confirm the proposed outcome. Ask the status question in another recording to show the resolved follow-up and the outcome you reported. Resolving the follow-up does not independently resolve its related support request.
11. **Show clarification.** Say only: “My blood pressure was 120 over 80.” Review it and show the question about a missing fact, such as source or time. To answer, make a new recording containing the complete reading, source, occurrence time and reporter; the next recording is not a free-form chat continuation.
12. **Show the wider dashboard.** Use a preset question in **Ask Parse** and open its source. In **Visit summary**, choose a purpose and date range, prepare a draft, inspect its sources, review it and demonstrate printing or permitted sharing.

## Additional phrases and setup

| What to demonstrate | Example to say | Setup and expected result |
| --- | --- | --- |
| A reported taken dose | “I took the Sample daily medicine dose scheduled for [date and time] after breakfast.” | Select a dose still unconfirmed, not yet or uncertain in the active checked plan. Confirmation records the person's report of taking it; it does not verify ingestion. |
| A skipped or uncertain dose | “I skipped the Sample daily medicine dose scheduled for [date and time].” Or: “I am not sure whether I took the Sample daily medicine dose scheduled for [date and time].” | Identify one eligible dose. Confirmation records skipped or uncertain. A final taken or skipped report cannot be overwritten by this tool. |
| A completed care-plan task | “Please mark the existing task to review the care plan at a routine appointment as completed on [full date].” | The task must currently permit completion, such as an arranged task. Supply the reported completion date. A completed task cannot be completed again. |
| A new care-plan task | “My fictional care plan says review my mobility with my care team. Add a planned follow-up visit, due [full date], in Singapore time. The source is my fictional care plan.” | Requires explicitly entered plan details: task type, description, source, due date, timezone and status. The tool does not invent clinical recommendations or book an appointment. |
| Create a private follow-up | “For the existing request to arrange a ride to the appointment, create a private follow-up for [full date] at ten a.m. Singapore time.” | The related request must already exist. Use an explicit date, clock time and sharing choice. For a demo on 4 October 2026, 5 October 2026 at 10 a.m. is an example. Confirmation creates an open follow-up in **Support**; it does not schedule a push notification. |
| Share a new note with a permitted person | “Please record that I enjoyed a short walk this morning and share this note with [permitted name].” | The person must already be a permitted recipient. Check the recipient in the proposal before saving. Private notes are not automatically shared with all teammates. |
| Brief conversation | “Good morning, how are you?” | Uses `respond_to_user` for brief nonclinical conversation. It does not create a note. |

The six write functions can revise their own identified pending proposal. For example, a pending reading can be corrected with: “Actually, change the blood pressure to 118 over 76. Keep the same monitor and this morning's time.” Review the complete revised read-back before confirming. To correct an already saved reading, use the dashboard's **Correct** action and review the replacement; pending-proposal correction and confirmed-record correction are different flows.

## What to show outside voice calling

| Dashboard view | Implemented functionality |
| --- | --- |
| Phone & voice | QR pairing and approval, live received audio, completed recordings, transcripts, voice interpretation and reopening a prepared proposal. |
| Today | Attention items, care metrics and a chart of reported blood-pressure values. |
| Ask Parse | Preset questions answered with permitted stored records and source links; it is separate from the phone interpretation flow. |
| Timeline | Confirmed notes, medication reports, external readings, care-plan updates and support requests, with source/provenance details. |
| Medications | Checked medication plans, scheduled doses and reviewed reports of taken, skipped, not yet or uncertain status. Voice cannot activate a new medication plan or change a prescribed dose. |
| Care plan | Entered plan tasks, allowed status transitions and reported appointment/completion dates. |
| Support | Requests to permitted people, human acknowledgement, reported outcomes and related follow-ups. |
| Visit summary | Purpose-specific drafts, source inspection, editing, review, printing and controlled share links. Source changes can invalidate an earlier review or link. |
| Settings | Care profile, reviewed vocabulary and removable care permissions for already invited teammates. |

## Repeat-demo tips and verification

- Match the actual dashboard records. The original sample's first dose is already marked taken; use an eligible dose instead. Dates come from the care space's initial creation and do not reset each day.
- Say a person's displayed name and identify the medicine, dose, task or request clearly. If several records match, Parse should ask for clarification rather than guess. Distinguish the seeded ride request from a new groceries request.
- If a task has already changed status or a follow-up is already resolved, the same write example may no longer be valid. Read its current state and use another allowed transition or create a new fictional follow-up. There is no automatic reset between demonstrations.
- If the transcript is missing or transcription failed, that recording cannot enter the care interpretation flow. Make a fresh recording once the service is available. Do not use an older failed clip to demonstrate tool calling.
- The phone page must remain open. This prototype has no background recording, scheduled reminder delivery, push notifications or generated spoken replies. OpenAI API usage is billed separately from hosting.
- Three live OpenAI function-selection checks passed for a private note, an external blood-pressure reading and an existing care-plan task transition. Simulated provider checks cover all eleven handlers and their confirmation/access rules. The full eleven-function live walkthrough and physical iPhone microphone/playback acceptance still need to be exercised; these phrases are a demonstration guide, not a claim that every spoken example has already passed on a phone.

The original FastAPI `/companion` implementation and its local scripted fixtures are documented separately in the [web companion guide](Web-Companion.md). Their local logins, provider settings and device flow do not configure the hosted ChatGPT Sites demo.
