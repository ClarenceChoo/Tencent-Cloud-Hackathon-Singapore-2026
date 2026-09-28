/* Destructive token-loss test: ONLY the disposable rooted verification package.
 * No credential is decrypted, copied, restored, printed or written to evidence.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function pairingRecovery({ find, tap, tapNode, ui, adb, screenshot, pass, owner, fixture, directory, appId, report, continueAfterLoss = false }) {
  const root = path.resolve(__dirname, '..');
  assert.equal(appId, 'sg.parse.companion.verification');
  assert.equal(process.env.PARSE_ANDROID_SERIAL || 'emulator-5580', 'emulator-5580');
  assert.equal(fixture.origin, 'https://127.0.0.1:8443');
  assert.equal((await adb('shell', 'getprop', 'ro.kernel.qemu')).trim(), '1');
  assert((await adb('shell', 'id')).includes('uid=0'));
  const apk = path.join(root, 'mobile/android/app/build/outputs/apk/nativeVerification/app-nativeVerification.apk');
  assert.equal(createHash('sha256').update(fs.readFileSync(apk)).digest('hex'), report.installed_apk_sha256);
  const base = '/data/user/0/' + appId;
  const secureFile = base + '/shared_prefs/SecureStore.xml';
  const evidence = report.pairing_recovery = continueAfterLoss ? report.pairing_recovery : { fault: 'Replace only encrypted installation item with invalid JSON, then remove that same item; no credential restoration.' };
  async function until(check, message, attempts = 30) {
    for (let i = 0; i < attempts; i++) { const result = await check(); if (result) return result; await sleep(350); }
    throw new Error(message);
  }
  async function care() {
    const { stdout } = await execute(path.join(root, 'backend/.venv/bin/python'), ['-c', `
import hashlib,json,sqlite3,sys
from pathlib import Path
p=Path(sys.argv[1]); meta=json.loads((p/'fixture.json').read_text())
with sqlite3.connect('file:'+str(p/'fixture.db')+'?mode=ro',uri=True) as db:
 db.row_factory=sqlite3.Row
 assert db.execute("select 1 from patients where id=? and name='Fictional Mei Tan'",(meta['patient_id'],)).fetchone()
 result={}
 for table in ['health_notes','measurements','preventive_tasks','support_requests','followups','voice_turns','confirmation_proposals']:
  rows=[dict(r) for r in db.execute('select * from '+table+' order by id')]
  result[table]={'count':len(rows),'sha256':hashlib.sha256(json.dumps(rows,sort_keys=True,default=lambda v:hashlib.sha256(v).hexdigest()).encode()).hexdigest()}
 result['uploads']=len((p/'native-uploads.jsonl').read_text().splitlines())
 print(json.dumps(result))
`, directory]);
    return JSON.parse(stdout);
  }
  async function scheduled() {
    const xml = await adb('exec-out', 'cat', base + '/shared_prefs/expo.modules.notifications.SharedPreferencesNotificationsStore.xml');
    return [...xml.matchAll(/<string name="notification_request-([^"]+)"/g)].map(m => m[1]).sort();
  }
  const keys = async () => [...(await adb('exec-out', 'cat', secureFile)).matchAll(/<string name="([^"]+)"/g)].map(m => m[1]).sort();
  async function fault(remove) {
    await adb('shell', 'am', 'force-stop', appId);
    const xml = await adb('exec-out', 'cat', secureFile);
    const pattern = /<string name="key_v1-parse\.installation">[^<]*<\/string>/g;
    assert.equal([...xml.matchAll(pattern)].length, 1, 'Expected exactly the installation item');
    const updated = xml.replace(pattern, remove ? '' : '<string name="key_v1-parse.installation">invalid-encrypted-json</string>');
    // Stream bytes to the existing file on the rooted emulator; preserve ownership and
    // SELinux labels. Neither the original XML nor a credential backup is saved.
    await new Promise((resolve, reject) => {
      const child = spawn(path.join(root, 'runtime/android-build/sdk/platform-tools/adb'),
        ['-s', 'emulator-5580', 'shell', 'sh', '-c', "'cat > " + secureFile + "'"],
        { stdio: ['pipe', 'ignore', 'ignore'], timeout: 20000 });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error('Unable to inject the isolated storage fault')));
      child.stdin.on('error', reject);
      child.stdin.end(updated);
    });
    assert.equal(await adb('exec-out', 'cat', secureFile), updated);
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await find('Saved pairing needs attention');
    const nodes = await ui();
    assert(!nodes.some(n => n.text?.startsWith('HELLO, ') || ['Get pairing code', 'Tap to start recording'].includes(n['content-desc'])));
  }
  if (!continueAfterLoss) {
    await tap('Settings'); await tap('Enable alerts');
    await find('Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.');
  }
  const before = await owner.dash();
  const oldId = before.active_companion.device_id;
  assert(before.devices.some(d => d.id === oldId && d.device_type === 'phone' && !d.revoked_at));
  if (continueAfterLoss) {
    assert.deepEqual(before.active_companion, evidence.original_route);
    assert.deepEqual(await care(), evidence.care_before);
    assert.deepEqual(await scheduled(), evidence.scheduled_before);
    assert(!(await keys()).includes('key_v1-parse.installation'));
  } else {
  evidence.care_before = await care(); evidence.original_route = before.active_companion;
  evidence.scheduled_before = await scheduled();
  assert(evidence.scheduled_before.length && evidence.scheduled_before.every(id => id.startsWith('parse.' + oldId + '.')));

  await fault(false);
  await tap('Retry saved pairing');
  await find('Saved pairing needs attention');
  assert((await keys()).includes('key_v1-parse.installation'));
  assert.deepEqual((await owner.dash()).active_companion, before.active_companion);
  await screenshot('native-pairing-unreadable');
  pass('Unreadable native SecureStore pairing blocks patient access and new pairing; Retry preserves the damaged item and server route');

  await fault(true);
  assert(!(await keys()).includes('key_v1-parse.installation'));
  await find("This phone's pairing is missing, but local records from an earlier pairing remain.");
  await screenshot('native-pairing-missing');
  await tap('Reset this phone');
  }
  if (!(await ui()).some(n => n['resource-id'] === 'android:id/button2' && n.text === 'KEEP PAIRING')) await tap('Reset this phone');
  await tap('KEEP PAIRING');
  await find('Saved pairing needs attention');
  assert.deepEqual(await scheduled(), evidence.scheduled_before);
  pass('Deleting only the installation item is recognised as token loss; cancelling reset preserves the recovery gate and original generic schedule');

  await tap('Reset this phone'); await tap('RESET');
  await find('Connect to Parse');
  evidence.secure_keys_after_reset = await keys();
  assert(evidence.secure_keys_after_reset.every(k => k === 'key_v1-parse.interaction-mode'));
  evidence.scheduled_after_reset = await scheduled();
  assert.deepEqual(evidence.scheduled_after_reset, []);
  const alarms = await adb('shell', 'dumpsys', 'alarm');
  assert(!/^\s*(?:RTC|ELAPSED)(?:_WAKEUP)? #\d+: Alarm\{[^\n]*sg\.parse\.companion\.verification\}/m.test(alarms));
  evidence.os_alarms_after_reset = [];
  assert.equal((await adb('shell', 'find', base + '/cache', '-type', 'f', '-name', 'recording-*', '-o', '-name', 'parse-reply-*')).trim(), '');
  assert.deepEqual((await owner.dash()).active_companion, before.active_companion);
  await screenshot('native-pairing-reset');
  pass('Explicit native reset removes local secure care state, scheduled notifications, OS alarms and owned audio without silently releasing the server route');

  await adb('shell', 'am', 'force-stop', appId);
  await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
  await find('Connect to Parse');
  assert.deepEqual(await scheduled(), []);
  await tap('Parse HTTPS service address'); await adb('shell', 'input', 'text', fixture.origin);
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await tap('Get pairing code');
  const code = await until(async () => (await ui()).find(n => n['content-desc']?.startsWith('Pairing code '))?.['content-desc'].slice('Pairing code '.length), 'No replacement pairing code');
  await owner.page.getByLabel('Companion type').selectOption('phone');
  await owner.page.getByLabel('One-use device code').fill(code);
  await owner.page.getByRole('button', { name: 'Approve phone', exact: true }).click();
  await find('HELLO, Mei');
  const fresh = await until(async () => (await owner.dash()).devices.find(d => d.device_type === 'phone' && !before.devices.some(old => old.id === d.id)), 'No new phone identity');
  evidence.new_device_id = fresh.id;
  assert.notEqual(fresh.id, oldId);
  assert.deepEqual((await owner.dash()).active_companion, before.active_companion);
  assert.deepEqual(await scheduled(), []);
  pass('Reset survives process restart; native enrollment plus owner-browser approval creates a new identity without borrowing the old credential or changing selection');

  const oldCard = owner.page.locator('article.paired-device').filter({ has: owner.page.getByText(oldId, { exact: true }) });
  await oldCard.getByRole('button', { name: 'Revoke device access', exact: true }).click();
  await owner.page.getByRole('dialog').getByRole('button', { name: 'Revoke access', exact: true }).click();
  await oldCard.getByText('Access revoked', { exact: true }).first().waitFor();
  assert.equal((await owner.dash()).active_companion.device_id, oldId);
  const finish = owner.page.getByRole('button', { name: 'Finish removing this phone', exact: true });
  assert(await finish.isDisabled());
  await owner.page.getByLabel('I have uninstalled Parse or cleared its app data on the old phone.', { exact: true }).check();
  await finish.click();
  const paused = await until(async () => { const d = await owner.dash(); return d.active_companion.device_id === null ? d : null; }, 'Removal did not pause reminders');
  assert.equal(paused.active_companion.generation, before.active_companion.generation + 1);
  evidence.paused_route = paused.active_companion;
  await owner.page.getByLabel('Send reminders to').selectOption(fresh.id);
  await owner.page.getByRole('button', { name: 'Save reminder companion', exact: true }).click();
  await tap('Settings'); await tap('Enable alerts');
  await find('Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.');
  evidence.scheduled_after = await until(async () => { const ids = await scheduled(); return ids.length ? ids : null; }, 'Replacement schedule did not appear');
  const after = await owner.dash();
  assert.equal(after.active_companion.device_id, fresh.id);
  assert.equal(after.active_companion.generation, before.active_companion.generation + 2);
  assert(evidence.scheduled_after.every(id => id.startsWith('parse.' + fresh.id + '.') && id.endsWith('.g' + after.active_companion.generation)));
  evidence.final_route = after.active_companion; evidence.care_after = await care();
  assert.deepEqual(evidence.care_after, evidence.care_before);
  await screenshot('native-pairing-replacement');
  pass('After completed local reset, owner revocation and removal acknowledgement release the old route; separate selection schedules only the replacement generation with all care and uploads unchanged');
};
