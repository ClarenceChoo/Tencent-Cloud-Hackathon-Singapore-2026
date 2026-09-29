/* Real browser UI, MediaRecorder and same-origin API checks. Fictional local fixture only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const dir = path.resolve(process.env.PARSE_WEB_FIXTURE_DIR || path.join(root, 'runtime/web-companion'));
const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json')));
const origin = fixture.origin;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
assert(dir.startsWith(path.join(root, 'runtime') + path.sep));
assert.equal(new URL(origin).hostname, '127.0.0.1');

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: [
    '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + path.join(dir, 'microphone.wav'),
  ] });
  const report = { at: new Date().toISOString(), browser: browser.version(), node: process.version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    scope: 'Actual Chromium UI + MediaRecorder with synthetic microphone input; same-origin FastAPI and fictional SQLite; scripted ASR/interpretation and tone replies. Not live speech or a physical-phone test.',
    server_startup_source_sha256: fixture.startup_source_sha256 || null,
    checks: [], pageErrors: [], source_sha256: {}, screenshots: [] };
  const save = () => fs.writeFileSync(path.join(dir, 'ui-evidence.json'), JSON.stringify(report, null, 2));
  const pass = name => { report.checks.push({ name, passed: true }); save(); console.log('PASS ' + name); };
  function observe(page) { page.on('pageerror', error => report.pageErrors.push(error.message)); page.setDefaultTimeout(15000); }
  async function login(role) {
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); observe(page); await page.goto('/');
    await page.getByLabel('Email address').fill(role + '@web.invalid');
    await page.getByLabel('Password', { exact: true }).fill('fictional-web-only');
    await page.getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('heading', { name: /care timeline/i }).waitFor();
    const session = await (await context.request.get('/v1/auth/session')).json();
    const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
      const response = await context.request.fetch('/v1' + route, { method,
        headers: { Origin: origin, 'X-CSRF-Token': session.csrf_token }, ...(data === undefined ? {} : { data }) });
      assert(response.ok(), `Dashboard HTTP ${response.status()} ${route}`);
      return response.status() === 204 ? undefined : response.json();
    };
    return { context, page, api, dash: () => api('/app/patients/' + fixture.patient_id + '/dashboard') };
  }
  const phone = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
  await phone.addInitScript(() => {
    window.__parseObservedTracks = [];
    const original = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (original) navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints); window.__parseObservedTracks.push(...stream.getTracks()); return stream;
    };
  });
  const page = await phone.newPage(); observe(page);
  let uploadCount = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/v1/web/turns') uploadCount++; });
  const nav = (view, name) => view.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  const screenshot = async name => { const file = name + '.png'; await page.screenshot({ path: path.join(dir, file), fullPage: true }); report.screenshots.push(file); };
  const currentHome = async () => { const res = await phone.request.get('/v1/web/home'); assert(res.ok()); return res.json(); };
  const arm = (name, transcript, interpretation) => {
    const file = path.join(dir, 'next-utterance.json'); assert(!fs.existsSync(file), 'Previous scenario is still armed');
    fs.writeFileSync(file, JSON.stringify({ name, transcript, interpretation }), { mode: 0o600 });
  };
  async function capture(name, transcript, interpretation) {
    arm(name, transcript, interpretation);
    await page.getByRole('button', { name: 'Tap to record', exact: true }).click();
    await page.getByRole('button', { name: 'Tap to send', exact: true }).waitFor();
    await sleep(1100);
    await page.getByRole('button', { name: 'Tap to send', exact: true }).click();
    await page.getByRole('region', { name: 'Review before saving' }).waitFor();
    assert(!fs.existsSync(path.join(dir, 'next-utterance.json')));
  }
  try {
    const owner = await login('owner'); const caregiver = await login('caregiver'); const restricted = await login('restricted');
    await page.goto('/companion');
    assert.equal((await phone.request.get('/v1/web/home')).status(), 401);
    await page.getByRole('button', { name: 'Connect this browser', exact: true }).click();
    const code = page.locator('.companion-code'); await code.waitFor(); const possession = (await code.textContent()).trim();
    assert.match(possession, /^P-[A-F0-9]{5}-[A-F0-9]{5}$/);
    await nav(owner.page, 'Settings');
    // Browser enrollment shares owner approval, with browser-specific wording in the dashboard.
    const select = owner.page.getByLabel('Companion type');
    await select.selectOption('browser');
    await owner.page.getByLabel('One-use device code').fill(possession);
    await owner.page.getByRole('button', { name: /^Approve (phone|browser)/ }).click();
    await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await page.getByRole('heading', { name: 'Hello, Mei.', exact: true }).waitFor();
    const paired = await currentHome(); report.device_id = paired.device_id;
    const privateCookies = (await phone.cookies()).filter(c => /web|companion/.test(c.name));
    assert(privateCookies.length && privateCookies.every(c => c.httpOnly && c.sameSite === 'Strict'));
    const visibleCookie = await page.evaluate(() => document.cookie);
    assert(privateCookies.every(c => !visibleCookie.includes(c.name) && !visibleCookie.includes(c.value)));
    assert.equal((await phone.request.post('/v1/web/speaker-check', { headers: { Origin: origin, 'X-Parse-Web': '1' } })).status(), 403);
    pass('Owner-approved browser pairing works through the dashboard; credentials are HttpOnly and unsafe calls require CSRF');

    await page.getByRole('button', { name: 'Tap to record', exact: true }).click();
    await page.getByRole('button', { name: 'Tap to send', exact: true }).waitFor();
    await sleep(500); await page.getByRole('button', { name: 'Cancel recording', exact: true }).click();
    await page.getByRole('button', { name: 'Tap to record', exact: true }).waitFor();
    assert.equal(uploadCount, 0);
    assert(await page.evaluate(() => window.__parseObservedTracks.every(track => track.readyState === 'ended')));
    pass('Cancelling real browser recording releases microphone tracks and sends no upload');

    await capture('knee-note', 'My right knee felt sore after my walk. Please tell Jamie.', { intent: 'proposal', kind: 'health_note',
      payload: { wording: 'My right knee felt sore after my walk.', occurrence_text: 'after my walk', share_with_user_ids: [fixture.caregiver_id] } });
    assert.equal((await caregiver.dash()).notes.length, 0);
    await screenshot('web-readback');
    assert(await page.getByRole('region', { name: 'Review before saving' }).getByText(/Jamie/).count());
    pass('MediaRecorder WebM reaches the shared worker and shows an unsaved read-back with its named recipient');

    const playbackRequests = [];
    page.on('request', req => { if (/\/v1\/web\/audio\//.test(req.url())) playbackRequests.push({method:req.method(), url:new URL(req.url()).pathname}); });
    await page.getByRole('button', { name: 'Play reply', exact: true }).click();
    await page.getByRole('button', { name: 'Play reply', exact: true }).waitFor({ state: 'visible' });
    assert(playbackRequests.some(r => r.method === 'GET') && playbackRequests.some(r => r.method === 'HEAD'));
    pass('The user can play an authenticated browser audio reply through an actual HTML audio element');

    const audioRequests = playbackRequests.length;
    await page.clock.setSystemTime(new Date(Date.now() + 24 * 3600 * 1000));
    await page.getByRole('button', { name: 'Repeat', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /expired/i }).waitFor();
    assert.equal(playbackRequests.length, audioRequests);
    await page.clock.setSystemTime(new Date());
    pass('An expired reply is blocked before audio download or playback');

    await page.getByRole('button', { name: 'Change wording', exact: true }).click();
    await page.getByLabel('How should this note read?').fill('My left knee felt sore after my walk.');
    await page.getByRole('button', { name: 'Review changed note', exact: true }).click();
    await page.getByRole('region', { name: 'Review before saving' }).getByText(/My left knee/).first().waitFor();
    assert.equal((await caregiver.dash()).notes.length, 0);
    const start = performance.now();
    await page.getByRole('button', { name: 'Confirm and save', exact: true }).click();
    await caregiver.page.getByRole('heading', { name: 'My left knee felt sore after my walk.', exact: true }).waitFor();
    report.confirm_to_caregiver_ms = Math.round(performance.now() - start);
    const notes = (await owner.dash()).notes; assert.equal(notes.length, 1); assert.equal(notes[0].wording, 'My left knee felt sore after my walk.');
    assert.equal((await restricted.dash()).notes.length, 0);
    await caregiver.page.screenshot({ path: path.join(dir, 'web-caregiver-update.png'), fullPage: true });
    pass('Correction plus explicit confirmation saves one note and automatically updates only its permitted caregiver');

    await capture('dose-report', 'I have not taken my morning example medicine yet.', { intent: 'proposal', kind: 'medication_report',
      payload: { dose_instance_id: fixture.dose_id, report_state: 'reported_not_yet' } });
    assert.equal((await caregiver.dash()).doses.find(d => d.id === fixture.dose_id).report_state, 'unconfirmed');
    await page.getByRole('button', { name: 'Confirm and save', exact: true }).click();
    await page.getByText('Confirmed and saved.', { exact: true }).waitFor();
    assert.equal((await caregiver.dash()).doses.find(d => d.id === fixture.dose_id).report_state, 'reported_not_yet');
    pass('Medication reporting stays unconfirmed until a deliberate save and preserves the exact dose state');

    await capture('support', 'Please ask Jamie to call me this afternoon.', { intent: 'proposal', kind: 'support_request',
      payload: { request_text: 'Please call me this afternoon.', recipient_user_id: fixture.caregiver_id, urgency: 'routine' } });
    await page.getByRole('button', { name: 'Confirm and save', exact: true }).click();
    await page.getByText('Confirmed and saved.', { exact: true }).waitFor();
    const support = (await caregiver.dash()).support_requests[0]; assert(support);
    await caregiver.api('/app/support-requests/' + support.id + '/acknowledge', undefined, 'POST');
    await page.getByRole('button', { name: 'Refresh care details' }).click();
    await page.getByText(/acknowledged/i).first().waitFor();
    pass('A confirmed support request is shared and the caregiver acknowledgement returns to the companion');

    await capture('private-note', 'Keep this note private: I slept poorly.', { intent: 'proposal', kind: 'health_note',
      payload: { wording: 'A private note: I slept poorly.', share_with_user_ids: [] } });
    await page.getByRole('button', { name: 'Confirm and save', exact: true }).click();
    await page.getByText('Confirmed and saved.', { exact: true }).waitFor();
    assert.equal((await owner.dash()).notes.length, 2);
    assert.equal((await caregiver.dash()).notes.length, 1);
    assert.equal((await restricted.dash()).notes.length, 0);
    pass('A private confirmed note stays out of both caregiver responses');

    await page.reload(); await page.getByRole('heading', { name: 'Hello, Mei.', exact: true }).waitFor();
    assert.equal((await currentHome()).device_id, paired.device_id);
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert(!/left knee|slept poorly|Bearer|credential/i.test(storage));
    pass('Reload restores the same browser pairing without persisting care text or bearer credentials in web storage');

    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Horizontal overflow at '+width);
      const button = page.getByRole('button', { name: 'Tap to record', exact: true });
      const box = await button.boundingBox(); assert(box && box.width >= 48 && box.height >= 48);
      await screenshot('web-layout-' + width);
    }
    pass('320/390/768/1440-pixel layouts avoid horizontal overflow and retain the large recording target');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addStyleTag({ content: '.companion-app { font-size: 200% !important; }' });
    await screenshot('web-large-text');
    await page.reload(); await page.getByRole('button', { name: 'Tap to record', exact: true }).waitFor();

    const deniedContext = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, storageState: await phone.storageState() });
    const deniedPage = await deniedContext.newPage(); observe(deniedPage);
    const cdp = await deniedContext.newCDPSession(deniedPage);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, origin, browserContextId: targetInfo.browserContextId, setting: 'denied' });
    let deniedUploads = 0;
    deniedPage.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/v1/web/turns') deniedUploads++; });
    await deniedPage.goto('/companion');
    await deniedPage.getByRole('button', { name: 'Tap to record', exact: true }).click();
    await deniedPage.getByRole('alert').filter({ hasText: /denied|permission|not allowed/i }).waitFor();
    assert.equal(deniedUploads, 0);
    await deniedContext.close();
    pass('Denied microphone permission gives an error without uploading audio');

    await owner.api('/app/devices/' + paired.device_id + '/revoke', undefined, 'POST');
    await page.getByRole('button', { name: 'Refresh care details' }).click();
    await page.getByRole('heading', { name: 'Hello, Mei.', exact: true }).waitFor({ state: 'hidden' });
    assert([401,403].includes((await phone.request.get('/v1/web/home')).status()));
    assert.equal(await page.getByText('My left knee felt sore after my walk.', { exact: true }).count(), 0);
    pass('Owner revocation clears the open companion care view and blocks further patient reads');

    const captures = fs.readFileSync(path.join(dir, 'captures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const uploads = fs.readFileSync(path.join(dir, 'uploads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(captures.length, 4); assert.equal(uploadCount, 4);
    assert(uploads.every(u => u.mime.startsWith('audio/webm') && u.normalized_bytes > 9600));
    assert(captures.every(c => c.channels === 1 && c.sample_width === 2 && c.sample_rate === 16000 && c.frames >= 4800 && c.frames <= 320000));
    report.captures = captures; report.uploads = uploads;
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false; report.failure = error.stack;
    await page.screenshot({ path: path.join(dir, 'web-test-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    for (const file of ['frontend/src/Companion.tsx','frontend/src/companionApi.ts','frontend/src/companion.css','backend/app/web_companion.py','backend/app/phone_audio.py','tools/web_companion_fixture.py','tools/browser_web_companion.cjs'])
      if (fs.existsSync(path.join(root,file))) report.source_sha256[file] = createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
    save(); await browser.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
