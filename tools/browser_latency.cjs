/* Local dashboard latency baseline; not a target-phone/network acceptance result. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.CARELOOP_TEST_ORIGIN || 'http://127.0.0.1:5173';

async function main() {
  assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
  const browser = await chromium.launch({ headless: true, ...(process.env.CARELOOP_BROWSER_EXECUTABLE ? { executablePath: process.env.CARELOOP_BROWSER_EXECUTABLE } : { channel: 'chrome' }) });
  try {
    const context = await browser.newContext({ baseURL: origin });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByLabel('Email address').fill('owner@careloop.invalid');
    await page.getByLabel('Password', { exact: true }).fill('fictional-demo-only');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Add entry', exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Timeline', exact: true }).click();
    const session = await (await context.request.get('/v1/auth/session')).json();
    const headers = { Origin: origin, 'X-CSRF-Token': session.csrf_token };
    const samples = [];
    const tag = Date.now();
    for (let index = 0; index < 30; index++) {
      const wording = `Fictional latency sample ${tag}-${index}`;
      const proposed = await context.request.post(`/v1/app/patients/${session.patients[0].id}/proposals`, { headers, data: { kind: 'health_note', payload: { wording } } });
      assert(proposed.ok());
      const proposal = await proposed.json();
      const started = performance.now();
      const saved = await context.request.post(`/v1/app/proposals/${proposal.id}/confirm`, { headers, data: { confirmed: true } });
      assert(saved.ok());
      await page.getByText(wording, { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 });
      samples.push(Math.round(performance.now() - started));
      // Vary phase relative to polling, rather than aligning each sample after a refresh.
      await new Promise(resolve => setTimeout(resolve, (index * 137) % 900));
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const result = { at: new Date().toISOString(), origin, count: samples.length, metric: 'confirmation request start to already-open visible dashboard entry, milliseconds', environment: 'headless desktop Chrome, loopback Vite/FastAPI, fictional SQLite records; no provider/device/phone test', p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1], max_ms: sorted.at(-1), samples_ms: samples };
    fs.mkdirSync('runtime', { recursive: true });
    fs.writeFileSync('runtime/dashboard-latency.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    assert(result.p95_ms <= 2000, 'Local dashboard p95 exceeded 2 seconds');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
