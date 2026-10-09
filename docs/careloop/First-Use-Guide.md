# First use: from pairing to a confirmed update

This guide is for a care-space owner setting up Parse with the person who will use the companion. The browser, native phone app, and physical cardholder have different controls. Use fictional data for a demonstration. A care record exists only after the person reviews a proposal and explicitly confirms it.

## Before you begin

- An administrator or care-space owner must have created the patient space and the intended users and access grants. The owner needs device-management access. A caregiver needs their own account and permission for the particular shared record.
- Use an HTTPS Parse service and a supported, current browser for the browser companion. The browser needs network access while its page is open. Keep the owner dashboard and the patient’s companion in their separate sessions.
- Decide which paired device should receive reminders. Pairing does not select a reminder destination. The owner chooses one under **Connect → Reminder companion**.
- Check the service status shown under Connect. “Configured” says the provider is configured; it does not prove a live voice turn succeeded. “Simulated” means fixture speech for testing.

## Browser companion

1. On the patient’s browser, open `/companion` and choose **Connect this browser**. Read the short-lived code on that page. The code is for owner approval; do not place it in a message or a care note.
2. In a separate owner dashboard session, open **Connect → Pair your companion**, select **Parse browser**, enter that exact code, and approve it for the intended patient. Back in the patient’s browser, choose **Check connection**. Confirm the displayed person before continuing. If the code expires, start a fresh enrollment.
3. Check the current connection and ask the owner to select this browser as the reminder companion if that is the intended destination. The patient can refresh the browser to see the selection. Browser reminders play only while the companion page is open and visible; the browser does not deliver closed-page alerts or keep durable audio.
4. Open the **First-use guide** on the companion page. Choose **Play speaker check** and listen to the entire short message. It tests output audio only. If speech is simulated, the guide says so and does not mark live voice as verified.
5. Choose **Check microphone permission**. The browser asks only after this tap. The exercise immediately releases the microphone and sends no audio. Cancel, leave the page, or switch away while permission is pending to discard a late grant. If permission is denied, change the browser or operating-system permission and retry.
6. Choose **Start first update**, then use **Tap to record**. Speak a short, appropriate update. Tap **Tap to send** and wait for the recording receipt. Read the proposed update and recipients. Choose **Confirm and save** only if every detail is right, or **Cancel**. A correction produces a new proposal that must be reviewed and confirmed. The setup guide recognizes only a record confirmed through this browser session’s first-update path; existing records do not count.
7. To verify caregiver visibility, explicitly share an appropriate record with the intended recipient. Ask that caregiver to sign in to **their own account** and view it there. The owner’s dashboard cannot prove the recipient has seen it. A caregiver without record access must not see the record.

The **static example** in the guide is only explanatory text. It never asks for microphone access, calls the care API, saves a record, or proves a speech provider works. A successful non-simulated completed turn is the only basis for the guide’s session-local live voice indicator. Reloading the page clears speaker, microphone and first-update proof; current pairing, patient and reminder selection are read again.

If upload status is uncertain, use **Check recording** and its receipt before starting another recording. The browser keeps an opaque receipt identifier for recovery, never the care text or audio. If access is revoked, the patient changes, or the device identity changes, the guide clears its temporary proof. The owner should revoke the old installation under Connect when replacing it.

## Native phone app

Use the native app’s own enrollment and speaker controls in [Phone Companion Setup](Phone-Companion-Setup.md). The app has its own permission prompts, a **Test speaker** action, recording gesture choice, local reminder scheduling, and optional push setup. Its background alert behavior depends on native permissions and operating-system settings; browser page-open readiness does not describe it. Owner approval, reminder selection, review and explicit confirmation remain separate. Test the caregiver handoff under the caregiver’s account as above.

## Physical cardholder

Follow [Hardware Pairing Runbook](Hardware-Pairing-Runbook.md) for the cardholder’s one-use code, Wi-Fi provisioning, connection light/status, and physical talk button. Keep the code distinct from the Wi-Fi setup password. A successful network heartbeat is separate from pairing. Press the talk button to capture speech, then listen to the read-back and explicitly confirm. Check the resulting timeline under an authorized account. The browser’s microphone exercise and page-open reminder rule do not apply to hardware.

## When a step stalls

| Symptom | Check |
| --- | --- |
| Code expired or approval used the wrong person | Start a new enrollment and have the owner approve the new code for the correct patient. |
| Paired but disconnected | Check HTTPS/network access and refresh the companion. Do not treat the pairing badge as a live connection. |
| Reminders do not arrive in the browser | Confirm this exact browser is selected and keep its page open and visible. Check whether the server scheduler is enabled. |
| Speaker check fails | Check volume and output device; retry after checking provider status. A simulated sample does not verify live service. |
| Microphone denied or interrupted | Retry after granting browser permission. The exercise sends no audio and can be cancelled. |
| Recording outcome is uncertain | Use the existing receipt recovery control before recording again. Never assume the update was saved. |
| Caregiver cannot see the note | Review the note’s explicit sharing and that caregiver’s record-level grant, then verify in their account. Do not infer delivery or acknowledgement from the owner view. |

For a fictional demonstration, an authorized user can remove the resulting example care record through the normal record-management controls, if available. Confirm that the user has permission and that any dependent summaries or views are refreshed; do not use a database edit or a device reset as a shortcut.
