# CareLoop dashboard

Responsive React dashboard for the CareLoop demo. The browser uses the same-origin `/v1` API and the Vite development server proxies `/v1` to `http://localhost:8000`.

```sh
npm ci
npm run dev
```

Set `VITE_DEMO_MODE=true` only when the backend is running with its explicit fictional development seed. The badge is intentionally absent otherwise. The caregiver dashboard manages reviewed records. The `/companion` route can capture voice through the browser microphone after owner-approved pairing; it shares the native companion contracts in `mobile/src/contracts.ts`. See the [browser companion setup guide](../docs/careloop/Web-Companion.md).

The app uses the cookie session and CSRF token returned by `/v1/auth/session` or `/v1/auth/login`. Every proposed health change remains uncommitted until the user reviews and confirms it. Summary sharing is a separate action after saving the review.
