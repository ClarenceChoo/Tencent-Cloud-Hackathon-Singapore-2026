/* Actual uninstall/reinstall of only the disposable verification package. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function reinstall({ find, tap, tapNode, ui, adb, screenshot, pass, owner, fixture, directory, appId, report, continueAfterInstall = false }) {
  const root = path.resolve(__dirname, '..');
  assert.equal(appId, 'sg.parse.companion.verification');
  assert.equal((await adb('shell', 'getprop', 'ro.kernel.qemu')).trim(), '1');
  assert((await adb('shell', 'id')).includes('uid=0'));
  assert.equal((await adb('shell', 'settings', 'get', 'secure', 'accessibility_enabled')).trim(), '0');
  const apk = path.join(root, 'mobile/android/app/build/outputs/apk/nativeVerification/app-nativeVerification.apk');
  const sha = createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  assert.equal(sha, report.installed_apk_sha256);
  const evidence = report.reinstall = continueAfterInstall ? report.reinstall : { apk_sha256: sha };
  assert.equal(evidence.apk_sha256, sha);
  async function until(check, message, attempts = 35) {
    for (let i = 0; i < attempts; i++) { const result = await check(); if (result) return result; await sleep(350); }
    throw new Error(message);
  }
  const care = dashboard => Object.fromEntries(['notes','measurements','preventive_tasks','support_requests','followups'].map(k =>
    [k, dashboard[k].map(r => r.id).sort()]));
  async function scheduled() {
    const file = '/data/user/0/' + appId + '/shared_prefs/expo.modules.notifications.SharedPreferencesNotificationsStore.xml';
    const exists = (await adb('shell', 'sh', '-c', `'[ -f ${file} ] && echo present || echo absent'`)).trim();
    if (exists === 'absent') return [];
    assert.equal(exists, 'present');
    return [...(await adb('exec-out','cat',file)).matchAll(/<string name="notification_request-([^"]+)"/g)].map(m => m[1]).sort();
  }
  const uploads = () => fs.readFileSync(path.join(directory, 'native-uploads.jsonl'), 'utf8').trim().split('\n').length;
  if (!continueAfterInstall) {
    await tap('Settings');
    await tap('Enable alerts');
    await find('Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.');
  }
  const before = await owner.dash();
  const oldId = before.active_companion.device_id;
  assert(before.devices.some(d => d.id === oldId && d.device_type === 'phone' && !d.revoked_at));
  if (continueAfterInstall) {
    assert.deepEqual(before.active_companion, evidence.original_route);
    assert.deepEqual(care(before), evidence.care_before);
    assert.equal(uploads(), evidence.uploads_before);
    assert.deepEqual(evidence.uninstalled && {
      package_absent:evidence.uninstalled.package_absent,
      private_data_absent:evidence.uninstalled.private_data_absent,
      alarms_absent:evidence.uninstalled.alarms_absent,
    }, {package_absent:true, private_data_absent:true, alarms_absent:true});
  } else {
  evidence.original_device_id = oldId; evidence.original_route = before.active_companion;
  evidence.care_before = care(before);
  evidence.scheduled_before = await scheduled();
  assert(evidence.scheduled_before.length && evidence.scheduled_before.every(id => id.startsWith('parse.' + oldId + '.')));
  const alarmRecords = text => [...text.matchAll(/^\s*(?:RTC|ELAPSED)(?:_WAKEUP)? #\d+: Alarm\{[^\n]*sg\.parse\.companion\.verification\}/gm)].map(m=>m[0].trim());
  evidence.alarms_before = alarmRecords(await adb('shell','dumpsys','alarm'));
  assert(evidence.alarms_before.length > 0);
  evidence.uploads_before = uploads();
  await screenshot('native-reinstall-before');

  assert.equal((await adb('uninstall', appId)).trim(), 'Success');
  assert.equal((await adb('shell', 'pm', 'list', 'packages', appId)).trim(), '');
  const dataAbsent = (await adb('shell', 'sh', '-c', `'[ ! -d /data/user/0/${appId} ] && echo absent'`)).trim();
  assert.equal(dataAbsent, 'absent');
  const alarms = await adb('shell', 'dumpsys', 'alarm');
  evidence.alarms_after_uninstall=alarmRecords(alarms);
  assert.deepEqual(evidence.alarms_after_uninstall, []);
  evidence.alarm_dump_after_sha256=createHash('sha256').update(alarms).digest('hex');
  fs.writeFileSync(path.join(directory,'native-reinstall-alarms-after.txt'),alarms);
  evidence.uninstalled = { at:new Date().toISOString(), package_absent:true, private_data_absent:true, alarms_absent:true };
  assert.deepEqual((await owner.dash()).active_companion, before.active_companion);
  pass('Actual Android uninstall removes the verification package, private data and OS alarms without changing server care or reminder selection');

  assert((await adb('install', apk)).includes('Success'));
  }
  const installed = (await adb('shell','pm','path',appId)).trim().replace(/^package:/,'');
  assert(installed.startsWith('/data/app/') && !installed.includes('\n'));
  assert.equal((await adb('shell','sha256sum',installed)).split(/\s/)[0], sha);
  await adb('shell','am','start','-W','-n',appId+'/sg.parse.companion.MainActivity');
  await find('Connect to Parse');
  const unpaired = await ui();
  assert(!unpaired.some(n => n.text?.startsWith('HELLO, ') || n['content-desc'] === 'Tap to start recording'));
  assert(unpaired.some(n => n['content-desc'] === 'Parse HTTPS service address' &&
    (!n.text || (n.text === n.hint && n.hint === 'https://parse.example.org'))));
  assert.deepEqual(await scheduled(), []);
  const pkg = await adb('shell','dumpsys','package',appId);
  assert(/android.permission.RECORD_AUDIO: granted=false/.test(pkg));
  evidence.fresh_install = { apk_digest_matches:true, requires_pairing:true, microphone_granted:false, scheduled_alerts:[] };
  await screenshot('native-reinstall-unpaired');
  pass('Reinstalling the exact APK starts without patient details, the old pairing, microphone permission or scheduled alerts');

  await tap('Parse HTTPS service address');
  await adb('shell','input','text',fixture.origin);
  await adb('shell','input','keyevent','KEYCODE_BACK');
  await tap('Get pairing code');
  const code = await until(async()=> (await ui()).find(n=>n['content-desc']?.startsWith('Pairing code '))?.['content-desc'].slice('Pairing code '.length), 'No fresh pairing code');
  await owner.page.getByLabel('Companion type').selectOption('phone');
  await owner.page.getByLabel('One-use device code').fill(code);
  await owner.page.getByRole('button',{name:'Approve phone',exact:true}).click();
  await find('HELLO, Mei');
  const fresh = await until(async()=> (await owner.dash()).devices.find(d => d.device_type==='phone' && !before.devices.some(old=>old.id===d.id)), 'Owner approval did not expose a new phone identity');
  evidence.new_device_id = fresh.id;
  assert.notEqual(fresh.id,oldId);
  const paired = await owner.dash();
  assert.deepEqual(paired.active_companion,before.active_companion);
  assert.deepEqual(care(paired), evidence.care_before);
  assert.deepEqual(await scheduled(), []);
  const tapMode = await find('Use tap instead of hold to record');
  if(tapMode.checked!=='true')await tapNode(tapMode);
  await screenshot('native-reinstall-paired-not-selected');
  pass('Native enrollment and actual owner-browser approval create a different identity, preserve care history and leave the old reminder selection unchanged');

  const oldCard = owner.page.locator('article.paired-device').filter({has:owner.page.getByText(oldId,{exact:true})});
  await oldCard.getByRole('button',{name:'Revoke device access',exact:true}).click();
  await owner.page.getByRole('dialog').getByRole('button',{name:'Revoke access',exact:true}).click();
  await oldCard.getByText('Access revoked',{exact:true}).first().waitFor();
  assert.equal((await owner.dash()).active_companion.device_id,oldId);
  const finish = owner.page.getByRole('button',{name:'Finish removing this phone',exact:true});
  await finish.waitFor();
  assert(await finish.isDisabled());
  await owner.page.screenshot({path:path.join(directory,'native-reinstall-owner-recovery.png'),fullPage:true});
  await owner.page.getByLabel('I have uninstalled Parse or cleared its app data on the old phone.',{exact:true}).check();
  await finish.click();
  const paused = await until(async()=> {const d=await owner.dash();return d.active_companion.device_id===null?d:null;},'Owner recovery did not pause reminders');
  assert.equal(paused.active_companion.generation,before.active_companion.generation+1);
  assert(paused.devices.find(d=>d.id===oldId).revoked_at);
  assert.deepEqual(await scheduled(), []);
  evidence.paused_route=paused.active_companion;
  pass('After actual removal and owner revocation, the checked dashboard recovery action releases only the old installation and leaves reminders paused');

  await owner.page.getByLabel('Send reminders to').selectOption(fresh.id);
  await owner.page.getByRole('button',{name:'Save reminder companion',exact:true}).click();
  await until(async()=> (await owner.dash()).active_companion.device_id===fresh.id, 'Replacement reminder selection failed');
  await tap('Settings');
  await tap('Enable alerts');
  const allow=(await ui()).find(n=>n['resource-id']?.endsWith('/permission_allow_button'));
  if(allow)await tapNode(allow);
  await find('Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.');
  evidence.scheduled_after=await until(async()=>{const ids=await scheduled();return ids.length?ids:null;},'New selected phone did not schedule alerts');
  const after=await owner.dash();
  assert.equal(after.active_companion.generation,before.active_companion.generation+2);
  assert(evidence.scheduled_after.every(id=>id.startsWith('parse.'+fresh.id+'.')&&id.endsWith('.g'+after.active_companion.generation)));
  assert.deepEqual(care(after),evidence.care_before);
  assert.equal(uploads(),evidence.uploads_before);
  evidence.final_route=after.active_companion;evidence.care_after=care(after);evidence.uploads_after=uploads();
  await screenshot('native-reinstall-new-alerts');
  await owner.page.screenshot({path:path.join(directory,'native-reinstall-owner-restored.png'),fullPage:true});
  pass('A separate owner selection and fresh Android alert permission schedule only the new identity/generation, with every care record retained and no voice upload');
};
