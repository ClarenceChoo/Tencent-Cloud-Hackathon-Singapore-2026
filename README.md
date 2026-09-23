# CareLoop — Tencent Cloud Hackathon Singapore 2026

CareLoop is a voice companion for older adults, built into the back of a 3D-printed transit/ID cardholder. The ESP32-S3 handles push-to-talk and playback; a FastAPI backend handles confirmed care records and speech-provider adapters; a responsive React dashboard supports the owner and permitted caregivers.

The current delivery milestone is **software first**: a working dashboard, backend and device API using fictional development data. You can create checked medication plans, confirm care notes and reported readings, manage preventive tasks and support follow-ups, and review/share visit summaries before hardware arrives. Live speech requires provider credentials; assembled-cardholder validation belongs to the later integration stage. See [verification status](docs/careloop/VERIFICATION.md) for the evidence and remaining checks.

## Start the software demo

Install dependencies once with `uv sync --frozen --extra test` inside `backend/` and `npm ci` inside `frontend/`. Then run this from the repository root:

```sh
python3 tools/run_demo.py
```

Open **http://127.0.0.1:5173**. Sign in as `owner@careloop.invalid` with password `fictional-demo-only`. The caregiver account is `caregiver@careloop.invalid` / `fictional-caregiver-only`.

The launcher starts both services, seeds fictional accounts, keeps demo records in the ignored `runtime/software-demo/` directory, and preserves them between runs. It uses backend port 8001 and dashboard port 5173; change these with `--api-port` and `--web-port` if occupied. Ctrl+C stops the demo. Existing databases, environment files and other running services are left untouched. Voice providers are explicitly unconfigured in this local demo; the device API remains available for development.

## Run the software locally

Use Python 3.11 or later, `uv`, and Node.js 22 or later. In one terminal:

```sh
cd backend
uv sync --frozen --extra test
cp .env.example .env
CARELOOP_DEVELOPMENT_SEED=true uv run python -m app.seed
uv run uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000 --no-access-log
```

The seed explicitly creates fictional accounts: `owner@careloop.invalid` / `fictional-demo-only`, and `caregiver@careloop.invalid` / `fictional-caregiver-only`. It also prints a one-time claim code and a unique device credential; keep the credential outside source control. The seed never runs automatically.

In another terminal:

```sh
cd frontend
npm ci
VITE_DEMO_MODE=true npm run dev
```

Open the loopback address printed by Vite. Keep the exact dashboard origin in `backend/.env` under `CARELOOP_ALLOWED_ORIGINS`; `localhost` and `127.0.0.1` are distinct origins. Vite normally proxies `/v1` to `http://127.0.0.1:8000`; set `CARELOOP_API_TARGET` when using a different backend port.

The dashboard works without provider credentials. Voice processing then returns an explicit unavailable result. To enable real speech, configure the [provider environment](docs/careloop/PROVIDERS.md), then restart the backend. The browser never records microphone audio.

## Build and verify

```sh
cd backend
uv run pytest
```

```sh
cd frontend
npm run build
npm test
```

Firmware requires ESP-IDF **v5.4.2** and the supplier's actual board configuration. Follow [firmware setup, build and USB flashing](firmware/README.md); default pins are deliberately unassigned. Pure host logic tests run with `make -C firmware/components/careloop_core/test test` from the repository root.

[Developer tools](tools/README.md) provide a resumable WAV transport harness and real-browser scenario checks. They are not substitutes for the physical pendant acceptance tests.

## Project documents

- [Product requirements document](docs/careloop/CareLoop-PRD.md): MVP scope, user journeys, requirements, acceptance criteria, and delivery plan.
- [Hardware–software integration guide](docs/careloop/Hardware-Software-Integration.md): hardware interfaces, firmware responsibilities, audio transport, backend APIs, and build sequence.
- [Chinese hardware supplier checklist](docs/careloop/Supplier-Handoff-Checklist-ZH.md): prototype scope, component requirements, testing, and supplier handoff.
- [Implemented API contract](backend/API.md): dashboard sessions, proposals, device endpoints and permissions.
- [Deployment instructions](deploy/README.md): HTTPS proxy, PostgreSQL, application containers and explicit provisioning.
- [Verification status](docs/careloop/VERIFICATION.md): tested behavior and unverified acceptance requirements.

## Connection plan

The pendant runs device firmware and exchanges audio and commands with a Tencent-hosted backend over Wi-Fi. The phone and caregiver dashboards access the same backend. Speech recognition, AI, and speech synthesis run through backend services.

The prototype uses the ESP32-S3 pendant from the start. There is no phone-based voice prototype. The phone remains a dashboard and optional Wi-Fi hotspot; it does not replace the pendant. Backend work can proceed with developer test fixtures while hardware is assembled.

The hardware supplier assembles and tests the pendant. The project team develops the firmware, backend, and dashboards.

## Repository layout

`firmware/` contains ESP-IDF code, `backend/` contains FastAPI and its tests, `frontend/` contains the dashboard, `tools/` contains developer checks, and `deploy/` contains deployment configuration. Credentials, databases, build output and local test artifacts are ignored by Git.
