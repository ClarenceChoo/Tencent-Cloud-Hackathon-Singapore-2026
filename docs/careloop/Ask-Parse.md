# Ask Parse: bounded care-record questions

Ask Parse is available in the signed-in dashboard for the selected care space. It offers three fixed questions:

1. **Latest reported blood-pressure reading.** This is the newest confirmed, current reading by the time it was recorded. The separately reported occurrence time may be unknown. A corrected reading replaces its earlier version in this answer.
2. **Open support requests.** This shows requests that have not been resolved, with their recorded status. A caregiver sees only requests addressed to them.
3. **Medication reports for a selected date.** The date is when doses were scheduled in the patient's current timezone. Each dose shows its confirmed report history. “Unreported” means there is no confirmed report; it does not mean taken, skipped, or missed.

The dashboard checks the viewer's current patient grant and category permission for each question. A category without permission returns a distinct access-denied message. An authorized question with no matching records has its own empty message. Ask Parse shows at most 50 permitted rows and labels an incomplete list when more exist; it does not claim a hidden or estimated total. Historical medication dates are searched directly, including dates older than the dashboard's recent-dose list. Patient-local day boundaries account for daylight-saving changes.

Each result includes a **View source** action. Opening it fetches the current source with patient, category, and individual-record access checked again. A corrected reading, removed access, or a source in another care space cannot be opened through an old result. The page clears results when the patient or session changes and ignores late replies from previous requests. Answers and source details remain in memory only; the feature stores no question history, creates no care records or acknowledgements, and sends no care content to an external model.
