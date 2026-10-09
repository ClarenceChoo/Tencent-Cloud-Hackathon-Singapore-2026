/* Real-browser integration against an explicitly seeded, fictional local database. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.CARELOOP_TEST_ORIGIN || 'http://127.0.0.1:5173';
const output = path.resolve('runtime/screenshots');
const tag = `Browser check ${Date.now()}`;
const evidence = [];

async function main() {
  assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Only use this scenario against a local fictional database');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CARELOOP_BROWSER_EXECUTABLE ? { executablePath: process.env.CARELOOP_BROWSER_EXECUTABLE } : { channel: 'chrome' }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, baseURL: origin, timezoneId: 'Asia/Singapore' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  let session;
  async function step(name, fn) { await fn(); evidence.push({ name, passed: true }); console.log(`PASS ${name}`); }
  async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await context.request.fetch(`/v1${route}`, { method, headers: { Origin: origin, ...(session ? { 'X-CSRF-Token': session.csrf_token } : {}) }, ...(body === undefined ? {} : { data: body }) });
    const text = await response.text();
    assert(response.ok(), `${method} ${route}: ${response.status()} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  async function dashboard() { return api(`/app/patients/${session.patients[0].id}/dashboard`); }
  const nav = name => require('./dashboard_navigation.cjs').navigateDashboard(page, name);
  async function confirm() {
    const response = page.waitForResponse(r => /\/proposals\/[^/]+\/confirm$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm and save' }).click();
    const result = await response;
    assert(result.ok(), await result.text());
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  async function composer(kind) {
    await page.getByRole('button', { name: 'Add entry', exact: true }).click();
    await page.getByLabel('Type', { exact: true }).selectOption(kind);
  }
  async function proposal() {
    await page.getByRole('button', { name: 'Review proposal', exact: false }).click();
    await page.getByRole('dialog').waitFor();
  }
  try {
    await step('Sign in through real cookie/CSRF API', async () => {
      await page.goto('/');
      await page.getByLabel('Email address').fill('owner@careloop.invalid');
      await page.getByLabel('Password', { exact: true }).fill('fictional-demo-only');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Add entry', exact: true }).waitFor();
      session = await api('/auth/session');
    });
    let note;
    await step('Care note remains a proposal until explicit confirmation', async () => {
      await composer('health_note');
      await page.getByLabel('What would you like recorded?').fill(`${tag}: knee discomfort after a walk.`);
      await proposal();
      assert(!(await dashboard()).notes.some(n => n.wording.startsWith(tag)));
      await confirm();
      note = (await dashboard()).notes.find(n => n.wording.startsWith(tag));
      assert(note && note.shared_with_user_ids.length === 0);
    });
    let measurement;
    await step('External reading correction commits only revised values', async () => {
      await composer('measurement');
      await page.getByLabel('Systolic (mmHg)', { exact: true }).fill('128');
      await page.getByLabel('Diastolic (mmHg)', { exact: true }).fill('76');
      await page.getByLabel('Or describe the approximate time').fill(`${tag}: this morning`);
      await page.getByLabel('Source (e.g. home monitor)').fill('Fictional home cuff');
      await page.getByLabel('Who reported this?').selectOption('patient');
      await proposal();
      await page.getByRole('dialog').getByLabel(/^Systolic$/i).fill('126');
      assert(await page.getByRole('dialog').getByRole('button', { name: 'Confirm and save' }).isDisabled(), 'Unreviewed edits must disable confirmation');
      const revised = page.waitForResponse(r => r.url().endsWith('/revise') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Review revised details' }).click();
      assert((await revised).ok());
      await confirm();
      measurement = (await dashboard()).measurements.find(m => m.occurrence_text === `${tag}: this morning`);
      assert.equal(measurement.systolic, 126);
      assert.equal(measurement.diastolic, 76);
    });
    await step('Create a checked medication plan and confirmed dose report', async () => {
      await nav('Medications');
      await page.getByRole('button', { name: /Add medicine|Create plan/ }).click();
      await page.getByLabel('Medicine name', { exact: true }).fill(`${tag} DemoMed`);
      await page.getByLabel('Instructions from label').fill('Fictional demo instruction only.');
      await page.getByLabel('Schedule and time').fill('08:00');
      await page.getByLabel('Source (e.g. current prescription)').fill('Fictional demonstration label');
      await page.getByRole('checkbox', { name: /I checked these details/ }).check();
      const saved = page.waitForResponse(r => r.url().endsWith('/medication-plans') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Save checked plan' }).click();
      assert((await saved).ok());
      const dose = (await dashboard()).doses.find(d => d.medicine_name === `${tag} DemoMed`);
      assert(dose, 'Checked plan must materialise scheduled doses');
      await composer('medication_report');
      await page.getByLabel('Scheduled dose', { exact: true }).selectOption(dose.id);
      await page.getByLabel('Reported status', { exact: true }).selectOption('reported_not_yet');
      await proposal(); await confirm();
      assert.equal((await dashboard()).doses.find(d => d.id === dose.id).report_state, 'reported_not_yet');
      await composer('medication_report');
      await page.getByLabel('Scheduled dose', { exact: true }).selectOption(dose.id);
      await page.getByLabel('Reported status', { exact: true }).selectOption('reported_taken');
      await proposal();
      await page.getByRole('dialog').getByText(/update the previous not yet report to taken/).waitFor();
      await confirm();
      const updatedDose = (await dashboard()).doses.find(d => d.id === dose.id);
      assert.equal(updatedDose.report_state, 'reported_taken');
      assert.deepEqual(updatedDose.report_history.map(report => report.report_state), ['reported_not_yet', 'reported_taken']);
    });
    let task;
    await step('Preventive task moves due → arranged → completed through confirmations', async () => {
      await nav('Care plan');
      await page.getByRole('button', { name: 'Add task', exact: false }).click();
      await page.getByLabel('Task type', { exact: true }).fill('follow-up');
      await page.getByLabel('Description from the care plan').fill(`${tag} appointment`);
      await page.getByLabel('Care plan source').fill('Fictional entered care plan');
      const today = new Date().toISOString().slice(0, 10);
      await page.getByLabel(/^Due date/).fill(today);
      await page.getByLabel('Task state', { exact: true }).selectOption('due');
      await proposal(); await confirm();
      task = (await dashboard()).preventive_tasks.find(t => t.description === `${tag} appointment`);
      const row = page.locator('.care-task').filter({ hasText: `${tag} appointment` });
      await row.getByRole('button', { name: /Propose an update/ }).click();
      await row.getByLabel('New status').selectOption('arranged');
      await row.getByLabel('Appointment date').fill(today);
      await row.getByRole('button', { name: 'Review proposed change' }).click();
      await confirm();
      assert.equal((await dashboard()).preventive_tasks.find(t => t.id === task.id).state, 'arranged');
      if (!await row.getByLabel('New status').isVisible()) await row.getByRole('button', { name: /Propose an update/ }).click();
      await row.getByLabel('New status').selectOption('completed');
      await row.getByLabel('Completion date').fill(today);
      await row.getByRole('button', { name: 'Review proposed change' }).click();
      await confirm();
      assert.equal((await dashboard()).preventive_tasks.find(t => t.id === task.id).state, 'completed');
    });
    await step('Private note sharing is deliberate and revocable', async () => {
      const caregiver = await browser.newContext({ baseURL: origin });
      const login = await caregiver.request.post('/v1/auth/login', { headers: { Origin: origin }, data: { email: 'caregiver@careloop.invalid', password: 'fictional-caregiver-only' } });
      assert(login.ok());
      const care = await login.json();
      async function caregiverNotes() {
        const response = await caregiver.request.get(`/v1/app/patients/${care.patients[0].id}/dashboard`);
        assert(response.ok()); return (await response.json()).notes;
      }
      assert(!(await caregiverNotes()).some(n => n.id === note.id));
      await nav('Timeline');
      const row = page.locator('.timeline-item').filter({ hasText: `${tag}: knee discomfort` });
      if (!(await row.getByRole('button', { name: /Manage sharing/ }).isVisible())) await row.getByRole('button', { name: 'View', exact: true }).click();
      await row.getByRole('button', { name: /Manage sharing/ }).click();
      await page.getByRole('dialog').getByRole('checkbox', { name: /Fictional Jamie/ }).check();
      const shared = page.waitForResponse(r => r.url().endsWith(`/notes/${note.id}/sharing`) && r.request().method() === 'PUT');
      await page.getByRole('button', { name: 'Save sharing', exact: true }).click();
      assert((await shared).ok());
      assert((await caregiverNotes()).some(n => n.id === note.id));
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      if (!(await row.getByRole('button', { name: /Manage sharing/ }).isVisible())) await row.getByRole('button', { name: 'View', exact: true }).click();
      await row.getByRole('button', { name: /Manage sharing/ }).click();
      await page.getByRole('dialog').getByRole('checkbox', { name: /Fictional Jamie/ }).uncheck();
      const revoked = page.waitForResponse(r => r.url().endsWith(`/notes/${note.id}/sharing`) && r.request().method() === 'PUT');
      await page.getByRole('button', { name: 'Save sharing', exact: true }).click();
      assert((await revoked).ok());
      assert(!(await caregiverNotes()).some(n => n.id === note.id));
      await caregiver.close();
    });
    await step('Support request and follow-up preserve explicit acknowledgement and outcome', async () => {
      await nav('Support');
      await page.getByRole('button', { name: 'New request', exact: false }).click();
      await page.getByLabel('What help is needed?').fill(`${tag}: help collect a refill`);
      await page.getByLabel('Share with', { exact: true }).selectOption({ label: 'Fictional Jamie Lim' });
      await page.getByLabel('What is getting in the way? (optional)').fill('Fictional transport difficulty');
      await proposal(); await confirm();
      const request = (await dashboard()).support_requests.find(r => r.request_text.startsWith(tag));
      assert.equal(request.status, 'sent');
      const row = page.locator('.support-item').filter({ hasText: `${tag}: help collect a refill` });
      const recipientContext = await browser.newContext({ baseURL: origin });
      const recipientLogin = await recipientContext.request.post('/v1/auth/login', { headers: { Origin: origin }, data: { email: 'caregiver@careloop.invalid', password: 'fictional-caregiver-only' } });
      assert(recipientLogin.ok());
      const recipientSession = await recipientLogin.json();
      const acknowledged = await recipientContext.request.post(`/v1/app/support-requests/${request.id}/acknowledge`, { headers: { Origin: origin, 'X-CSRF-Token': recipientSession.csrf_token } });
      assert(acknowledged.ok(), await acknowledged.text());
      await recipientContext.close();
      await row.getByText('Acknowledged', { exact: true }).waitFor();
      await row.getByRole('button', { name: /Schedule a follow-up/ }).click();
      await row.getByLabel('When to check in').fill('2026-09-25T10:00');
      await row.getByRole('button', { name: 'Review follow-up', exact: true }).click();
      await confirm();
      const followup = (await dashboard()).followups.find(f => f.related_id === request.id);
      assert.equal(followup.resolution_state, 'open');
      const item = page.locator('.permission-row').filter({ has: page.getByRole('button', { name: /Record follow-up outcome/ }) }).last();
      await item.getByRole('button', { name: /Record follow-up outcome/ }).click();
      await page.getByLabel('Reported follow-up outcome').fill('Caregiver reports refill collected.');
      await page.getByRole('button', { name: 'Review outcome', exact: true }).click();
      await confirm();
      assert.equal((await dashboard()).followups.find(f => f.id === followup.id).resolution_state, 'resolved');
    });
    await step('External committed note refreshes an already-open dashboard', async () => {
      await nav('Timeline');
      const p = await api(`/app/patients/${session.patients[0].id}/proposals`, { kind: 'health_note', payload: { wording: `${tag}: separate client update` } });
      const before = Date.now();
      await api(`/app/proposals/${p.id}/confirm`, { confirmed: true });
      await page.getByText(`${tag}: separate client update`, { exact: true }).first().waitFor();
      evidence.push({ name: 'Observed dashboard refresh', milliseconds: Date.now() - before });
    });
    let sharedPath;
    await step('Reviewed summary contains record text and sources; sharing is revocable', async () => {
      await nav('Visit summary');
      await page.getByRole('button', { name: /Prepare draft|Prepare a fresh draft/ }).click();
      await page.locator('.summary-source textarea').first().waitFor();
      const content = (await page.locator('.summary-source textarea').evaluateAll(nodes => nodes.map(node => node.value))).join('\n');
      assert(content.includes('126/76') && content.includes(`${tag} appointment`) && content.includes('knee discomfort'), content);
      assert(await page.locator('.summary-source').count() >= 3, 'Summary must preserve source links');
      await page.getByRole('button', { name: 'Save review', exact: true }).click();
      await page.getByRole('button', { name: 'Share read-only', exact: true }).click();
      const link = page.getByRole('link', { name: 'Open read-only view' });
      await link.waitFor();
      sharedPath = await link.getAttribute('href');
      const publicContext = await browser.newContext({ baseURL: origin });
      const publicPage = await publicContext.newPage();
      await publicPage.goto(sharedPath);
      await publicPage.getByText(/126\/76/).first().waitFor();
      await publicPage.screenshot({ path: path.join(output, 'summary.png'), fullPage: true });
      await page.getByRole('button', { name: 'Revoke link' }).click();
      await publicPage.reload();
      await publicPage.getByRole('heading', { name: 'This summary is unavailable' }).waitFor();
      await publicContext.close();
    });
    await nav('Timeline');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'dashboard-desktop.png'), fullPage: true });
    await step('Mobile viewport has no page overflow and exposes navigation', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await page.getByRole('button', { name: 'Open menu' }).click();
      await nav('Timeline');
      await page.getByRole('button', { name: 'Open menu' }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(output, 'timeline-mobile.png'), fullPage: false });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    });
    assert.deepEqual(errors, [], 'Browser must not report uncaught application errors');
    fs.writeFileSync('runtime/browser-evidence.json', JSON.stringify({ at: new Date().toISOString(), origin, evidence, errors }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-4500));
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
