# CareLoop backend

FastAPI service for the CareLoop dashboard and ESP32 pendant. It uses SQLAlchemy with SQLite for local development and PostgreSQL in deployment. The application enforces human session/CSRF controls, scoped patient grants, device credentials, immutable confirmation proposals, reminder delivery ledgers, and expiring reviewed summary links.

## Local setup

```bash
cd backend
uv sync --extra test
cp .env.example .env
CARELOOP_DEVELOPMENT_SEED=true uv run python -m app.seed
uv run uvicorn app.main:app --reload --env-file .env
```

The seed is explicitly opt-in and visibly fictional. It prints a one-time device credential and short-lived claim code. Re-running it never rotates or redisplays an existing credential. Do not use seed accounts for real people.

OpenAPI is at `http://127.0.0.1:8000/docs`; the frontend/device contract and examples are in [API.md](API.md).

## Configuration

- `CARELOOP_DATABASE_URL`: `sqlite:///./careloop.db` locally or a `postgresql+psycopg://...` deployment URL.
- `CARELOOP_ALLOWED_ORIGINS`: comma-separated exact browser origins.
- `CARELOOP_COOKIE_SECURE`: keep `true` behind production HTTPS.
- `CARELOOP_PROVIDER`: provider adapter selected by `app/providers.py`; no implicit live fallback.
- `CARELOOP_PUBLIC_BASE_URL`: the public HTTPS origin displayed in device setup; no path, credentials or query string.
- `CARELOOP_DEVELOPMENT_SEED`: must be `true` only while creating fictional local fixtures.

Provider failures are reported as unavailable; the service does not label tones or fixture audio as live speech. Raw uploaded audio is removed after transcription or terminal processing failure, with abandoned input cleaned within the configured maximum.

Run Uvicorn with `--env-file .env` when provider settings are stored there. The application settings reader loads `.env` for database/web configuration, while the provider adapter deliberately reads its credentials from the process environment.

## Deployment provisioning

No production account is created by default. Provision through the explicit, normally disabled CLI and turn the flag off again after use:

```bash
CARELOOP_ADMIN_ENABLED=true CARELOOP_NEW_USER_PASSWORD='replace-with-a-long-secret' \
  uv run python -m app.admin create-user --email owner@example.org --name 'Owner name' --role owner
CARELOOP_ADMIN_ENABLED=true uv run python -m app.admin create-patient \
  --name 'Patient name' --timezone Asia/Singapore --owner-email owner@example.org
CARELOOP_ADMIN_ENABLED=true uv run python -m app.admin provision-device --claim-minutes 60
```

The legacy `provision-device` command prints the credential once. Prefer the private setup-pack workflow for a physical pendant:

```sh
CARELOOP_ADMIN_ENABLED=true uv run python -m app.admin prepare-device \
  --backend-url https://YOUR-ACTUAL-DOMAIN --output-dir /PRIVATE/NEW/pendant-001
CARELOOP_ADMIN_ENABLED=true uv run python -m app.admin renew-claim --device-id DEVICE-ID
```

`prepare-device` writes per-unit NVS input and an owner setup sheet into a new private directory without printing the credential. `renew-claim` replaces the code only for an unclaimed, unrevoked unit, preserving its flashed credential. Run both against the same database used by the deployed API. Follow the [hardware pairing runbook](../docs/careloop/Hardware-Pairing-Runbook.md) for generation, flashing and acceptance.

## Tests

```bash
uv run pytest
```

These tests cover software state, authorization and protocol integrity. They do not establish hardware audio quality, battery life, GPIO correctness, physical wearability, clinical benefit, or availability of external provider accounts.

To opt into the same suite on a locally installed PostgreSQL server binary without using or resetting an existing database, run from the repository root:

```bash
backend/.venv/bin/python tools/postgres_test.py
```

The runner initializes a disposable cluster below the ignored `runtime/` directory, binds it only to `127.0.0.1` on an unused high port, creates a random database, and stops and removes that cluster after the suite. Within the run, every database-backed test creates and later drops its own randomly named schema. `CARELOOP_TEST_DATABASE_URL` can also point the tests at an explicitly provisioned PostgreSQL database with schema-create permission; the fixtures never reset that database or use its existing schemas.
