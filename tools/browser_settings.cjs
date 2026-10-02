/* Focused checks against a fictional local database; no physical device is simulated. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.CARELOOP_TEST_ORIGIN || 'http://127.0.0.1:5173';

async function main() {
  assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
  const browser = await chromium.launch({ headless: true, ...(process.env.CARELOOP_BROWSER_EXECUTABLE ? { executablePath: process.env.CARELOOP_BROWSER_EXECUTABLE } : { channel: 'chrome' }) });
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const evidence = [];
  let session;
  async function api(route, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await context.request.fetch(`/v1${route}`, { method, headers: { Origin: origin, ...(session ? { 'X-CSRF-Token': session.csrf_token } : {}) }, ...(data === undefined ? {} : { data }) });
    assert(response.ok(), `HTTP ${response.status()} on ${route}`);
    return response.json();
  }
  const nav = name => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  const save = async (button, suffix, method = 'POST') => {
    const result = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(suffix) && r.request().method() === method);
    await button.click();
    assert((await result).ok(), `Failed ${suffix}`);
  };
  const pass = name => { evidence.push({ name, passed: true }); console.log(`PASS ${name}`); };
  try {
    await page.goto('/');
    await page.getByLabel('Email address').fill('owner@careloop.invalid');
    await page.getByLabel('Password', { exact: true }).fill('fictional-demo-only');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Add entry', exact: true }).waitFor();
    session = await api('/auth/session');
    const patientId = session.patients[0].id;
    const dashboard = () => api(`/app/patients/${patientId}/dashboard`);
    await nav('Settings');
    const original = (await dashboard()).patient;
    await page.getByLabel('Preferred name', { exact: true }).fill('Fictional Mei browser check');
    await page.getByRole('checkbox', { name: 'Enable an optional daily check-in' }).check();
    await page.getByLabel('Daily check-in time').fill('23:59');
    await save(page.getByRole('button', { name: 'Save preferences' }), '/profile', 'PUT');
    const changed = (await dashboard()).patient;
    assert.equal(changed.preferred_name, 'Fictional Mei browser check');
    assert.equal(changed.daily_check_in_local_time, '23:59');
    assert.equal(changed.daily_check_in_enabled, true);
    await api(`/app/patients/${patientId}/profile`, Object.fromEntries(['preferred_name', 'language', 'timezone', 'calling_route', 'daily_check_in_enabled', 'daily_check_in_local_time'].map(key => [key, original[key]])), 'PUT');
    pass('Profile preferences persist; original preferences restored');

    await nav('Timeline');
    const wording = `Fictional pending review ${Date.now()}`;
    const proposal = await api(`/app/patients/${patientId}/proposals`, { kind: 'health_note', payload: { wording } });
    const pendingRow = page.locator('.proposal-row').filter({ hasText: wording });
    await pendingRow.getByRole('button', { name: 'Review', exact: true }).click();
    assert(!(await dashboard()).notes.some(note => note.wording === wording));
    await save(page.getByRole('dialog').getByRole('button', { name: 'Confirm and save' }), `/proposals/${proposal.id}/confirm`);
    assert((await dashboard()).notes.some(note => note.wording === wording));
    pass('A separately created proposal appears and requires dashboard confirmation');

    await nav('Medications');
    const beforePlan = (await dashboard()).medication_plans.find(plan => plan.active);
    assert(beforePlan, 'Run browser_smoke.cjs first to create a fictional plan');
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByLabel('Instructions from label').fill('Revised fictional instruction for UI verification.');
    const saveVersion = page.getByRole('button', { name: 'Save reviewed version' });
    assert(await saveVersion.isDisabled());
    await page.getByRole('checkbox', { name: /I checked these details/ }).check();
    await save(saveVersion, '/medication-plans');
    const afterPlan = (await dashboard()).medication_plans.find(plan => plan.active);
    assert.equal(afterPlan.version, beforePlan.version + 1);
    pass('Edited medication instructions need a fresh check and create a new plan version');

    if (process.env.CARELOOP_TEST_DEVICE_FILE) {
      const text = fs.readFileSync(process.env.CARELOOP_TEST_DEVICE_FILE, 'utf8');
      const code = text.match(/One-time claim code[^:]*: ([A-Z0-9-]+)/)?.[1];
      const credential = text.match(/Device credential[^:]*: (\S+)/)?.[1];
      assert(code && credential, 'Expected private output from provision-device');
      await nav('Settings');
      await page.getByLabel('One-use device code').fill(code);
      await save(page.getByRole('button', { name: 'Pair cardholder', exact: true }), '/devices/claim');
      const device = (await dashboard()).devices.find(item => !item.revoked_at);
      assert(device);
      const accepted = await context.request.get('/v1/device/pending-commands', { headers: { Authorization: `Bearer ${credential}` } });
      assert(accepted.ok());
      await page.getByRole('button', { name: 'Revoke device access', exact: true }).click();
      await save(page.getByRole('dialog').getByRole('button', { name: 'Revoke access', exact: true }), `/devices/${device.id}/revoke`);
      const revoked = await context.request.get('/v1/device/pending-commands', { headers: { Authorization: `Bearer ${credential}` } });
      assert([401, 403].includes(revoked.status()));
      await page.getByLabel('One-use device code').waitFor();
      assert((await dashboard()).devices.find(item => item.id === device.id).revoked_at);
      pass('Claim and revoke change device API access; replacement claim stays available');
    }
    fs.mkdirSync('runtime', { recursive: true });
    fs.writeFileSync('runtime/browser-settings-evidence.json', JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
