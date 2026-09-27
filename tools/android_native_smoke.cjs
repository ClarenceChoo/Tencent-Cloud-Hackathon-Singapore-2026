/* Actual Android native modules + real API/browser; scripted ASR/TTS, emulator only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const directory = path.resolve(process.env.PARSE_NATIVE_FIXTURE_DIR || '');
const serial = process.env.PARSE_ANDROID_SERIAL || 'emulator-5580';
const appId = 'sg.parse.companion.verification';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const decode = value => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function main() {
  const alertState = process.env.PARSE_NATIVE_ALERT_STATE || '';
  assert(['', 'locked', 'terminated', 'offline-plan', 'revoked', 'offline-revoked'].includes(alertState));
  const alertLifecycle = !!alertState;
  const connectionOnly = process.env.PARSE_NATIVE_CONNECTION_ONLY === '1';
  const callsOnly = process.env.PARSE_NATIVE_CALLS_ONLY === '1';
  const largeTextOnly = process.env.PARSE_NATIVE_LARGE_TEXT_ONLY === '1';
  const recoveryOnly = process.env.PARSE_NATIVE_RECOVERY_ONLY === '1';
  const receiptFault = process.env.PARSE_NATIVE_RECEIPT_FAULT || 'disconnect';
  assert(['disconnect', '503'].includes(receiptFault));
  const confirmationOnly = process.env.PARSE_NATIVE_CONFIRMATION_ONLY === '1';
  const lifecycleOnly = process.env.PARSE_NATIVE_LIFECYCLE_ONLY === '1' || confirmationOnly;
  const alertsOnly = process.env.PARSE_NATIVE_ALERTS_ONLY === '1';
  const remindersOnly = process.env.PARSE_NATIVE_REMINDERS_ONLY === '1' || alertsOnly;
  assert([lifecycleOnly, remindersOnly, recoveryOnly, alertLifecycle, connectionOnly, callsOnly, largeTextOnly].filter(Boolean).length <= 1, 'Select one native verification mode');
  assert(directory.startsWith(path.join(root, 'runtime') + path.sep));
  assert(/^emulator-\d+$/.test(serial), 'This fixture runs only on a disposable emulator');
  const fixture = JSON.parse(fs.readFileSync(path.join(directory, 'fixture.json')));
  assert.equal(new URL(fixture.origin).hostname, '127.0.0.1');
  const sdk = process.env.ANDROID_HOME || path.join(root, 'runtime/android-build/sdk');
  const adbEnv = { ...process.env, ANDROID_USER_HOME: path.join(root, 'runtime/android-build/android-user') };
  async function adb(...args) {
    return (await execute(path.join(sdk, 'platform-tools/adb'), ['-s', serial, ...args],
      { env: adbEnv, timeout: 25000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  }
  async function ui() {
    await adb('shell', 'uiautomator', 'dump', '--compressed', '/sdcard/parse-native-ui.xml');
    const xml = await adb('exec-out', 'cat', '/sdcard/parse-native-ui.xml');
    fs.writeFileSync(path.join(directory, 'last-native-ui.xml'), xml);
    return [...xml.matchAll(/<node\b[^>]*>/g)].map(match => Object.fromEntries(
      [...match[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)])));
  }
  function bounds(node) {
    const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number);
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), x1, y1, x2, y2 };
  }
  async function tapNode(node) {
    assert.equal(node.enabled, 'true');
    const { x, y } = bounds(node);
    await adb('shell', 'input', 'tap', String(x), String(y));
  }
  async function find(label, { scroll = true, attempts = 8 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const nodes = await ui();
      const node = nodes.find(n => n['content-desc'] === label || n.text === label);
      if (node && bounds(node).y2 > bounds(node).y1 && node.enabled === 'true') return node;
      if (scroll) {
        const up = attempt < 2;
        await adb('shell', 'input', 'swipe', '950', up ? '650' : '1850', '950', up ? '1850' : '650', '350');
      } else await sleep(250);
    }
    throw new Error('Native control unavailable: ' + label);
  }
  async function tap(label, options) { await tapNode(await find(label, options)); }
  async function screenshot(name) {
    const { stdout } = await execute(path.join(sdk, 'platform-tools/adb'), ['-s', serial, 'exec-out', 'screencap', '-p'],
      { env: adbEnv, encoding: 'buffer', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    fs.writeFileSync(path.join(directory, name + '.png'), stdout);
    await ui();
    fs.copyFileSync(path.join(directory, 'last-native-ui.xml'), path.join(directory, name + '.xml'));
  }
  function arm(name, interpretation) {
    const pending = path.join(directory, 'next-utterance.json');
    assert(!fs.existsSync(pending), 'Previous fixture utterance has not been consumed');
    const transcript = typeof interpretation === 'string' ? interpretation : 'FIXTURE:' + JSON.stringify(interpretation);
    fs.writeFileSync(pending + '.tmp', JSON.stringify({ name, transcript }), { mode: 0o600 });
    fs.renameSync(pending + '.tmp', pending);
  }
  async function record(name, interpretation, expectedText = interpretation.payload?.wording) {
    await find('HELLO, Mei');
    arm(name, interpretation);
    await tap('Tap to start recording');
    let nodes = await ui();
    const permission = nodes.find(n => n['resource-id']?.endsWith('/permission_allow_foreground_only_button'));
    if (permission) {
      await tapNode(permission);
      nodes = await ui();
      if (!nodes.some(n => n.text === 'Tap to finish')) {
        await find('Recording did not start. Choose the talk button again when you are ready.');
        await screenshot('native-permission-retry');
        await tap('Tap to start recording');
        nodes = await ui();
      }
    }
    assert(nodes.some(n => n.text === 'Tap to finish'), 'Native recorder did not reach the recording phase');
    await sleep(1000);
    await tap('Recording. Tap to send.', { scroll: false, attempts: 2 });
    await find('Tap to start recording', { attempts: 10 });
    const settled = await ui();
    assert(!settled.some(n => n['content-desc'] === 'Recover response' || n.text === 'Recover response'),
      'Native voice returned an error: ' + settled.map(n => n.text).filter(Boolean).join(' | '));
    assert(!fs.existsSync(path.join(directory, 'next-utterance.json')), 'Native audio did not reach scripted provider');
    const feedback = settled.find(n => n['resource-id']?.endsWith('voice-feedback'))?.text;
    assert(feedback, 'Native response feedback must be visible after playback');
    assert(expectedText && feedback.toLowerCase().includes(expectedText.toLowerCase()), `Unexpected native feedback for ${name}: ${feedback}`);
    return feedback;
  }
  const report = { at: new Date().toISOString(), liveSpeech: false, physicalPhone: false,
    environment: 'Actual native Android modules in an AOSP Android 16 emulator with host audio disabled; local HTTPS/API and real caregiver browsers; scripted interpretation and fixture tone replies. No real speech or acoustic audibility evidence.',
    source_sha256: Object.fromEntries(['mobile/src/App.tsx', 'mobile/src/useVoice.ts', 'mobile/src/api.ts', 'mobile/src/storage.ts', 'tools/android_native_fixture.py', 'tools/android_native_smoke.cjs', 'tools/android_native_care.cjs', ...(lifecycleOnly ? ['tools/android_native_lifecycle.cjs'] : []), ...(remindersOnly ? ['tools/android_native_reminders.cjs', 'tools/android_native_control.py'] : []), ...(alertLifecycle ? ['mobile/src/useReminders.ts', 'mobile/src/alertSchedule.ts', 'tools/android_native_alert_lifecycle.cjs', 'tools/android_native_revocation.cjs', 'tools/android_native_fault_proxy.py', 'tools/android_native_control.py'] : []), ...(recoveryOnly ? ['tools/android_native_recovery.cjs', 'tools/android_native_fault_proxy.py', 'tools/android_native_control.py'] : [])].map(file =>
      [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    checks: [] };
  if (connectionOnly) {
    for (const file of ['tools/android_native_connection.cjs', 'tools/android_native_fault_proxy.py'])
      report.source_sha256[file] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
  if (callsOnly) {
    for (const file of ['tools/android_native_calls.cjs', 'tools/android_native_control.py'])
      report.source_sha256[file] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
  if (largeTextOnly) {
    for (const file of ['mobile/src/useTalkMode.ts', 'tools/android_native_large_text.cjs'])
      report.source_sha256[file] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
  const save = () => fs.writeFileSync(path.join(directory, largeTextOnly ? 'native-large-text-evidence.json' : callsOnly ? 'native-calls-evidence.json' : connectionOnly ? 'native-connection-evidence.json' : alertLifecycle ? `native-alert-${alertState}-evidence.json` : recoveryOnly ? `native-recovery-${receiptFault}-evidence.json` : alertsOnly ? 'native-alerts-evidence.json' : confirmationOnly ? 'native-confirmation-evidence.json' : lifecycleOnly ? 'native-lifecycle-evidence.json' : remindersOnly ? 'native-reminders-evidence.json' : 'native-integration-evidence.json'), JSON.stringify(report, null, 2));
  const pass = name => { report.checks.push({ name, passed: true }); save(); console.log('PASS ' + name); };
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  async function login(role) {
    // This isolated browser context visits only the known loopback test origin.
    const context = await browser.newContext({ baseURL: fixture.origin, ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto('/');
    await page.getByLabel('Email address').fill(role + '@native.invalid');
    await page.getByLabel('Password', { exact: true }).fill('fictional-native-only');
    await page.getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('heading', { name: /care timeline/i }).waitFor();
    const session = await (await context.request.get('/v1/auth/session')).json();
    const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
      const response = await context.request.fetch('/v1' + route, { method,
        headers: { Origin: fixture.origin, 'X-CSRF-Token': session.csrf_token }, ...(data === undefined ? {} : { data }) });
      assert(response.ok(), `Browser HTTP ${response.status()} ${route}`);
      return response.status() === 204 ? undefined : response.json();
    };
    return { context, page, api, dash: () => api(`/app/patients/${fixture.patient_id}/dashboard`) };
  }
  try {
    await adb('reverse', `tcp:${new URL(fixture.origin).port}`, `tcp:${new URL(fixture.origin).port}`);
    const installedPath = (await adb('shell', 'pm', 'path', appId)).trim().replace(/^package:/, '');
    assert(installedPath.startsWith('/data/app/') && installedPath.endsWith('/base.apk') && !installedPath.includes('\n'));
    report.installed_apk_sha256 = (await adb('shell', 'sha256sum', installedPath)).split(/\s/)[0];
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    let code;
    const resume = process.env.PARSE_NATIVE_RESUME_PAIRED === '1';
    assert(!(lifecycleOnly || remindersOnly || recoveryOnly || alertLifecycle || connectionOnly || callsOnly || largeTextOnly) || resume, 'These checks require an existing fictional verification installation');
    report.mode = largeTextOnly ? 'large-text' : callsOnly ? 'calls' : connectionOnly ? 'connection' : alertLifecycle ? 'alert-' + alertState : recoveryOnly ? 'recovery-' + receiptFault : alertsOnly ? 'alerts' : confirmationOnly ? 'confirmation' : lifecycleOnly ? 'lifecycle' : remindersOnly ? 'reminders' : 'care';
    report.enrollmentCreatedInThisRun = !resume;
    if (!resume) {
      await tap('Parse HTTPS service address');
      await adb('shell', 'input', 'text', fixture.origin);
      await adb('shell', 'input', 'keyevent', '4');
      await tap('Get pairing code');
      for (let i = 0; i < 8 && !code; i++) {
        const node = (await ui()).find(n => n['content-desc']?.startsWith('Pairing code '));
        code = node?.['content-desc'].slice('Pairing code '.length);
      }
      assert(code, 'Native HTTPS enrollment did not show a pairing code');
    }
    const owner = await login('owner');
    const caregiver = await login('caregiver');
    const restricted = await login('restricted');
    await owner.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
    if (!resume) {
      await owner.page.getByLabel('Companion type').selectOption('phone');
      await owner.page.getByLabel('One-use device code').fill(code);
      await owner.page.getByRole('button', { name: 'Approve phone', exact: true }).click();
    }
    await owner.page.getByRole('heading', { name: 'Parse phone · Parse Android', exact: true }).first().waitFor();
    const dashboard = await owner.dash();
    const device = dashboard.devices.find(d => d.device_type === 'phone' && !d.revoked_at);
    assert(device);
    if (dashboard.active_companion.device_id !== device.id) {
      await owner.page.getByLabel('Send reminders to').selectOption(device.id);
      await owner.page.getByRole('button', { name: 'Save reminder companion', exact: true }).click();
    }
    await owner.page.getByText('Selected reminder companion', { exact: true }).waitFor();
    await find('HELLO, Mei');
    pass(resume ? 'Resumed previously paired native verification installation' :
      'Native-generated secure identity pairs over verified local TLS through owner browser approval');
    const tapSwitch = await find('Use tap instead of hold to record');
    if (tapSwitch.checked !== 'true') await tapNode(tapSwitch);
    if (largeTextOnly) {
      await require('./android_native_large_text.cjs')({ arm, ui, adb, tapNode, screenshot, pass, owner, caregiver, restricted, fixture, directory, appId, report });
      save();
      return;
    }
    if (callsOnly) {
      await require('./android_native_calls.cjs')({ find, tap, ui, adb, screenshot, pass, owner, directory, appId, report });
      save();
      return;
    }
    if (connectionOnly) {
      await require('./android_native_connection.cjs')({ find, tapNode, ui, adb, screenshot, pass, owner, directory, appId, report });
      save();
      return;
    }
    if (alertLifecycle) {
      await require('./android_native_alert_lifecycle.cjs')({ find, tap, tapNode, ui, adb, screenshot, pass, owner, fixture, directory, appId, report, alertState });
      save();
      return;
    }
    if (recoveryOnly) {
      await require('./android_native_recovery.cjs')({ arm, find, tap, ui, adb, screenshot, pass, owner, caregiver, restricted, fixture, directory, appId, report, receiptFault });
      save();
      return;
    }
    if (lifecycleOnly) {
      await require('./android_native_lifecycle.cjs')({ record, arm, find, tap, tapNode, ui, adb, screenshot, pass, owner, caregiver, restricted, fixture, directory, appId, report, confirmationOnly });
      save();
      return;
    }
    if (remindersOnly) {
      await require('./android_native_reminders.cjs')({ find, tap, tapNode, ui, adb, screenshot, pass, owner, fixture, directory, appId, report, alertsOnly });
      save();
      return;
    }
    const proposal = wording => ({ intent: 'proposal', kind: 'health_note', payload: {
      wording, occurrence_text: 'after a fictional walk', share_with_user_ids: [fixture.caregiver_id] } });
    await record('original', proposal('Fictional native right knee concern'));
    await find('Have I got that right?');
    assert.equal((await caregiver.dash()).notes.length, 0);
    pass('Native AAC recording reaches normalization and returns an unsaved proposal through native playback');
    await record('correction', { intent: 'correct', payload: {
      wording: 'Fictional native left knee concern', occurrence_text: 'after a fictional walk', share_with_user_ids: [fixture.caregiver_id] } });
    await find('Have I got that right?');
    await screenshot('native-corrected-proposal');
    await tap('Confirm and save');
    await caregiver.page.getByRole('heading', { name: 'Fictional native left knee concern', exact: true }).waitFor();
    const notes = (await owner.dash()).notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].wording, 'Fictional native left knee concern');
    assert.equal(notes[0].provenance.type, 'phone');
    assert.equal((await restricted.dash()).notes.length, 0);
    await restricted.page.waitForResponse(r => r.ok() && new URL(r.url()).pathname.endsWith('/dashboard'));
    assert.equal(await restricted.page.getByText('Fictional native left knee concern', { exact: true }).count(), 0);
    await caregiver.page.screenshot({ path: path.join(directory, 'native-caregiver-confirmed.png'), fullPage: true });
    pass('Native correction and explicit confirmation save exactly one phone-sourced note in the permitted already-open caregiver dashboard');
    await adb('shell', 'am', 'force-stop', appId);
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await find('HELLO, Mei');
    assert.equal((await owner.dash()).notes.length, 1);
    await screenshot('native-paired-restart');
    pass('Native protected pairing survives process termination without repeating the confirmed record');
    if (process.env.PARSE_NATIVE_FULL_CARE === '1') {
      await require('./android_native_care.cjs')({ record, find, tap, screenshot, pass, owner, caregiver, restricted, fixture });
    }
    report.captures = fs.readFileSync(path.join(directory, 'native-captures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    save();
  } catch (error) {
    report.failure = String(error); save();
    try { await screenshot('native-failure'); } catch {}
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
