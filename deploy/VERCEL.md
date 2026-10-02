# Vercel frontend deployment

The default deployment serves the real React frontend over HTTPS. The FastAPI backend, PostgreSQL, scheduler and provider integrations continue to need their own persistent host. The browser calls same-origin `/v1/*`; the Vercel config either forwards those requests to one configured HTTPS backend or returns an explicit 503 JSON response when no backend exists. This default mode requires the app's normal login and does not fabricate accounts, patient data or speech.

## Public UI demo for sharing

Use a separate Vercel project for a public interface showcase. The project created for this repository is **`parse-careloop-ui-demo`**. Set **`VITE_UI_PREVIEW=true`** for its build and leave **`BACKEND_URL` unset**. Deploy to Production for a stable shareable address. Vercel Authentication can be disabled on this dedicated fictional-data project when public sharing is intended.

This explicit build mode opens the dashboard without an app login and uses authored fictional samples bundled with the frontend. Visitors can navigate the care views and inspect forms. Backend requests and changes are blocked; device provisioning, actual sharing and microphone recording are unavailable. Each view labels the demo as fictional. The companion route displays an inert preview page. The public UI does not read the local demo database or retain visitor input in browser storage.

`vercel.mjs` rejects a public UI build with a nonempty `BACKEND_URL`, keeps `/v1/*` and `/healthz` on the unavailable endpoint, and disables microphone permission for the companion route. Verify the deployed site in an unauthenticated browser: it should open into the sample dashboard without either login gate, display the fictional-data notice, and return 503 JSON for API paths.

Use a separate checkout or upload directory when linking this public project with the CLI, so the regular checkout's protected project association remains usable. The **`parse-careloop-preview`** project continues to use its normal app login and All Deployments Vercel Authentication. Keep `VITE_UI_PREVIEW` unset for that project and for the real app.

## Prepare the project

1. Create or link a Vercel project with **Root Directory set to the repository root**. `frontend/src/companionApi.ts` imports `mobile/src/contracts.ts`, so using `frontend/` as the project root omits a build input.
2. Use the checked-in `vercel.mjs` settings: framework `vite`, install `npm ci --prefix frontend`, build `npm run build --prefix frontend`, output `frontend/dist`. Keep the project build settings consistent with those values. The upload allowlist in `.vercelignore` includes only the frontend source, the shared type file, this Vercel config and the 503 function. It excludes backend code, deployment environment files, firmware setup packs and runtime data from CLI uploads.
3. For a dedicated test project, enable **Deployment Protection → Vercel Authentication → All deployments** before the first upload, and grant access only to the intended testers before sharing the URL. Check both the unique deployment URL and the project's main URL: the CLI can make the first deployment in a new project its production deployment. Vercel protection controls who can open this test site; the app's own session, patient grants and CSRF checks still govern care data when a backend is connected. Use a preview deployment for testing while the full system is being prepared.

For a local build check from the repository root:

```sh
npm ci --prefix frontend
npm run build --prefix frontend
npm test --prefix frontend
```

The build artifact is `frontend/dist`. The Vercel config uses a [programmatic `vercel.mjs`](https://vercel.com/docs/project-configuration/vercel-ts) so it can select the API route at build time. A missing `BACKEND_URL` is an intentional frontend-only preview. Test that `/` and `/companion` serve the app, `/v1/auth/session` and `/healthz` return **503 JSON**, and the browser shows an unavailable request instead of a working sign-in. Do not enter real patient information in this state.

## Connect a backend later

Deploy the existing backend at a publicly reachable HTTPS DNS origin, then set `BACKEND_URL` in Vercel's project environment for the target deployment to that exact origin, for example `https://api.your-domain.tld`. It is a fixed server-side routing setting, not a `VITE_` variable and not a client credential. `vercel.mjs` rejects a URL with a path, port, query, fragment, credentials, localhost, an IP address or a reserved hostname. Redeploy after setting or changing it; the rewrite is selected during the build. Never put provider credentials, database URLs, session secrets or device credentials in a Vite variable or the Vercel project.

On the backend host, keep `CARELOOP_COOKIE_SECURE=true` and set `CARELOOP_ALLOWED_ORIGINS` to the **exact Vercel HTTPS origin** used by testers. Browser companion enrollment and unsafe requests require an allowed `Origin`; the dashboard login does too. The browser continues to use its same-origin `/v1` path, so cookies remain host-only on the Vercel origin and CSRF tokens continue to be checked by FastAPI. Keep `CARELOOP_PUBLIC_BASE_URL` pointed at the backend's own HTTPS origin for physical devices; do not point the ESP32 at a protected Vercel preview. The separate backend must handle its own TLS, persistent database and WebSocket endpoint.

After redeploying, verify that `/healthz` returns `{"status":"ok"}`, login sets a `Secure; HttpOnly; SameSite=Lax` session cookie without a `Domain` attribute, `/v1/auth/session` returns the session, an authorized write succeeds only with its CSRF token, and `/companion` can request the microphone over HTTPS. Confirm `/v1/*` responses have `Cache-Control: private, no-store` at the public URL. A browser tab's share URL should remain on the Vercel origin and report expiry or revocation correctly. If the backend cannot be reached, leave `BACKEND_URL` unset until its real HTTPS origin is available.

Vercel [external rewrites](https://vercel.com/docs/routing/rewrites) are fixed in configuration; requests cannot choose a backend target. The frontend's content security policy permits only same-origin scripts, styles and connections, plus local blob audio playback. Deployment protection is [configured per project](https://vercel.com/docs/deployment-protection), so it must be checked in the Vercel dashboard rather than assumed from source control.
