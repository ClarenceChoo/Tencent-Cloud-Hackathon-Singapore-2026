# October care-workflow verification evidence

These files contain fictional data only. They are selected outputs from actual local Chrome checks on 2 October 2026, rather than screenshots of a connected patient account.

- `browser-workflows.json`: **28/28 complete checks passed** against a disposable same-origin FastAPI/SQLite fixture with real MediaRecorder/decoder bytes, synthetic microphone input, scripted ASR/interpretation and tone replies. It records the parent Git revision and the tested source and startup-snapshotted frontend hashes. The fixture ended with caregiver access and browser pairing revoked.
- `public-preview.json`: **8/8 checks passed**, including 320/390/1440px layouts and actual 200% text on the inert companion preview. No `/v1`, microphone, media or print calls occurred; storage and page errors were empty. This run used the final preview build after its informational companion card's wrapping/padding fix. That preview-only CSS adjustment followed the complete care-flow run, so their CSS hashes intentionally differ.
- `summary-320.png`: reviewed summary controls with long source references and ten long authored questions at 320px.
- `fictional-weekly-summary.pdf`: the actual three-page browser print output. All three pages were rendered and visually inspected. `printed-summary-page-1.png` is a selected rendered page.
- `preview-dashboard-1440.png` and `preview-companion-200-percent-320.png`: selected light-theme preview screenshots.
- `artifact-sha256.json`: hashes of the copied reports and selected visual artifacts.

The reports list the complete runtime screenshot set; only the selected files above are committed here. Private fixture setup files, databases, cookies, credentials, recorded audio and native binaries remain in ignored runtime directories. Reproduction commands are in [tools/README.md](../../../../tools/README.md), and software suite results and remaining acceptance work are in [VERIFICATION.md](../../VERIFICATION.md).

These runs do not verify live Tencent speech, physical-phone audio/storage, closed-browser alerts, deployment, clinical accuracy or intended-user acceptance. The Android offline-vault probe compiled separately but was not installed or run. [Issue #15's physical G1 gate remains unpassed](../../../adr/2026-10-02-native-offline-capture.md); offline capture is disabled.
