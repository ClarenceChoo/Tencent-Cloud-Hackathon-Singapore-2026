// The Vercel project root is this repository: frontend imports a type from mobile/.
// An absent backend produces a static preview with explicit unavailable API routes.
function backendOrigin(value) {
  if (value === undefined || value === '') return null;
  if (!/^https:\/\/[A-Za-z0-9.-]+\/?$/.test(value)) {
    throw new Error('BACKEND_URL must be a public HTTPS origin without a path, port, credentials, query, or fragment.');
  }
  const url = new URL(value);
  const labels = url.hostname.split('.');
  const reserved = /\.(?:localhost|local|internal|test|invalid|example|onion)$/.test(url.hostname);
  if (labels.length < 2 || labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
      || reserved || /^(?:\d+\.){3}\d+$/.test(url.hostname) || url.hostname.endsWith('.home.arpa')) {
    throw new Error('BACKEND_URL must use a public DNS hostname, not localhost, an IP address, or a reserved domain.');
  }
  return url.origin;
}

const origin = backendOrigin(process.env.BACKEND_URL);
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests";
const commonHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
];

export const config = {
  framework: 'vite',
  installCommand: 'npm ci --prefix frontend',
  buildCommand: 'npm run build --prefix frontend',
  outputDirectory: 'frontend/dist',
  headers: [
    { source: '/(.*)', headers: commonHeaders },
    { source: '/companion', headers: [{ key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' }] },
    { source: '/companion/:path*', headers: [{ key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' }] },
    { source: '/((?!companion(?:/|$)).*)', headers: [{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }] },
    { source: '/v1', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    { source: '/v1/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    { source: '/healthz', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    { source: '/index.html', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    { source: '/', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    { source: '/companion', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    { source: '/companion/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    { source: '/shared/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
  ],
  rewrites: [
    { source: '/v1', destination: origin ? `${origin}/v1` : '/api/unavailable' },
    { source: '/v1/:path*', destination: origin ? `${origin}/v1/:path*` : '/api/unavailable' },
    { source: '/healthz', destination: origin ? `${origin}/healthz` : '/api/unavailable' },
    { source: '/(.*)', destination: '/index.html' },
  ],
};
