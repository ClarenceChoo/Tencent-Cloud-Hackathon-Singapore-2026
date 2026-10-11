# Run Parse locally

[Documentation index](../README.md) · [Project overview](../../README.md)

Choose the browser fixture to exercise recording, pairing and confirmation with scripted speech, or the dashboard launcher to explore existing fictional care records. Both run locally without cloud credentials. Live speech uses the separate HTTPS deployment path below.

## Browser and dashboard requirements

- Python 3.11 or newer, with `uv`
- Node.js 22 or newer, with `npm`
- FFmpeg and FFprobe on `PATH` for audio normalization

Clone the repository and install the dependencies from its root:

```sh
git clone https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026.git
cd Tencent-Cloud-Hackathon-Singapore-2026
cd backend
uv sync --frozen --extra test
cd ../frontend
npm ci
npm run build
cd ..
```

## Try the browser flow locally

Use the loopback fixture for a safe, repeatable browser demonstration. It binds to `127.0.0.1`, creates a new fictional database under the ignored `runtime/` directory, and refuses to reuse an existing fixture directory.

```sh
backend/.venv/bin/python tools/web_companion_fixture.py \
  --data-dir runtime/web-companion --port 5190
```

Open [http://127.0.0.1:5190/companion](http://127.0.0.1:5190/companion) in a browser. The dashboard is at [http://127.0.0.1:5190/](http://127.0.0.1:5190/). To try the paired flow:

1. On the companion, select **Connect this browser** and keep the one-use code visible.
2. In the dashboard, sign in as `owner@web.invalid` with password `fictional-web-only`.
3. Open **Connect**, choose **Parse browser** as the companion type, enter the code, and select **Approve browser**.
4. Return to `/companion` and select **Check connection**.
5. The caregiver demo account is `caregiver@web.invalid`, also with password `fictional-web-only`.
6. For the guided setup, select the paired browser under **Connect → Reminder companion**, refresh the companion, and follow its speaker and microphone checks. Its static example sends no audio. The automated runner supplies the scripted first update and checks it through the caregiver's separate account.

These loopback URLs work on the computer running the fixture. To use a separate physical phone, follow the HTTPS deployment setup below. Use separate browser profiles or a private window if you want owner and caregiver dashboards open at the same time.

Both accounts and all fixture records are fictional and local to this demonstration. The fixture has no live speech recognition: a recording needs an explicitly armed scripted utterance to produce a transcript. A manual recording by itself will not be transcribed. The automated browser check and demo recorder arm these scenarios explicitly; replies are tones.

To run the automated Chrome scenario checks, install the locked Playwright dependency and start with a fresh fixture directory (the check revokes its browser pairing when it finishes):

```sh
npm ci --prefix tools
PARSE_WEB_FIXTURE_DIR=runtime/web-companion \
  node tools/browser_web_companion.cjs
```

Google Chrome must be installed for this runner. It uses synthetic microphone input. It checks real browser recording and upload through the audio decoder and care flow, while transcript/interpretation remain scripted. It does not test live ASR, a physical phone microphone, clinical effectiveness, or closed-browser alerts.

## Use a live, deployed companion

For live speech, deploy the dashboard and backend on the same HTTPS origin, configure speech/AI providers, and provision the owner account, patient care space and appropriate caregiver access. The `/v1/web` companion API rejects non-HTTPS requests outside testing; use the loopback fixture above for local browser-flow work. The fixture's scripted provider and fictional accounts must never be deployed.

1. Follow [deployment setup](../../deploy/README.md) to configure the host, domain, HTTPS proxy, database, and application.
2. Configure the [speech and AI providers](PROVIDERS.md), then follow the deployment guide's explicit account provisioning steps.
3. Open the deployed dashboard and `/companion` on the same HTTPS hostname. On the companion choose **Connect this browser**; in owner **Connect**, choose **Parse browser**, enter the one-use code, and **Approve browser**.
4. Return to the companion and check the connection. Grant microphone permission when prompted.

Browser pairing does not require pendant firmware or a hardware provisioning pack. Browser recording works only while its page is open and active. It does not provide background or closed-browser alerts. Browser support and security details are in the [web companion guide](Web-Companion.md).

## Dashboard-only local demo

The standard `tools/run_demo.py` launcher is for the local dashboard walkthrough at port 5173. It starts with `CARELOOP_PROVIDER=unconfigured`, `CARELOOP_TESTING=false`, and no provider credentials. It does not start the browser-companion fixture or provide live speech. Use the separate local fixture instructions above to exercise `/companion` without provider setup.

After installing the dependencies, run from the repository root:

```sh
python3 tools/run_demo.py
```

Open `http://127.0.0.1:5173/`. The fictional owner login is `owner@careloop.invalid` / `fictional-demo-only`; the caregiver login is `caregiver@careloop.invalid` / `fictional-caregiver-only`. This launcher preserves its demo records under `runtime/software-demo/`. Stop it with Ctrl+C.

## Run the checks

From the repository root:

```sh
(cd backend && uv run pytest)
npm --prefix frontend test
npm --prefix frontend run build
```

The Chrome scenario command above needs a running fresh web fixture. The [developer tools guide](../../tools/README.md) covers other fixtures and checks.

## Evidence and other clients

Recorded test results and their dates are in [verification status](VERIFICATION.md). The commands above are reproducible checks, not a claim that tests have been rerun on your machine.

For the ESP32-S3, use the [firmware guide](../../firmware/README.md) and [hardware pairing runbook](Hardware-Pairing-Runbook.md). The [9 October hardware handover](Hardware-Handover-2026-10-09.md) records the latest bench results. For the installed phone app, use the [native companion setup](Phone-Companion-Setup.md).
