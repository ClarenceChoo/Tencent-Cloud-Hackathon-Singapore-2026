# Deploy the CareLoop backend and connect Vercel

This walkthrough puts the API, PostgreSQL database, and dashboard proxy on a Tencent Cloud VM. Vercel hosts the protected frontend; it does not host this backend or its database. The Compose setup runs one FastAPI process with its durable scheduler, PostgreSQL, and Caddy. Only Caddy publishes ports 80 and 443; the backend and database stay private.

You will need a Tencent Cloud account, permission to create a CVM and configure its firewall, a domain you control, and this repository's clone URL. Purchases and account setup are performed by you. These steps use Bash on the Linux server; make sure the account you SSH with can run Docker commands after installation, or use the server console as root. Do not continue until that permission is established.

## 1. Create the server and DNS record

In Tencent Cloud, create a CVM using [Tencent CVM setup guidance](https://www.tencentcloud.com/document/product/1098/52632). For a first test, choose **Ubuntu 24.04 LTS in Singapore**, **2 vCPU and 4 GB RAM**, a **public IPv4 address**, and an **SSH key**. These are starting choices for a small test deployment, not a capacity guarantee. Save the public IP and keep the private SSH key secure.

Create a custom security group following [Tencent security group guidance](https://www.tencentcloud.com/document/product/215/35506). Allow inbound TCP 22 only from your current public IP, and TCP 80 and 443 from the public internet. Do not add public rules for TCP 8000 or 5432. Attach the group to the VM.

If you do not own a domain yet, register one with a domain registrar of your choice. The registrar normally gives you a page for managing DNS records. Add an `A` record named `api` pointing to the CVM public IPv4 address. For example, if your domain is `yourdomain.tld`, the backend hostname is `api.yourdomain.tld`. Use your own domain; the example hostname is not provisioned for you. Wait until DNS resolves to the server before starting Caddy so it can issue an HTTPS certificate. The existing Vercel frontend address does not need a new domain.

## 2. Install Docker and get the code

SSH to the server using its public IP and your key. Install Docker Engine and its Compose plugin by following Docker's official [Ubuntu installation instructions](https://docs.docker.com/engine/install/ubuntu/), including the post-install steps needed for your chosen login account to run `docker` without permission errors. The application commands below assume you are in Bash on the server and can run `docker compose` successfully.

Install Git, OpenSSL and a text editor if the server image does not include them:

```bash
sudo apt update
sudo apt install -y git openssl nano
```

Clone this repository, then enter the checkout:

```bash
git clone https://github.com/ClarenceChoo/Tencent-Cloud-Hackathon-Singapore-2026.git careloop
cd careloop
```

Copy the deployment example, restrict access to the filled-in file, generate a long random URL-safe database password, then edit the file. The random command prints a value once so you can paste it into the password field; do not share or commit it.

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
openssl rand -hex 32
nano deploy/.env
```

Set the following values in `deploy/.env`, replacing the example backend hostname with the DNS name you own and the password with the generated hex value:

```dotenv
CARELOOP_DOMAIN=api.yourdomain.tld
CARELOOP_ALLOWED_ORIGINS=https://api.yourdomain.tld,https://parse-careloop-preview.vercel.app
POSTGRES_PASSWORD=paste-your-generated-random-hex-value-here
CARELOOP_PROVIDER=unconfigured
```

Keep `CARELOOP_DEVELOPMENT_SEED=false` and `CARELOOP_COOKIE_SECURE=true` as configured by Compose. Leave provider credentials empty for the initial dashboard login test. `unconfigured` supports the dashboard but not voice. Voice requires a separately configured provider; see [provider setup](../docs/careloop/PROVIDERS.md). Never put database, Tencent, or LLM secrets in `VITE_*` variables or on the wearable. Keep `deploy/.env` private and out of Git.

## 3. Start the backend and check HTTPS

From the repository root on the server, validate Compose configuration, then build and start the services:

```bash
docker compose --env-file deploy/.env config --quiet
docker compose --env-file deploy/.env up --build -d
docker compose --env-file deploy/.env ps
```

Caddy serves the built dashboard and proxies API and WebSocket traffic. It obtains HTTPS certificates automatically when the domain resolves to this server and ports 80/443 are reachable. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https). Check the public health endpoint:

```bash
curl -i https://api.yourdomain.tld/healthz
```

The successful response is `200` with `{"status":"ok"}`. For service logs, use `docker compose --env-file deploy/.env logs --tail=100 web backend db`; avoid sharing logs if they contain private information.

## 4. Connect the protected Vercel frontend

The browser frontend origin and backend hostname are different addresses. For this protected test project, use the stable authenticated frontend URL `https://parse-careloop-preview.vercel.app`; deployment-specific Vercel URLs can change after a configuration change and redeploy. The `CARELOOP_ALLOWED_ORIGINS` value above lists both that exact frontend origin and the backend origin. Keep the project’s **Deployment Protection → Vercel Authentication → All deployments** protection enabled so every URL requires authentication.

Open the Vercel project **`parse-careloop-preview`**, select its **Environment Variables** settings, and add `BACKEND_URL` with value `https://api.yourdomain.tld` for **Production**. Save it, then deploy to Production to update the stable address above. This is the dedicated test project; keep All Deployments protection enabled. Environment changes apply only to a new deployment. `BACKEND_URL` must be the backend's public HTTPS origin without a path, and is a server-side routing setting rather than a credential. The frontend continues to call same-origin `/v1` paths, which Vercel forwards to the backend. See [Vercel's environment variable instructions](https://vercel.com/docs/environment-variables/managing-environment-variables) and [the repository's Vercel deployment guide](./VERCEL.md).

If you also want to use a deployment-specific Preview URL, set `BACKEND_URL` for Preview and deploy again. Add that new deployment's exact HTTPS origin to `CARELOOP_ALLOWED_ORIGINS` as well; the stable frontend origin alone does not permit login from a different preview hostname. Earlier deployment-specific URLs keep their original configuration. Use the stable protected address for the initial test.

If you change `CARELOOP_ALLOWED_ORIGINS`, recreate the backend so it receives the new setting:

```bash
docker compose --env-file deploy/.env up -d --force-recreate backend
```

Then check `https://parse-careloop-preview.vercel.app/healthz` in a browser signed in to the Vercel account with access to this project. After completing step 5, try the app login. The protected Vercel gate controls who can open the site; the CareLoop login below controls the app account. No account or patient is created automatically.

## 5. Create an owner and patient

Provisioning is an explicit one-time operation against the deployed database. The commands below keep admin mode enabled only for each CLI process. Enter the owner's password at the hidden prompt; it is passed to the container through a temporary environment variable, not as a command-line password argument.

```bash
printf 'New owner password: '
read -r -s CARELOOP_NEW_USER_PASSWORD
printf '\n'
export CARELOOP_NEW_USER_PASSWORD
docker compose --env-file deploy/.env exec \
  -e CARELOOP_ADMIN_ENABLED=true -e CARELOOP_NEW_USER_PASSWORD \
  backend python -m app.admin create-user \
  --email owner@example.com --name 'Demo owner' --role owner
unset CARELOOP_NEW_USER_PASSWORD

docker compose --env-file deploy/.env exec \
  -e CARELOOP_ADMIN_ENABLED=true backend python -m app.admin create-patient \
  --name 'Demo patient' --timezone Asia/Singapore --owner-email owner@example.com
```

Replace the example email/name and patient details. Choose a password of at least 12 characters. The patient command creates the patient and grants the active owner access. The CLI prints generated IDs; record the ones you need. For device pairing, use `prepare-device` to create a private per-unit setup pack, then follow the [hardware pairing runbook](../docs/careloop/Hardware-Pairing-Runbook.md). Keep the owner's setup sheet and device credential private. See [backend setup](../backend/README.md) for all CLI options. Do not use development seed accounts with real data.

## 6. Verify and maintain the deployment

Check `/healthz` over the backend domain and through the protected Vercel URL, then log in with the owner account. With a configured voice provider, also verify a synthetic voice request and device pairing as described in the deployment checks below. With the provider left `unconfigured`, the dashboard can be checked but voice is unavailable.

For a database backup, write a PostgreSQL custom-format dump to a private file on the server and copy it to storage you control. Treat the dump as sensitive care data; encrypt and restrict access to it. For example:

```bash
umask 077
docker compose --env-file deploy/.env exec -T db \
  pg_dump -U careloop -d careloop -Fc > careloop-$(date +%F).dump
```

Keep a copy off the VM and periodically verify your recovery procedure using a separate test database. This is a single-instance prototype: additional backend replicas need shared socket routing and scheduler coordination. Database upgrades use [transactional Alembic migrations](../backend/app/migrate.py); test upgrades and restore procedures against a separate database, and plan encrypted backups before retaining real records.

## Deployment checks

- `/healthz` responds over the actual HTTPS domain and the browser completes login, proposal and confirmation through the proxy.
- An unclaimed/revoked device is rejected; a claimed device can upload a WAV and connect to WSS with its own Bearer credential.
- Run `tools/check_hardware_ready.py` with the claimed unit's private NVS file against the actual HTTPS domain. It checks TLS, protocol, reconciliation and WSS; provider configuration and physical operation are reported separately.
- A live synthetic sentence passes the configured ASR, interpreter and TTS providers. Confirm the resulting WAV is intelligible on the assembled device.
- Restart the backend during a turn/reminder and reconcile the durable state without duplicate care records or replaying expired commands.
- Verify the target phone/hotspot, latency, audio and power measurements specified by the PRD.

For errors, first confirm `api.yourdomain.tld` resolves to the CVM public IP, the security group allows 80/443, and Caddy/backend are running. A `503` on Vercel `/healthz` indicates that the deployment has no configured backend route; check `BACKEND_URL` in the environment used for that deployment, then redeploy. If Vercel has the route but cannot reach it, check backend DNS, firewall, and `/healthz` directly. A `403` response saying “Origin is not allowed” means the exact frontend origin (scheme and hostname) is missing from `CARELOOP_ALLOWED_ORIGINS`; other 403 responses can reflect patient permissions or CSRF checks. A `401` from the app login means the CareLoop credentials were not accepted; the separate Vercel Authentication gate appears before the app and must be passed first.

`requirements.lock` is exported from `backend/uv.lock` and installed with hashes. Regenerate it after a dependency change using `uv export --frozen --no-dev --no-emit-project --format requirements-txt --output-file ../deploy/requirements.lock` from `backend/`. Frontend dependencies use `npm ci` and the checked-in lockfile.

Container build/start and the public TLS deployment have not been executed in the current workspace because Docker and the deployment account/domain are unavailable. The backend suite passes against an isolated local PostgreSQL 15.14 cluster; the PostgreSQL 17 deployment image itself remains untested. Local app and firmware checks are recorded separately in the verification document.
