# Dashboard navigation and activity log

## Intended result

Reduce eight primary destinations to **Today, Timeline, Medications, Care, Log**. Keep Settings as an accessible gear button, record questions as a Today action, and summary preparation as a Timeline action. Preserve the existing care confirmation and permission controls.

Timeline remains a readable account of care facts. Log is the detailed, read-only history of received recordings, proposals, confirmed records and revisions, medication-plan reviews, support acknowledgements/outcomes, companion/reminder activity, summaries, and administrative changes. A recording receipt is not a confirmed care record.

## Implementation sequence

1. Simplify the app shell and start on Today. Map existing task/support deep navigation into a combined Care view with Tasks and Requests/follow-ups sections. Keep assigned requests visible with a navigation count. Put Check records on Today and Prepare summary on Timeline, with return controls for those secondary screens.
2. Simplify Today: suppress zero-only statistics, put Attention and medication check-ins first, and place readings and companion details in a collapsible More care details section. Keep the existing Add entry review flow.
3. Add a patient-scoped backend Log endpoint over the existing persistent records. Use a stable newest-first cursor, server-side text/category/date filtering, patient-timezone date boundaries and a capped page size. Query historical dose reports independently of the dashboard's latest-100 limit. Existing recorded events appear immediately; no fabricated historical events or audio archive.
4. Enforce current patient/category/record permissions before pagination. Hide private or deleted notes, other recipients' requests and follow-ups, unshared proposal content and raw voice content from caregivers. Administrative and unconfirmed-recording metadata is owner/management scoped. Never expose credentials, tokens, raw audio, provider errors or arbitrary audit payloads.
5. Record currently missing administrative mutation events using the existing AuditEvent table: device revocation, note sharing/deletion, access changes, support outcomes and summary review/sharing. Keep retained audit content generic, so deletion cannot be bypassed through Log. Reuse historical proposal, voice-turn, plan, support and reminder timestamps rather than creating duplicate events.
6. Build a responsive Log view: search, category, patient-local date range, timestamp, event, source, state and expandable safe details; explicit Load older activity and Refresh controls. Reset/abort requests on identity/filter changes and clear stale results on access errors. Public UI preview uses only its existing fictional in-memory data and makes no backend requests.
7. Verify backend visibility, deletion/revocation, pagination, timestamps, history and filters; frontend navigation, Care routing, Log loading/error/filter/reset behavior and preview isolation. Run backend/frontend suites, production build and desktop/mobile browser checks through owner and caregiver flows.

## Validation and handoff

Use the existing local demo at 127.0.0.1:5173 for a reversible fictional browser walkthrough. Restart its backend to load the new endpoint while preserving its database. Browser QA will use regular Playwright because the Browser plugin/skill is absent in this session; use the project's existing tools dependency. Compare the final UI with the supplied screenshot's visual style. Capture QA images outside committed source. Document the Log contract, history coverage and remaining limitations in the frontend/backend guides.

Raw input audio remains subject to existing deletion policy. This work adds access to stored activity, not continuous recording, long-term audio storage, a hidden full transcript archive, or a claim that pre-existing missing audit events can be reconstructed.

## Completed implementation and verification

All seven implementation steps are complete. The Log merges retained evidence in SQL, adds generic audit writes for previously missing administrative changes, preserves successive new support outcomes, and requires current record permissions before pagination. Closed unconfirmed drafts retain generic receipts so a superseded draft cannot bypass deletion or removed sharing. No migration or new dependency was needed.

The user's additional click-outline request is complete: pointer interaction suppresses the dashboard outline while Tab navigation retains a visible focus ring. A rapid demo restart exposed a TIME_WAIT false positive in the launcher's port probe; the probe now permits reuse of closed sockets while retaining active-listener checks.

Validation:

- `npm --prefix frontend run build`: production build passed.
- `npm --prefix frontend test -- --run`: 142 tests across 26 files passed.
- Backend `pytest -o addopts='' -q`: 241 tests passed. Three existing summary fixtures now use a date range around the current patient-local day rather than a stale October 1–3 range.
- `backend/.venv/bin/python tools/postgres_test.py -- tests/test_activity_log.py -q`: all 10 Log tests passed against a disposable PostgreSQL database, including JSON membership, cursor stability, current permissions, deletion/revision, literal search and date boundaries.
- Ten updated/shared browser helpers passed JavaScript syntax checks; `git diff --check` passed.
- Chrome through regular Playwright (Browser plugin not available), isolated fictional fixture at `http://127.0.0.1:5190/`: desktop 1440×1000, mobile 390×844 and 320×844 passed. The actual demo remains at `http://127.0.0.1:5173/` with its saved records preserved.

Browser flow: owner sign-in → Today/five primary tabs → secondary Check records/summary/Care/Settings actions → proposed note and explicit confirmation → Log older-page loading, search, category/date filters, empty state and details → pointer click/keyboard focus → caregiver private/shared/unshared visibility → care-space switching → mobile navigation. Page URL/title, meaningful content and absence of a framework overlay were checked. No app exceptions or relevant console errors occurred; the initial unauthenticated session check returned the expected 401 before sign-in.

Reference comparison: the original screenshot's logo, ivory/aqua/lilac palette, navy headings and card styling are retained. Eight top-level tabs became five; zero-only statistics and empty support/task cards were intentionally removed, and readings/device status collapsed. Log uses an unboxed list to keep the detailed view quiet. Desktop/mobile and clicked-search screenshots are saved outside source under `/tmp/parse-dashboard-qa/`.

Remaining limits: Safari/Firefox and live voice-provider/physical companion behavior were not exercised by this UI change. Historical events without retained evidence cannot be reconstructed; recording receipts and reminder playback do not imply confirmed care or a taken dose. Coverage and retention are documented in `docs/careloop/Activity-Log.md` and `backend/API.md`.

## Follow-up: separate Connect and Connected status

The requested follow-up moves companion pairing, diagnostics and reminder selection into a dedicated connection view opened by a header button, while the Settings gear retains preferences, reviewed names and sharing. The button derives its state from the selected companion: Connect, Waiting for connection, Connected, Offline, or Status unavailable if a dashboard refresh fails. It never treats another online device, revoked access, missing patient data or fictional preview data as the selected live connection. Clicking Connected opens the same connection view; a return control restores the previous care screen. Mobile places this status on a compact companion row below the existing header controls.

Browser verification found that the browser companion did not previously send presence. The existing secure web forwarder now permits PUT /presence to the existing phone handler. The companion reports foreground every five seconds while visible and background when hidden, querying microphone permission without requesting it or recording. Native phone and cardholder transports are retained. No new database schema or dependency was added. Connection setup initializes to the selected companion type when reopened.

Validation: frontend build passed; 149 frontend tests passed, including selected-device states, revoked/stale/preview handling, separated navigation, caregiver restrictions, and foreground/background reports. The complete backend suite passed all 242 tests, including all seven web-companion tests covering approval, Origin/CSRF, no-store, presence expiry and revocation. A local Chrome walkthrough with a separate fictional browser installation verified Connect → Waiting for connection → Connected from actual browser presence → Offline after closing the companion → Connect after revocation, owner/caregiver controls, return navigation and 1440/390/320px layouts. No app exceptions or framework overlay occurred. Screenshots are outside source under /tmp/parse-connect-qa/. Companion setup guides and seven browser helpers were updated and checked for syntax. The ordinary demo was restarted with saved records preserved. Physical companions, cloud speech and other browsers remain unverified by this follow-up.
