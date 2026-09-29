/* Full summary workflow at phone dimensions; desktop Chrome emulation, not a physical phone. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const directory = path.resolve(process.env.PARSE_NATIVE_FIXTURE_DIR || '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assert(directory.startsWith(path.join(root, 'runtime') + path.sep));
  const fixture = JSON.parse(fs.readFileSync(path.join(directory, 'fixture.json')));
  assert.equal(new URL(fixture.origin).hostname, '127.0.0.1');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const options = { baseURL: fixture.origin, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  const report = { at: new Date().toISOString(), physicalPhone: false, nativeBrowser: false,
    environment: 'Desktop headless Chrome with a 390x844 mobile/touch viewport; isolated local HTTPS fixture; real previously confirmed phone-sourced care records.',
    browser: browser.version(), checks: [], source_sha256: Object.fromEntries([
      'tools/browser_phone_summary.cjs', 'frontend/src/App.tsx', 'frontend/src/api.ts', 'backend/app/main.py', 'backend/app/services.py', 'tools/android_native_fixture.py', 'deploy/Caddyfile'
    ].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])) };
  const save = () => fs.writeFileSync(path.join(directory, 'phone-viewport-summary-evidence.json'), JSON.stringify(report, null, 2));
  const pass = name => { report.checks.push({ name, passed: true }); save(); console.log('PASS ' + name); };
  async function login(role) {
    const context = await browser.newContext(options), page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto('/');
    await page.getByLabel('Email address').fill(role + '@native.invalid');
    await page.getByLabel('Password', { exact: true }).fill('fictional-native-only');
    await page.getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('heading', { name: /care timeline/i }).waitFor();
    const session = await (await context.request.get('/v1/auth/session')).json();
    const api = async (route, data) => {
      const response = await context.request.fetch('/v1' + route, { method: data ? 'POST' : 'GET',
        headers: { Origin: fixture.origin, 'X-CSRF-Token': session.csrf_token }, ...(data ? { data } : {}) });
      assert(response.ok(), 'Fixture browser HTTP ' + response.status());
      return response.json();
    };
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Visit summary', exact: true }).click();
    return { context, page, api };
  }
  try {
    const owner = await login('owner'), restricted = await login('restricted');
    await restricted.page.getByRole('heading', { name: 'Summary sharing is owner managed' }).waitFor();
    assert.equal(await restricted.page.getByRole('button', { name: 'Share read-only', exact: true }).count(), 0);
    pass('Phone viewport navigation exposes the summary; restricted caregiver has no prepare/share controls');
    const dash = await owner.api('/app/patients/' + fixture.patient_id + '/dashboard');
    const native = dash.notes.filter(n => n.provenance?.type === 'phone');
    assert(native.length >= 2, 'Reuse actual confirmed native fixture notes');
    const omit = native[0], keep = native[native.length - 1];
    report.source_notes = { omitted: omit.id, retained: keep.id, provenance: 'phone' };
    await owner.page.getByRole('button', { name: /Prepare draft|Prepare a fresh draft/ }).click();
    const rows = owner.page.locator('.summary-source');
    await rows.first().waitFor();
    const texts = await rows.locator('textarea').evaluateAll(nodes => nodes.map(n => n.value));
    const omitIndex = texts.findIndex(t => t.includes(omit.wording));
    assert(omitIndex >= 0 && texts.some(t => t.includes(keep.wording)));
    assert(await rows.nth(omitIndex).locator('.summary-source-check').innerText());
    assert(await owner.page.getByRole('button', { name: 'Share read-only', exact: true }).isDisabled());
    await rows.nth(omitIndex).getByRole('checkbox').uncheck();
    await owner.page.getByRole('button', { name: 'Save review', exact: true }).click();
    await owner.page.getByText('Review saved. It has not been shared.', { exact: true }).waitFor();
    const sharedResponse = owner.page.waitForResponse(r => r.request().method() === 'POST' && /\/summaries\/[^/]+\/share$/.test(new URL(r.url()).pathname));
    await owner.page.getByRole('button', { name: 'Share read-only', exact: true }).click();
    const response = await sharedResponse; assert(response.ok());
    const summaryId = new URL(response.url()).pathname.split('/').at(-2);
    const link = owner.page.getByRole('link', { name: 'Open read-only view' });
    const publicPath = await link.getAttribute('href');
    assert(publicPath.startsWith('/shared/summaries/'));
    const publicContext = await browser.newContext(options), publicPage = await publicContext.newPage();
    await publicPage.goto(publicPath);
    await publicPage.getByText(keep.wording, { exact: false }).first().waitFor();
    assert(!(await publicPage.locator('body').innerText()).includes(omit.wording));
    assert.equal(await publicPage.locator('input,textarea,button').count(), 0);
    for (const page of [owner.page, restricted.page, publicPage])
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile page must not overflow horizontally');
    await publicPage.screenshot({ path: path.join(directory, 'phone-viewport-summary.png'), fullPage: true });
    pass('Owner reviews real phone-sourced records, omits a source, and deliberately shares a read-only mobile summary without horizontal overflow');
    const expiring = await owner.api('/app/summaries/' + summaryId + '/share', { expires_in_seconds: 60 });
    const expiryPage = await publicContext.newPage();
    await expiryPage.goto(expiring.url.replace(/^\/v1/, ''));
    await expiryPage.getByText(keep.wording, { exact: false }).first().waitFor();
    console.log('Waiting for the real 60-second server expiry');
    while (Date.now() <= Date.parse(expiring.expires_at) + 1000) await sleep(1000);
    await expiryPage.reload();
    await expiryPage.getByRole('heading', { name: 'This summary is unavailable' }).waitFor();
    report.expiry = { expires_at: expiring.expires_at, observed_at: new Date().toISOString(), clock_override: false };
    pass('A separately configured 60-second share expires on the real server clock and becomes unavailable in the phone viewport');
    await owner.page.getByRole('button', { name: 'Revoke link', exact: true }).click();
    await publicPage.reload();
    await publicPage.getByRole('heading', { name: 'This summary is unavailable' }).waitFor();
    await publicPage.screenshot({ path: path.join(directory, 'phone-viewport-summary-revoked.png'), fullPage: true });
    pass('Owner revocation invalidates the original read-only link in the mobile view');
  } catch (error) { report.failure = String(error); save(); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
