/* Real HTTP + Chromium + encoded AAC; scripted speech, no native/device/live-provider claim. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const directory = path.resolve(process.env.PARSE_PHONE_FIXTURE_DIR || path.join(root, 'runtime/phone-browser'));
const origin = process.env.CARELOOP_TEST_ORIGIN || 'http://127.0.0.1:5175';
const backend = process.env.CARELOOP_TEST_BACKEND || 'http://127.0.0.1:8003';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  for (const url of [origin, backend]) assert.equal(new URL(url).hostname, '127.0.0.1');
  assert(directory.startsWith(path.join(root, 'runtime') + path.sep));
  const fixture = JSON.parse(fs.readFileSync(path.join(directory, 'browser.json')));
  const browser = await chromium.launch({ headless: true, ...(process.env.CARELOOP_BROWSER_EXECUTABLE ? { executablePath: process.env.CARELOOP_BROWSER_EXECUTABLE } : { channel: 'chrome' }) });
  const result = { at: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    source_sha256: Object.fromEntries(['frontend/src/App.tsx', 'frontend/src/api.ts', 'frontend/src/DeviceSetup.tsx', 'tools/browser_phone.cjs', 'tools/phone_browser_fixture.py'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    browser: browser.version(), node: process.version, platform: `${process.platform}/${process.arch}`, origin, backend,
    environment: 'Desktop headless Chromium; loopback HTTP Vite/FastAPI; isolated fictional SQLite; encoded tone AAC and scripted speech. No native app, real microphone, live provider, push or target-phone network.',
    liveSpeech: false, physicalPhone: false, evidence: [], samples_ms: [] };
  const save = () => fs.writeFileSync(path.join(directory, 'browser-evidence.json'), JSON.stringify(result, null, 2));
  const pass = name => { result.evidence.push({ name, passed: true }); save(); console.log('PASS ' + name); };
  const token = randomBytes(32).toString('hex'); // Never persisted in screenshots or the evidence report.
  async function phone(route, data, method = data === undefined ? 'GET' : 'POST', extra = {}) {
    return fetch(backend + '/v1' + route, { method, headers: { Authorization: 'Bearer ' + token,
      ...(data ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  async function json(response) { assert(response.ok, `Phone HTTP ${response.status}`); return response.json(); }
  async function login(role, existing) {
    const context = existing?.context || await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
    const page = existing?.page || await context.newPage();
    page.setDefaultTimeout(12000);
    if (!existing) await page.goto('/');
    await page.getByLabel('Email address').fill(role + '@careloop.invalid');
    await page.getByLabel('Password', { exact: true }).fill('fictional-browser-only');
    await page.getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('heading', { name: /care timeline/i }).waitFor();
    const session = await (await context.request.get('/v1/auth/session')).json();
    const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
      const response = await context.request.fetch('/v1' + route, { method, headers: { Origin: origin, 'X-CSRF-Token': session.csrf_token }, ...(data === undefined ? {} : { data }) });
      assert(response.ok(), `Browser HTTP ${response.status()} ${route}`);
      return response.status() === 204 ? undefined : response.json();
    };
    return { context, page, session, api, dash: () => api(`/app/patients/${fixture.patient_id}/dashboard`) };
  }
  const nav = (page, name) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  async function upload(name, context, key = randomUUID()) {
    const started = performance.now();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'audio/mp4', 'Idempotency-Key': key, ...(context ? { 'X-Context-Id': context } : {}) };
    const accepted = await json(await fetch(backend + '/v1/phone/turns', { method: 'POST', headers, body: fs.readFileSync(path.join(directory, name + '.m4a')) }));
    for (let index = 0; index < 100; index++) {
      const receipt = await json(await phone('/device/turns/' + accepted.turn_id));
      if (receipt.event) {
        assert.notEqual(receipt.event.payload.status, 'failed', JSON.stringify(receipt.event.payload));
        return { id: accepted.turn_id, event: receipt.event.payload, key, started };
      }
      await sleep(50);
    }
    throw new Error('Fixture turn timed out');
  }
  const heading = (page, wording) => page.getByRole('heading', { name: wording, exact: true });
  try {
    const owner = await login('owner');
    let caregiver = await login('caregiver');
    const restricted = await login('restricted');
    const restrictedResponses = [];
    restricted.page.on('response', response => {
      if (new URL(response.url()).pathname.endsWith('/dashboard') && response.ok())
        void response.text().then(text => restrictedResponses.push(text)).catch(() => {});
    });
    const enrollment = await json(await phone('/phone/enrollments', { platform: 'ios', display_name: 'Fictional phone HTTP fixture' }, 'POST', { 'Idempotency-Key': randomUUID() }));
    await nav(owner.page, 'Settings');
    await owner.page.getByLabel('Companion type').selectOption('phone');
    await owner.page.getByLabel('One-use device code').fill(enrollment.code);
    await owner.page.getByRole('button', { name: 'Approve phone', exact: true }).click();
    await owner.page.getByRole('heading', { name: 'Parse phone · Fictional phone HTTP fixture' }).waitFor();
    assert.equal((await json(await phone('/phone/enrollments/current'))).status, 'paired');
    await owner.page.getByLabel('Send reminders to').selectOption(enrollment.device_id);
    await owner.page.getByRole('button', { name: 'Save reminder companion', exact: true }).click();
    await owner.page.getByText('Selected reminder companion', { exact: true }).waitFor();
    pass('Owner approves the phone code and explicitly selects it in the existing dashboard');

    const original = await upload('original');
    assert.equal(original.event.status, 'awaiting_confirmation');
    assert.equal((await caregiver.dash()).notes.length, 0);
    assert.equal(await heading(caregiver.page, 'Fictional right knee after walking').count(), 0);
    const corrected = await upload('corrected', original.event.context_id);
    assert.equal(corrected.event.status, 'awaiting_confirmation');
    const home = await json(await phone('/phone/home'));
    assert.equal(home.current_proposal.context_id, corrected.event.context_id);
    const confirmation = await upload('confirm', corrected.event.context_id);
    assert.equal(confirmation.event.status, 'committed');
    await heading(caregiver.page, 'Fictional left knee after walking').waitFor();
    const retry = await upload('confirm', corrected.event.context_id, confirmation.key);
    assert.equal(retry.id, confirmation.id);
    const note = (await caregiver.dash()).notes[0];
    assert.equal((await owner.dash()).notes.length, 1);
    assert.equal(note.provenance.type, 'phone');
    assert.equal(note.provenance.turn_id, corrected.id);
    await caregiver.page.getByText(/Recorded via Parse phone/).first().waitFor();
    pass('AAC phone correction and confirmation produce exactly one source-labelled note in the already-open caregiver timeline');
    await caregiver.page.screenshot({ path: path.join(directory, 'caregiver-phone-note.png'), fullPage: true });

    const privateNote = await upload('private');
    assert.equal((await caregiver.dash()).notes.length, 1);
    assert.equal((await restricted.dash()).proposals.length, 0);
    await upload('confirm', privateNote.event.context_id);
    assert.equal((await owner.dash()).notes.length, 2);
    assert.equal((await caregiver.dash()).notes.length, 1);
    assert.equal((await restricted.dash()).notes.length, 0);
    // Wait for a real new polling response on both already-open pages before testing absence.
    await Promise.all([caregiver, restricted].map(view => view.page.waitForResponse(r => r.ok() && new URL(r.url()).pathname.endsWith('/dashboard'))));
    assert(!await caregiver.page.getByText(/Fictional private concern/).count());
    assert(!await restricted.page.getByText(/Fictional (left|right) knee|Fictional private concern/).count());
    assert(restrictedResponses.length > 0);
    assert(restrictedResponses.every(text => !/Fictional (left|right) knee|Fictional private concern/.test(text)));
    pass('Private notes and phone proposal details stay absent from unauthorized caregiver HTTP responses and rendered views');

    await owner.api('/app/notes/' + note.id + '/sharing', { user_ids: [] }, 'PUT');
    await heading(caregiver.page, note.wording).waitFor({ state: 'hidden' });
    await owner.api('/app/notes/' + note.id + '/sharing', { user_ids: [fixture.caregiver_id] }, 'PUT');
    await heading(caregiver.page, note.wording).waitFor();
    pass('Changing a note’s recipients removes and restores it automatically without a page refresh');

    await owner.api('/app/grants/' + fixture.grant_id, undefined, 'DELETE');
    await caregiver.page.getByRole('heading', { name: 'Sign in to your care space', exact: true }).waitFor();
    assert.equal(await heading(caregiver.page, note.wording).count(), 0);
    pass('Revoking the whole caregiver grant clears the open care view');
    await owner.api(`/app/patients/${fixture.patient_id}/grants`, { user_id: fixture.caregiver_id, scopes: ['read:dashboard'], expires_at: null });
    caregiver = await login('caregiver', caregiver);
    await nav(caregiver.page, 'Timeline');
    assert.equal((await caregiver.dash()).notes.length, 0, 'Regrant must not restore previously revoked note sharing');

    for (let index = 0; index < 30; index++) {
      const draft = await upload('sample-' + index);
      assert.equal(draft.event.status, 'awaiting_confirmation');
      const saved = await upload('confirm', draft.event.context_id);
      assert.equal(saved.event.status, 'committed');
      await heading(caregiver.page, `Fictional phone latency sample ${String(index).padStart(2, '0')}`).waitFor({ timeout: 5000 });
      result.samples_ms.push(Math.round(performance.now() - saved.started));
      await sleep((index * 137) % 900);
    }
    const sorted = [...result.samples_ms].sort((a, b) => a - b);
    result.latency = { count: 30, metric: 'Phone confirmation upload request start to visible confirmed heading in an already-open caregiver dashboard, ms; includes AAC normalization and scripted processing',
      p50_ms: sorted[14], p95_ms: sorted[28], max_ms: sorted[29], target_ms: 2000 };
    assert(result.latency.p95_ms <= 2000, 'Local phone-to-dashboard p95 exceeded 2 seconds');
    pass('30 confirmed phone events reach the already-open permitted dashboard within the local p95 target');
    assert.equal((await owner.dash()).notes.length, 32);
    assert.equal((await caregiver.dash()).notes.length, 30);
    assert.equal((await restricted.dash()).notes.length, 0);
    assert(restrictedResponses.every(text => !/Fictional (left|right) knee|Fictional private concern|Fictional phone latency sample/.test(text)));
    await caregiver.page.screenshot({ path: path.join(directory, 'caregiver-phone-latency.png'), fullPage: true });

    await caregiver.api('/auth/logout', undefined, 'POST'); // Session ends outside this page's UI.
    await caregiver.page.getByRole('heading', { name: 'Sign in to your care space', exact: true }).waitFor();
    assert.equal(await caregiver.page.getByRole('heading', { name: /Fictional phone latency sample/ }).count(), 0);
    pass('A server-invalidated browser session clears displayed care information on refresh');
    await owner.page.getByRole('button', { name: 'Revoke device access', exact: true }).click();
    await owner.page.getByRole('dialog').getByRole('button', { name: 'Revoke access', exact: true }).click();
    await owner.page.getByText('Access revoked', { exact: true }).first().waitFor();
    assert.equal((await phone('/phone/home')).status, 403);
    pass('Owner phone revocation blocks further phone reads and appears in the browser');
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.failure = error.message;
    throw error;
  } finally { save(); await browser.close(); }
  console.log(JSON.stringify(result.latency));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
