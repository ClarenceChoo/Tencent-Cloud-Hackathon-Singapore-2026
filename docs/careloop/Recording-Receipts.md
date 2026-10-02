# Browser recording receipts

The Parse browser companion shows a recording receipt from the moment recording starts through the server outcome. The card uses the existing turn receipt, turn status, proposal, confirmation, and Home responses. It does not create another upload path or save a proposal without an explicit confirmation.

| Display | Evidence and meaning | Next step |
| --- | --- | --- |
| Recording | Microphone capture is local. Nothing has been uploaded. | Send or cancel. |
| Sending recording | The browser is waiting for the upload response. Its outcome may be uncertain if the response is lost. | Stop waiting if needed, then check the receipt. |
| Receipt unknown | An opaque turn key exists, but the browser has no confirmed server outcome. A `404` lookup still leaves the result uncertain. | Use **Check recording** before making another recording. |
| Recording received | The server reports accepted, transcribing, transcribed, or processing. This does not mean a care record was saved. | Check again. The interface shows no invented progress percentage. |
| Ready for your review | A current, unexpired proposal with the matching context is available. | Read the full read-back and explicitly confirm, change, or cancel it. |
| Saved to your care space | The turn result or confirmation response explicitly reports committed. | The card gives record details only when a fresh authorized Home response contains that exact record ID and type. |
| Not saved | The user cancelled a proposal. Cancelling microphone capture before transmission is shown separately as a discarded recording. | Record again if desired. |
| Recording could not be processed | The turn failed. A clarification request also says that no care record was saved. | Record again if desired. |
| Review no longer available | The proposal is expired or is no longer the matching current proposal. | Make a new recording; an old read-back cannot be confirmed. |

A successful save remains saved if its spoken reply expires. Expired audio cannot be played. The card can show “Current details are unavailable here” after a failed Home refresh, a deleted or newly private record, or a record outside Home's bounded lists. It does not substitute a similar record, infer that a missing proposal was committed, or claim that a recipient viewed or acknowledged a shared item. Named recipients appear only when the exact visible Home record still identifies them and the current permitted-recipient list resolves their names.

The browser stores only the opaque turn key, optional turn and context IDs, creation time, device and patient IDs, and an optional bounded recording-purpose enum in session storage until the outcome is checked. It keeps no recorded audio, transcript, read-back, care text, or spoken reply there. A reload presents **Receipt unknown** for a matching paired device and patient; **Check recording** performs only read-only receipt and turn requests. It never reuploads, confirms, or plays speech. Pairing revocation, a changed device, or a changed patient clears the pending lookup and its visible details. Dismissing the lookup clears the local key, so the earlier outcome may only be found in current care details.

If a receipt remains unknown, keep the current page open, use **Check recording**, and check the current care view. A missing receipt means Parse has not found that key; it does not prove that a new recording is safe from duplicate effects. If access is revoked or the session expires, reconnect through owner approval before checking again. A reply or proposal that expires requires a fresh user action.

The browser fixture helper `tools/receipt_browser_checks.cjs` exports `recoverLostReceipt` and is integrated into `tools/browser_web_companion.cjs`. It intercepts one upload response **after server acceptance**, reloads the page, uses the keyboard to check the receipt, and asserts one upload, no automatic confirmation or audio fetch, no premature caregiver note, and no transcript in storage. The runner then corrects and explicitly confirms once, checks exactly one new permitted caregiver note and the saved receipt, and exercises 320px layouts and actual 200% text. Executed results and the synthetic/fictional scope are recorded in [verification](VERIFICATION.md).
