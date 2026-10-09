# Navigation and Activity Log

The dashboard opens on **Today**. Its five main destinations are:

| Destination | What belongs here |
| --- | --- |
| Today | Attention, medication check-ins and useful current information. Zero-only statistics and empty support/task cards are hidden. Readings and companion status are under **More care details**. |
| Timeline | Readable care history. **Prepare summary** opens the owner-managed summary workflow. |
| Medications | Checked medication plans, scheduled doses and confirmed dose reports. |
| Care | **Tasks** and **Requests & follow-ups** in one place. A count marks open requests. |
| Log | Detailed, searchable recorded activity with timestamps, sources and states. |

**Connect** is separate from the **Settings** gear in the header. It opens pairing, device diagnostics and reminder-companion selection. The button reads **Waiting for connection** for a selected companion that has not connected, **Connected** when the selected companion has a fresh live connection, and **Offline** after that connection becomes stale. It returns to **Connect** if no companion is selected or its access was revoked. A failed dashboard refresh shows **Status unavailable** instead of keeping an old Connected label. The public UI showcase labels this **Connection demo**, never as a real live connection. Caregivers can view status; pairing and routing remain owner/management controlled.

Settings contains preferences, reviewed care names and sharing permissions. **Check records** is an action on Today. These screens retain return controls and the existing permissions and review flows. Clicking controls does not show the focus outline; navigating with Tab retains it.

## What Log records

Log reads persistent backend evidence rather than keeping a second browser history. Each care space has its own newest-first feed:

- Proposed care notes, readings, medication reports, tasks, support requests and follow-ups, followed by separate confirmed entries when saved.
- Recording receipts and processing states for owners or device managers. A receipt means the backend received the recording; it does not mean the care update was confirmed.
- Checked medication plans, queued reminders and recorded playback acknowledgements. Playback is separate from taking medication.
- Support acknowledgement and recorded outcomes. Successive new outcomes are retained separately.
- Summary preparation, review, link creation and link revocation.
- Recorded profile, reviewed vocabulary, pairing, companion-routing, note-sharing, deletion and access changes.

Use **Search activity**, **Category**, **From** and **To**, then **Apply filters**. Dates and displayed times use the care space's timezone. **Clear** resets the filters, **Refresh log** fetches current activity, and **Load older activity** retrieves the next page. **Entry details** shows the safe event ID and record reference.

## Access and history

Every request rechecks the current patient grant and category permissions before pagination. Caregivers see shared notes, requests assigned to them and permitted follow-ups. Owners or management-scoped accounts can see the corresponding administrative activity. Deleted notes and notes whose sharing was removed cannot be recovered through Log. Closed unconfirmed drafts retain generic receipt metadata rather than their old wording. Changing care space or access clears the previous results.

Log excludes raw audio, unrestricted transcripts, provider errors, credentials, share tokens and arbitrary audit payloads. It is a view of retained application activity, not a continuous recording or an audio archive. Existing recording retention and confirmation rules still apply.

Historical entries appear where the database already has evidence and timestamps. Previously unrecorded changes cannot be reconstructed. Newly added administrative audit events begin with this implementation. Proposal receipt entries display their **current** state at the original receipt time; they do not invent a cancellation or revision timestamp. Existing support outcome history can only show its retained latest outcome; successive outcomes recorded after this change have individual entries. Patient-reported occurrence times remain available in the care records and Timeline; Log orders by the time Parse recorded the activity.

The public UI showcase uses fictional in-memory Log examples and never requests the backend or writes to browser storage.

## Implementation

`GET /v1/app/patients/{patient_id}/activity` merges permitted proposal, recording, plan, support, reminder, summary, vocabulary and whitelisted audit records in SQL. A timestamp-and-ID cursor gives stable pages without the dashboard's latest-100-dose cap. Search and category/date filtering run on the server. No database migration or new dependency is needed.

The frontend aborts requests when the care space, filters or access revision changes, ignores late responses, and clears results on access errors. Existing browser smoke helpers map the previous secondary destinations to their new locations.
