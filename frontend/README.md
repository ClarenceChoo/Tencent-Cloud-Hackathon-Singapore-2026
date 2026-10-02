# Parse frontend

## Parse landing page

The public product introduction lives at `/landing/` and builds from its own HTML entry and stylesheet. Its header and main calls to action open the existing caregiver dashboard at `/`; the browser-companion link opens `/companion`. The dashboard footer links back through **About Parse**, and the sign-in and companion logos also return to the landing page. These links stay on the current website, so the default build retains sign-in while a public UI build opens the fictional care space. Both `/landing` and `/landing/` work in the hosted routing config. Its fictional interactive example stays entirely in the page: it never uses the microphone, backend, or browser storage. Copy lives in `src/landingCopy.ts`.

The light Aurora Pearl theme uses warm ivory and pearl surfaces, soft aqua and lilac lighting, and navy text. The landing hero places the transparent Care Conversation emblem on a luminous light background. `src/BrandLogo.tsx` uses the navy-wordmark logo from `public/brand/` across the landing page, dashboard, sign-in, companion, and shared summary. Both HTML entries use the profile emblem as their favicon and warm ivory as their browser theme colour. DM Serif Display, DM Sans, and the family photographs are served locally from `public/landing/`. See the [theme assets and verification record](../design/parse-logos-2026-10-02/aurora-website/README.md).

Responsive React dashboard for the CareLoop demo. The browser uses the same-origin `/v1` API and the Vite development server proxies `/v1` to `http://localhost:8000`.

```sh
npm ci
npm run dev
```

Set `VITE_DEMO_MODE=true` only when the backend is running with its explicit fictional development seed. The badge is intentionally absent otherwise. The caregiver dashboard manages reviewed records. The `/companion` route can capture voice through the browser microphone after owner-approved pairing; it shares the native companion contracts in `mobile/src/contracts.ts`. See the [browser companion setup guide](../docs/careloop/Web-Companion.md).

For a **public, login-free UI showcase**, build with `VITE_UI_PREVIEW=true`. This is separate from `VITE_DEMO_MODE`: it opens directly into an authored fictional care space, displays a persistent UI demo label, and never requests `/v1` or any backend. All API writes, sharing, and device actions are blocked with demo-only feedback. The `/companion` route shows an informational preview without microphone or enrollment. A `/shared/summaries/...` URL also stays inside the fictional showcase. The fixture is held only in memory; it has no account credentials, real patient data, or browser storage. Build a separate public deployment for this mode; keep the default build for authenticated use.

```sh
VITE_UI_PREVIEW=true npm run build
```

The app uses the cookie session and CSRF token returned by `/v1/auth/session` or `/v1/auth/login`. Every proposed health change remains uncommitted until the user reviews and confirms it. Summary sharing is a separate action after saving the review.

## Vercel preview

Deploy from the **repository root**, because `src/companionApi.ts` imports a type from `mobile/src/contracts.ts`. The root [Vercel configuration](../vercel.mjs) installs only the frontend lockfile, builds `frontend/dist`, and applies the [deployment guide](../deploy/VERCEL.md). With no `BACKEND_URL`, the real frontend remains browsable, while `/v1/*` and `/healthz` return 503 JSON. Login, patient data, pairing and voice require a separately deployed backend.
