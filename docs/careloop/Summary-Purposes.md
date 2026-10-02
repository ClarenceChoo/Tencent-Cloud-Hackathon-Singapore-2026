# Care summary purposes and print handoff

Parse prepares a care summary from confirmed records the reviewer is permitted to see. The reviewer chooses a **doctor visit**, **family handoff**, or **weekly care review** purpose before preparing a draft. Doctor visit is the default for existing clients. The purpose changes the order and headings of the same selected evidence; it does not rewrite a source record, add a diagnosis, or make a recommendation. Each summary records its purpose and template version so an older reviewed copy remains interpretable.

## What the dates mean

The chosen start and end dates use the patient's timezone. Reported health notes and measurements use the event time when known and the recorded time when the event time is unknown. The statement still says that the event time is unknown. Medication reports use their scheduled time. Support requests within the period appear with their unresolved status. Open follow-ups and preventive care tasks describe **current context at the time the draft was generated**, even when their original dates fall outside the chosen period. These sections are labelled separately from the selected-period reports. An empty section does not imply that an event did not happen.

Each factual statement keeps its source record ID and version, and its original source wording remains available for review. The reviewer can omit a source-linked statement or edit the draft wording before saving a review. Omitted statements and their source references are excluded from a shared or printed copy. The source records remain unchanged.

## Authored questions

The reviewer may enter up to ten questions of at most 500 characters each. A question is labelled as an **authored question** with the confirmed account's display name and time. It has no care-record source ID. Mentioning a possible event in a question does not turn that event into a reported fact. The server supplies the author identity and timestamp; the browser only submits question text. Publicly shared summaries show the display name and time, never internal user IDs or email addresses.

## Review, sharing, and changes

Preparing a new purpose creates a new draft. It does not silently replace a reviewed shared summary. Changes to the purpose, statements, questions, or omissions require an explicit fresh review before sharing or printing. Sharing is a separate action after review and uses an expiring, read-only link. A subsequent review of changed content revokes earlier links. A corrected, deleted, or newly inaccessible source invalidates dependent summaries and their links; the reviewer must prepare and review a fresh draft. Expired or revoked links stop showing the summary.

Only a user with summary-management permission can prepare the private print handoff. **Print / Save as PDF** requests the current reviewed summary from the server again immediately before opening the browser print dialog. If access has changed, the summary is unreviewed or invalidated, or the fetched content differs from the selected reviewed version, printing is blocked. The print page shows the purpose, selected dates, generation and review times, source references and versions, and clearly separate authored questions. It is designed for multiple pages and long text.

Printed paper and downloaded PDFs are copies outside Parse. **They cannot be revoked** after printing or saving, even if a source changes or a share link later expires. Choose recipients and handle those copies accordingly. Parse does not store the print content in browser local or session storage, and printing does not automatically share or send it.

The public UI preview uses fictional examples and does not create summaries, call the API, record audio, or print private care data.
