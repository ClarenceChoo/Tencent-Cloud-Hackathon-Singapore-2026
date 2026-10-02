# Caregiver action inbox

The **Attention** panel on Today gathers work from the current care space's authorized dashboard. Each row names its source and opens that source's existing review or record view. The panel does not create another task record or grant any new permission. Its count is the number of visible panel rows, after the dashboard has applied record sharing and grant rules.

| Source | When it appears | What opening it does |
| --- | --- | --- |
| Pending proposal | Pending or awaiting confirmation | Opens the existing proposal review dialog when the viewer has care-writing permission and the proposal is unexpired. An expired or read-only proposal opens its Timeline row without a confirmation action. |
| Support request | Open, sent, pending, or acknowledged | Opens the exact Support request. Only its assigned recipient with acknowledgement permission sees **Acknowledge** there. Existing resolution permission and a reported outcome govern resolution. |
| Follow-up | Open and unresolved | Opens the exact Follow-up in Support. Care writers can use its existing reported-outcome review flow; other viewers can inspect it. |
| Preventive care task | Planned, due, arranged, or needing discussion | Opens the exact Care plan task. Its existing state-transition review flow controls changes. |

Completed, declined, cancelled, closed, and resolved source rows are omitted where those states apply. Proposals that have already been committed do not appear. No action is inferred from an unanswered medication reminder or an unreported dose; a missed dose requires a person's explicit report.

The groups appear in this order: proposals for review, assigned requests, dated follow-ups and tasks, then items without a due time. Known dates sort by the patient's calendar date and then due time. A date-only care task remains a calendar date in the patient's IANA timezone; it is never interpreted as midnight UTC. The panel marks a date-only task overdue only after that local date ends. A follow-up timestamp becomes overdue after its specified instant. Unknown due times stay marked **No due time given**.

Opening a panel row moves focus to the matching source row on Timeline, Support, or Care plan. The source view retains the existing confirmation, acknowledgement, resolution, and proposal controls. After a successful write, the dashboard is reloaded and the panel is recomputed from the server response. A change of care space clears the previous space's records, open dialogs, and panel immediately; late responses from the previous space are ignored. A session or access failure clears the care view. The fictional public preview uses sample data and its API writes remain inert.
