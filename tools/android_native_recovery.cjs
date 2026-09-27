/* Native recovery through the isolated loopback TLS fault proxy, never a live service. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function recovery({ arm, find, tap, ui, adb, screenshot, pass, owner, caregiver, restricted, fixture, directory, appId, report, receiptFault }) {
  const root = path.resolve(__dirname, '..');
  const readLines = name => {
    const file = path.join(directory, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  function setMode(value) {
    const temporary = path.join(directory, 'fault-mode.driver.tmp');
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, 'fault-mode.json'));
  }
  async function turns() {
    const { stdout } = await execute(path.join(root, 'backend/.venv/bin/python'),
      [path.join(root, 'tools/android_native_control.py'), 'inspect', '--kind', 'turns', '--data-dir', directory], { timeout: 20000 });
    return JSON.parse(stdout).turns;
  }
  async function waitFor(check, message, attempts = 30) {
    for (let i = 0; i < attempts; i++) {
      const result = await check();
      if (result) return result;
      await sleep(500);
    }
    throw new Error(message);
  }
  async function restart(expectHome = true) {
    await adb('shell', 'am', 'force-stop', appId);
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await find(expectHome ? 'HELLO, Mei' : 'parse');
  }
  assert((await adb('shell', 'id')).includes('uid=0'), 'Disposable emulator cache inspection requires adb root');
  const before = await turns();
  const beforeIds = new Set(before.map(t => t.id));
  const notesBefore = (await owner.dash()).notes.length;
  const uploadCount = readLines('native-uploads.jsonl').length;
  const eventCount = readLines('fault-events.jsonl').length;
  const wording = 'Fictional recovered ' + receiptFault + ' note ' + Date.now();
  report.fault = receiptFault;
  report.emulatorAdbRoot = true;
  report.initial_turn_count = before.length;
  const cache = '/data/user/0/' + appId + '/cache';
  try {
    setMode({});
    await adb('reverse', 'tcp:8443', 'tcp:8444');
    // Close connections created before the reverse mapping changed.
    await restart();
    setMode({ next_receipt_fault: receiptFault });
    await find('HELLO, Mei');
    arm('native-lost-receipt-' + receiptFault, { intent: 'proposal', kind: 'health_note', payload: {
      wording, share_with_user_ids: [fixture.caregiver_id],
    } });
    await tap('Tap to start recording');
    await find('Tap to finish', { scroll: false });
    await sleep(1000);
    await tap('Recording. Tap to send.', { scroll: false });
    const interrupted = await waitFor(() => readLines('fault-events.jsonl').slice(eventCount)
      .find(e => e.kind === 'accepted_receipt_interrupted' && e.fault === receiptFault), 'Proxy did not intercept an actual accepted upload');
    report.interruption = interrupted;
    await find('Recover response');
    const feedback = (await ui()).find(n => n['resource-id']?.endsWith('voice-feedback'))?.text;
    assert(feedback && !feedback.includes('Saved.'), 'Failed receipt must not claim the note was saved');
    report.interrupted_feedback = feedback;
    await screenshot('native-receipt-' + receiptFault + '-interrupted');
    assert.equal((await owner.dash()).notes.length, notesBefore);
    assert.equal(readLines('native-uploads.jsonl').length, uploadCount + 1);
    const received = (await turns()).filter(t => !beforeIds.has(t.id));
    assert.equal(received.length, 1);
    assert.equal(received[0].id, interrupted.turn_id);
    assert.equal((await adb('shell', 'find', cache, '-type', 'f', '-name', 'recording-*')).trim(), '');
    pass('Accepted upload with lost ' + receiptFault + ' receipt shows failure, removes cache audio and commits no note');

    // Restart while still offline: protected pending identity must survive it.
    await restart(false);
    assert(!(await ui()).some(n => n['content-desc'] === 'Tap to start recording'), 'Offline cold start must not offer capture before current care loads');
    await screenshot('native-receipt-' + receiptFault + '-offline-restart');
    assert.equal((await owner.dash()).notes.length, notesBefore);
    setMode({});
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await find('Have I got that right?');
    const lookup = await waitFor(() => readLines('fault-events.jsonl').slice(eventCount)
      .find(e => e.kind === 'receipt_lookup' && e.upstream_status === 200 && e.turn_id === interrupted.turn_id),
    'Native restart did not recover the original accepted turn by its receipt key');
    report.recovered_receipt = lookup;
    assert.equal((await turns()).length, before.length + 1);
    assert.equal(readLines('native-uploads.jsonl').length, uploadCount + 1);
    assert.equal((await owner.dash()).notes.length, notesBefore);
    pass('Native reconnect after offline restart recovers the same turn without reupload or automatic confirmation');

    await tap('Confirm and save');
    const saved = await waitFor(async () => (await owner.dash()).notes.find(n => n.wording === wording), 'Native confirmation did not save recovered note');
    assert.equal(saved.provenance.type, 'phone');
    assert.equal((await owner.dash()).notes.length, notesBefore + 1);
    assert(!(await restricted.dash()).notes.some(n => n.wording === wording));
    await caregiver.page.getByRole('heading', { name: wording, exact: true }).waitFor();
    await restart();
    assert.equal((await owner.dash()).notes.filter(n => n.wording === wording).length, 1);
    assert.equal((await turns()).length, before.length + 1);
    const finalTurn = (await turns()).find(t => t.id === interrupted.turn_id);
    assert.equal(finalTurn.raw_audio_retained, false);
    report.recovered_turn = finalTurn;
    await caregiver.page.screenshot({ path: path.join(directory, 'native-recovery-' + receiptFault + '-caregiver.png'), fullPage: true });
    pass('Explicit native confirmation saves one recovered note for the permitted caregiver; restart adds no turn or fact');
  } finally {
    setMode({});
    await adb('reverse', 'tcp:8443', 'tcp:8443');
  }
};
