# Deployment on a Tencent Cloud host

The compose configuration runs PostgreSQL, one FastAPI process with its durable database-backed scheduler, and Caddy serving the built dashboard and proxying the API/WSS. Only Caddy exposes ports 80/443. Hosting, domain ownership, account/region availability and paid API access must be provided by the project team.

## Configuration

1. Provision a Linux host with Docker Engine and Compose, attach a domain, and point its DNS to the host. Allow inbound TCP 80/443 for HTTPS and certificate issuance. Keep PostgreSQL and port 8000 private.
2. Copy `deploy/.env.example` to `deploy/.env`. Replace the example domain and database password. The password is interpolated into a database URL: use a long random URL-safe value, such as random hex, rather than punctuation needing URL encoding.
3. Configure [speech/AI providers](../docs/careloop/PROVIDERS.md). `unconfigured` is an honest dashboard-only development state; it cannot run the voice demonstration. Never install Tencent/LLM account credentials on the wearable.
4. From the repository root:

```sh
docker compose --env-file deploy/.env config --quiet
docker compose --env-file deploy/.env up --build -d
```

Caddy obtains the certificate for the configured real domain. The dashboard and API share an origin, Secure cookies stay enabled, and WebSocket upgrades are proxied automatically. The wearable connects to the same HTTPS hostname and validates certificates.

## Explicit account and device provisioning

The deployment creates no default user, patient or device. Use the administrator CLI described in [backend setup](../backend/README.md). Run it inside the backend container with `CARELOOP_ADMIN_ENABLED=true` for that command. Pass the new user's password through `CARELOOP_NEW_USER_PASSWORD` in the environment, not a committed file or command argument. For example, after setting that environment variable securely:

```sh
docker compose --env-file deploy/.env exec \
  -e CARELOOP_ADMIN_ENABLED=true -e CARELOOP_NEW_USER_PASSWORD \
  backend python -m app.admin create-user \
  --email owner@example.com --name 'Demo owner' --role owner
```

Replace the illustrative address and name. Create the patient, assign its owner, then provision a device. The device credential is shown once. Put it in the device's private NVS provisioning file; give the owner only its short-lived claim code. Keep development seed accounts out of this deployment.

## Deployment checks

- `/healthz` responds over the actual HTTPS domain and the browser completes login, proposal and confirmation through the proxy.
- An unclaimed/revoked device is rejected; a claimed device can upload a WAV and connect to WSS with its own Bearer credential.
- A live synthetic sentence passes the configured ASR, interpreter and TTS providers. Confirm the resulting WAV is intelligible on the assembled device.
- Restart the backend during a turn/reminder and reconcile the durable state without duplicate care records or replaying expired commands.
- Verify the target phone/hotspot, latency, audio and power measurements specified by the PRD.

This configuration is a single-instance prototype. Additional backend replicas require shared socket routing and a scheduler coordination design. The current schema bootstrap creates new tables; it is not a migration system for later schema changes. Use disposable fictional data during development; plan migrations and backups before retaining real records.

`requirements.lock` is exported from `backend/uv.lock` and installed with hashes. Regenerate it after a dependency change using `uv export --frozen --no-dev --no-emit-project --format requirements-txt --output-file ../deploy/requirements.lock` from `backend/`. Frontend dependencies use `npm ci` and the checked-in lockfile.

Container build/start and the public TLS deployment have not been executed in the current workspace because Docker and the deployment account/domain are unavailable. The backend suite passes against an isolated local PostgreSQL 15.14 cluster; the PostgreSQL 17 deployment image itself remains untested. Local app and firmware checks are recorded separately in the verification document.
