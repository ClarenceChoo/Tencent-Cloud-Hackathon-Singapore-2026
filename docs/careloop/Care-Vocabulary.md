# Reviewed care names

A person with `manage:profile` access can review up to 100 names in a patient's care space. Each name has a category (`medicine`, `person`, or `other`) and up to five alternative spellings. Names and alternatives are limited to 80 characters each. The server trims and Unicode-normalizes them for duplicate checks and rejects any spelling that could refer to more than one reviewed name. Display spelling is retained.

The settings page offers names from the current active, checked medicine plan and from currently permitted people. These are suggestions only. They do not enter the reviewed vocabulary until someone adds and explicitly saves them. Private notes are never used to generate suggestions.

Each save includes the version the editor loaded. A concurrent save returns HTTP 409. The editor retrieves the latest saved version for comparison while retaining the unsaved entries in page memory; a patient switch or sign-out clears that draft. It never writes care names to browser storage. The server records every reviewed version with the reviewer and time, and voice turns record the version selected for processing.

Reviewed names can provide advisory context to the interpretation step. They cannot rewrite a speech transcript, prove a medicine was taken, select an uncertain medicine or quantity, or decide whether a statement included a negation. Material ambiguity must still be clarified with the person before a care record is confirmed.

Custom ASR vocabulary is currently unavailable. The Tencent SentenceRecognition API documents temporary hotword fields, but the currently configured English engine and account have no verified acceptance evidence. Normal speech recognition continues. The provider capability response reports `asr_vocabulary_supported: false` and `asr_vocabulary_applied: false`; see [provider evidence](PROVIDERS.md). A future release can enable a provider-specific hint only after its request format, account access, language and engine behavior, and material-error impact have been checked.

## Fictional evaluation set

This set is for intercepted requests and exact text checks. It has no real patient names or live audio. The current configured engine is `16k_en`, so this set uses English. It should be extended for a language only after that engine and account are verified. The expected outcome with ASR hints disabled is an unchanged provider transcript for every case; no recognition improvement is claimed.

| Fictional spoken fact | Risk to check | Expected handling |
| --- | --- | --- |
| “I took Fictional Med A.” / “I took Fictional Med B.” | Similar medicine names | Do not replace one name with the other; clarify if the medicine cannot be identified. |
| “I took one tablet.” / “I took two tablets.” | Quantity | Preserve the number; clarify a mismatch with the checked plan. |
| “I did not take Fictional Med A.” / “I took Fictional Med A.” | Negation | Preserve the negation; do not report taken from an unclear phrase. |
| “Ask Fictional Mae.” / “Ask Fictional May.” | Similar person names | Clarify the recipient before sharing. |

The comparison measure is exact material-term errors and harmful substitutions, counted separately for medicine, person, quantity, and negation. Intercepted tests can prove that vocabulary fields are absent and returned text stays unchanged; they cannot measure live recognition accuracy. No live calls have been made for this evaluation.

The API has a patient-scoped `GET` and `PUT /v1/app/patients/{patient_id}/vocabulary`, plus `GET /v1/app/patients/{patient_id}/vocabulary/suggestions`. They require `manage:profile`; PUT also requires the browser CSRF token. The PUT body is `{ "expected_version": 0, "terms": [{ "canonical": "…", "aliases": [], "category": "medicine" }] }`. The initial reviewed version is 0.
