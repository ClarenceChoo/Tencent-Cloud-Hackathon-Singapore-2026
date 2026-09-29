/* Local Android reminder/alert checks. WAV tones, fictional data, no live push. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function reminders({ find, tap, tapNode, ui, adb, screenshot, pass, owner, fixture, directory, appId, report, alertsOnly = false }) {
  const root = path.resolve(__dirname, '..');
  async function control(mode, kind) {
    const { stdout } = await execute(path.join(root, 'backend/.venv/bin/python'),
      [path.join(root, 'tools/android_native_control.py'), mode, '--kind', kind, '--data-dir', directory], { timeout: 20000 });
    return JSON.parse(stdout);
  }
  async function foreground() {
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await find('HELLO, Mei');
  }
  report.reminders = [];
  for (const kind of (alertsOnly ? [] : ['medication', 'checkin'])) {
    const queued = await control('enqueue', kind);
    assert(queued.command_id);
    const enqueued = queued.attempts.find(a => a.id === queued.command_id);
    assert(enqueued, 'The scheduler must create an observable attempt');
    let completed;
    for (let i = 0; i < 35; i++) {
      const current = (await control('inspect', kind)).attempts.find(a => a.id === queued.command_id);
      if (current?.delivery_state === 'playback_completed') { completed = current; break; }
      await sleep(500);
    }
    assert(completed, `Native ${kind} reminder did not report completed playback`);
    assert(completed.acks.some(a => a.stage === 'playback_started'));
    assert(completed.acks.some(a => a.stage === 'playback_completed'));
    if (kind === 'medication') assert.equal((await owner.dash()).doses.find(d => d.id === queued.dose_id).report_state, 'unconfirmed');
    report.reminders.push({ kind, ...(queued.dose_id ? { dose_id: queued.dose_id } : {}), ...completed });
    await adb('shell', 'am', 'force-stop', appId);
    await foreground();
    await sleep(5000);
    const after = (await control('inspect', kind)).attempts.find(a => a.id === queued.command_id);
    assert.deepEqual(after, completed, 'Restart must not create more playback ACKs');
    pass(`Native ${kind} reminder plays a fixture tone, records actual start/completion callbacks and is not replayed after restart`);
  }

  await tap('Settings');
  await tap('Enable alerts');
  let nodes = await ui();
  const allow = nodes.find(n => n['resource-id']?.endsWith('/permission_allow_button'));
  if (allow) await tapNode(allow);
  let phone;
  for (let i = 0; i < 30; i++) {
    phone = (await owner.dash()).devices.find(d => d.id === (report.reminder_device_id || (d.device_type === 'phone' && d.selected ? d.id : null)));
    if (phone?.phone_presence?.notification_permission === 'granted') break;
    await sleep(500);
  }
  assert.equal(phone?.phone_presence?.notification_permission, 'granted');
  report.reminder_device_id = phone.id;
  const at = new Date(Date.now() + 150000);
  const localTime = at.toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
  const plan = await owner.api('/app/patients/' + fixture.patient_id + '/medication-plans', {
    timezone: 'Asia/Singapore', source: 'Fictional notification test', checked: true,
    medicines: [{ id: 'native_alert', name: 'Fictional Private Alert Medicine', instructions: 'Fictional instruction',
      reviewed_reference: 'Fictional reviewed reference', reference_source: 'Test label' }],
    schedule: [{ medicine_id: 'native_alert', local_time: localTime }],
  });
  const dose = (await owner.dash()).doses.filter(d => d.medicine_id === 'native_alert' && d.plan_version === plan.version)
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0];
  assert(dose && Date.parse(dose.scheduled_at) > Date.now());
  report.notification_plan_version = plan.version;
  report.notification_dose_id = dose.id;
  await tap('Enable alerts');
  await find('Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.');
  await screenshot('native-alerts-enabled');
  await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(750);
  report.notification_due_at = dose.scheduled_at;
  // Check Android's actual posted record. Nothing here fabricates an OS alert.
  let posted;
  report.notification_observation_window_seconds = 300;
  while (Date.now() < Date.parse(dose.scheduled_at) + 300000) {
    const dump = await adb('shell', 'dumpsys', 'notification', '--noredact');
    posted = dump.split(/(?=NotificationRecord\()/).find(block => {
      const postedAt = Number(block.match(/\bwhen=(\d+)\//)?.[1]);
      return block.split('\n')[0].includes(appId) && block.includes('Open Parse to check your care schedule.')
        && postedAt >= Date.parse(dose.scheduled_at);
    });
    if (posted) break;
    await sleep(3000);
  }
  assert(posted, 'Android did not post the generic local alert within the observed window');
  assert(!posted.includes('Fictional Private Alert Medicine'));
  const postedAt = Number(posted.match(/\bwhen=(\d+)\//)[1]);
  report.notification_posted_at = new Date(postedAt).toISOString();
  report.notification_delay_ms = postedAt - Date.parse(dose.scheduled_at);
  report.notification = { actual_posted: true, backgrounded: true, generic_body: 'Open Parse to check your care schedule.', live_push: false };
  fs.writeFileSync(path.join(directory, 'native-notification-record.txt'), posted); // Fictional verification package only.
  await adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  await find('Open Parse to check your care schedule.', { scroll: false });
  await screenshot('native-generic-notification');
  await tap('Open Parse to check your care schedule.', { scroll: false });
  await foreground();
  assert.equal((await owner.dash()).doses.find(d => d.id === dose.id).report_state, 'unconfirmed');
  pass('Android posts a generic local alert while backgrounded; opening it does not record medication taken');

  await adb('shell', 'pm', 'revoke', appId, 'android.permission.POST_NOTIFICATIONS');
  await foreground();
  await tap('Settings');
  await find('Notifications are off. Voice works while Parse is open.');
  for (let i = 0; i < 20; i++) {
    phone = (await owner.dash()).devices.find(d => d.id === report.reminder_device_id);
    if (phone.phone_presence.notification_permission === 'denied' && !phone.phone_presence.background_alerts_enabled) break;
    await sleep(500);
  }
  assert.equal(phone.phone_presence.notification_permission, 'denied');
  assert.equal(phone.phone_presence.background_alerts_enabled, false);
  await screenshot('native-alerts-denied');
  pass('Native notification denial clears reported background coverage and is shown in the app');
  await tap('Pause reminders');
  for (let i = 0; i < 20; i++) {
    if ((await owner.dash()).active_companion.device_id === null) break;
    await sleep(500);
  }
  assert.equal((await owner.dash()).active_companion.device_id, null);
  pass('Native Pause reminders completes cleanup before deactivating the selected companion');
};
