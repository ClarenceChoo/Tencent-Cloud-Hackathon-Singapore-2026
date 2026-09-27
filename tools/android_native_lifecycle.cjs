/* Real Android lifecycle operations on the disposable verification emulator only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function lifecycle({ record, arm, find, tap, tapNode, ui, adb, screenshot, pass, owner, caregiver, fixture, directory, appId, report }) {
  const uploads = () => fs.readFileSync(path.join(directory, 'native-uploads.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  const baselineUploads = uploads();
  const baselineNotes = (await owner.dash()).notes.length;
  const cache = '/data/user/0/' + appId + '/cache';
  assert((await adb('shell', 'id')).includes('uid=0'), 'Cache verification needs adb root on this disposable emulator');
  report.emulatorAdbRoot = true;
  async function cachedAudio() {
    return (await adb('shell', 'find', cache, '-type', 'f', '-name', 'recording-*')).trim().split('\n').filter(Boolean);
  }
  async function start() {
    // Bring the whole control into view; a clipped sliver is tappable but its
    // child label can have zero bounds in Android's accessibility tree.
    await find('HELLO, Mei');
    await tap('Tap to start recording');
    await find('Tap to finish', { scroll: false });
  }
  async function foreground() {
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await find('Tap to start recording');
  }
  async function assertUnsent() {
    assert.equal(uploads(), baselineUploads, 'Cancelled/interrupted capture must never upload');
    assert.equal((await owner.dash()).notes.length, baselineNotes);
    assert.equal((await cachedAudio()).length, 0, 'Transient recording remains in native cache');
  }
  await start();
  await adb('shell', 'input', 'swipe', '950', '1850', '950', '650', '350');
  await tap('Cancel recording', { scroll: false });
  await find('Tap to start recording');
  await assertUnsent();
  pass('Native Cancel stops recording, removes its cache file and sends no upload');

  await start();
  await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(700);
  await foreground();
  await assertUnsent();
  pass('Native backgrounding cancels capture without upload or automatic restart');

  await start();
  await adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
  const power = await adb('shell', 'dumpsys', 'power');
  assert(/mWakefulness=(Asleep|Dozing)/.test(power), 'Emulator did not enter sleep');
  await sleep(700);
  await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  await adb('shell', 'wm', 'dismiss-keyguard');
  await foreground();
  await assertUnsent();
  pass('Native screen sleep cancels capture; waking does not resume recording');

  await start();
  await adb('shell', 'am', 'force-stop', appId);
  const orphaned = await cachedAudio();
  assert(orphaned.length > 0, 'Kill scenario did not leave a recording to exercise startup cleanup');
  report.orphaned_before_reopen = orphaned.map(file => path.relative(cache, file));
  await foreground();
  await assertUnsent();
  pass('Native restart after a killed recording sweeps orphaned cache audio and never uploads it');

  await start();
  await adb('shell', 'pm', 'revoke', appId, 'android.permission.RECORD_AUDIO');
  await foreground();
  await assertUnsent();
  await tap('Tap to start recording');
  let nodes = await ui();
  const deny = nodes.find(n => /\/permission_deny_(?:and_dont_ask_again_)?button$/.test(n['resource-id'] || ''));
  report.microphone_denial_dialog = Boolean(deny);
  if (deny) await tapNode(deny);
  else assert(nodes.some(n => n.text === 'Microphone access is off. Enable it in your phone settings to speak to Parse.'),
    'Expected a permission dialog or the previously denied state');
  await find('Microphone access is off. Enable it in your phone settings to speak to Parse.');
  await assertUnsent();
  await screenshot('native-microphone-denied');
  pass('Revoked microphone access stops native capture and denial is visible without uploading');
  // Restore the existing grant only on this disposable fixture for subsequent checks.
  await adb('shell', 'pm', 'grant', appId, 'android.permission.RECORD_AUDIO');
  await foreground();
  arm('lifecycle-duration-ceiling', { intent: 'chat', spoken_text: 'Ceiling test response.' });
  await start();
  await find('Tap to start recording', { scroll: false, attempts: 16 });
  const capped = JSON.parse(fs.readFileSync(path.join(directory, 'native-captures.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(capped.scenario, 'lifecycle-duration-ceiling');
  assert(capped.frames >= 280000 && capped.frames <= 320000, 'Native recording must stop by 20 seconds');
  assert.equal(uploads(), baselineUploads + 1);
  assert.equal((await cachedAudio()).length, 0);
  report.duration_ceiling_capture = capped;
  pass('Native recording automatically ends within 20 seconds and uploads one bounded turn');
  const wording = 'Fictional spoken confirmation ' + Date.now();
  await record('lifecycle-note', { intent: 'proposal', kind: 'health_note', payload: { wording,
    share_with_user_ids: [fixture.caregiver_id] } }, wording);
  assert.equal((await owner.dash()).notes.length, baselineNotes);
  await record('lifecycle-spoken-confirmation', { intent: 'confirm' }, 'Saved.');
  const notes = (await owner.dash()).notes;
  assert.equal(notes.length, baselineNotes + 1);
  assert.equal(notes.filter(n => n.wording === wording).length, 1);
  assert.equal(notes.find(n => n.wording === wording).provenance.type, 'phone');
  await caregiver.page.getByRole('heading', { name: wording, exact: true }).waitFor();
  await adb('shell', 'am', 'force-stop', appId);
  await foreground();
  assert.equal((await owner.dash()).notes.length, baselineNotes + 1);
  assert.equal((await cachedAudio()).length, 0);
  pass('Native recorded yes-confirmation saves one shared phone-sourced note and does not repeat after restart');
};
