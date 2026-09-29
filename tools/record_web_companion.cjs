/* Fictional local demo. Records the real companion and dashboard UI side by side. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'runtime/web-demo-20260929');
const fixtureDir = path.resolve(process.env.PARSE_WEB_FIXTURE_DIR || path.join(output, 'fixture'));
assert(fixtureDir.startsWith(output + path.sep));
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fixture.json'), 'utf8'));
const origin = fixture.origin;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assert.equal(origin, 'http://127.0.0.1:5191');
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: [
    '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=' + path.join(fixtureDir, 'microphone.wav'),
  ] });
  const rawDir = path.join(output, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const phone = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 },
    permissions: ['microphone'], recordVideo: { dir: rawDir, size: { width: 390, height: 844 } } });
  const dashboard = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: rawDir, size: { width: 1440, height: 1000 } } });
  const phonePage = await phone.newPage();
  const dashPage = await dashboard.newPage();
  phonePage.setDefaultTimeout(20000);
  dashPage.setDefaultTimeout(20000);
  const errors = [];
  for (const page of [phonePage, dashPage]) page.on('pageerror', e => errors.push(e.message));
  const started = performance.now();
  const events = [];
  const mark = caption => { events.push({ seconds: (performance.now() - started) / 1000, caption }); console.log(caption); };
  const arm = (name, transcript, interpretation) => {
    const file = path.join(fixtureDir, 'next-utterance.json');
    assert(!fs.existsSync(file), 'Previous speech scenario is still armed');
    fs.writeFileSync(file, JSON.stringify({ name, transcript, interpretation }), { mode: 0o600 });
  };
  async function login(role) {
    await dashPage.getByLabel('Email address').fill(role + '@web.invalid');
    await dashPage.getByLabel('Password', { exact: true }).fill('fictional-web-only');
    await dashPage.getByRole('button', { name: /^Continue/ }).click();
    await dashPage.getByRole('heading', { name: /care timeline/i }).waitFor();
  }
  async function record(name, transcript, interpretation) {
    arm(name, transcript, interpretation);
    await phonePage.getByRole('button', { name: 'Tap to record', exact: true }).click();
    await phonePage.getByRole('button', { name: 'Tap to send', exact: true }).waitFor();
    await sleep(1250);
    await phonePage.getByRole('button', { name: 'Tap to send', exact: true }).click();
    await phonePage.getByRole('region', { name: 'Review before saving' }).waitFor();
    assert(!fs.existsSync(path.join(fixtureDir, 'next-utterance.json')));
  }
  try {
    mark('A browser companion beside the shared care dashboard');
    await Promise.all([phonePage.goto('/companion'), dashPage.goto('/')]);
    await sleep(2500);
    await login('owner');
    await sleep(2600);

    mark('Connect this browser with a private pairing code');
    await phonePage.getByRole('button', { name: 'Connect this browser', exact: true }).click();
    const code = (await phonePage.locator('.companion-code').textContent()).trim();
    assert.match(code, /^P-[A-F0-9]{5}-[A-F0-9]{5}$/);
    await sleep(2200);
    await dashPage.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await dashPage.getByLabel('Companion type').selectOption('browser');
    await dashPage.getByLabel('One-use device code').fill(code);
    await sleep(2200);
    mark('The care-space owner approves this browser');
    await dashPage.getByRole('button', { name: 'Approve browser', exact: true }).click();
    await phonePage.getByRole('button', { name: 'Check connection', exact: true }).click();
    await phonePage.getByRole('heading', { name: 'Hello, Mei.', exact: true }).waitFor();
    await sleep(2800);

    mark('Jamie opens the caregiver view');
    await dashPage.getByRole('button', { name: 'Sign out' }).click();
    await login('caregiver');
    await sleep(3300);

    mark('Mei records a note using the browser microphone');
    await record('demo-knee-note', 'My left knee felt sore after my walk. Please tell Jamie.', {
      intent: 'proposal', kind: 'health_note', payload: {
        wording: 'My left knee felt sore after my walk.', occurrence_text: 'after my walk',
        share_with_user_ids: [fixture.caregiver_id],
      },
    });
    await sleep(1800);
    mark('The read-back is still a draft until Mei confirms it');
    assert.equal((await dashboard.request.get('/v1/app/patients/' + fixture.patient_id + '/dashboard')).status(), 200);
    await sleep(3500);
    await phonePage.getByRole('button', { name: 'Confirm and save', exact: true }).click();
    await phonePage.getByText('Confirmed and saved.', { exact: true }).waitFor();
    await dashPage.getByRole('heading', { name: 'My left knee felt sore after my walk.', exact: true }).waitFor();
    mark('One confirmed note appears automatically for Jamie');
    await sleep(5200);

    await dashPage.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Medications', exact: true }).click();
    await sleep(1600);
    mark('Mei reports the status of a fictional scheduled medicine');
    await record('demo-dose-report', 'I have not taken my morning example medicine yet.', {
      intent: 'proposal', kind: 'medication_report', payload: {
        dose_instance_id: fixture.dose_id, report_state: 'reported_not_yet',
      },
    });
    await sleep(2900);
    mark('The medicine update also waits for explicit confirmation');
    await phonePage.getByRole('button', { name: 'Confirm and save', exact: true }).click();
    await phonePage.getByText('Confirmed and saved.', { exact: true }).waitFor();
    await sleep(3500);
    mark('The shared medicine timeline shows “not yet”');
    const session = await (await dashboard.request.get('/v1/auth/session')).json();
    const response = await dashboard.request.get('/v1/app/patients/' + fixture.patient_id + '/dashboard');
    assert(response.ok());
    const care = await response.json();
    assert.equal(care.notes.length, 1);
    assert.equal(care.notes[0].wording, 'My left knee felt sore after my walk.');
    assert.equal(care.doses.find(d => d.id === fixture.dose_id).report_state, 'reported_not_yet');
    assert(session.user.email === 'caregiver@web.invalid');
    await sleep(4300);

    mark('Care records change only after deliberate confirmation');
    const elapsed = (performance.now() - started) / 1000;
    if (elapsed < 68) await sleep((68 - elapsed) * 1000);
    assert.deepEqual(errors, []);
    events.push({ seconds: (performance.now() - started) / 1000, caption: '' });
    console.log('Recorded ' + events.at(-1).seconds.toFixed(1) + ' seconds');
  } catch (error) {
    fs.writeFileSync(path.join(output, 'record-failure.txt'), String(error.stack || error));
    await phonePage.screenshot({ path: path.join(output, 'record-phone-failure.png') }).catch(() => {});
    await dashPage.screenshot({ path: path.join(output, 'record-dashboard-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await Promise.all([phone.close(), dashboard.close()]);
    const phoneVideo = await phonePage.video().path();
    const dashboardVideo = await dashPage.video().path();
    fs.renameSync(phoneVideo, path.join(output, 'phone.webm'));
    fs.renameSync(dashboardVideo, path.join(output, 'dashboard.webm'));
    fs.writeFileSync(path.join(output, 'timeline.json'), JSON.stringify({ events, errors,
      scope: 'Fictional local data. Actual browser MediaRecorder upload; scripted interpretation and tone replies.' }, null, 2));
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
