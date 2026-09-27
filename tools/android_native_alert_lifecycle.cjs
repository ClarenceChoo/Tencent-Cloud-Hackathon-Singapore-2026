/* Actual Android local alerts with a swipe keyguard or normal background process death. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function alertLifecycle({ find, tap, tapNode, ui, adb, screenshot, pass, owner, fixture, directory, appId, report, alertState }) {
  assert(['locked', 'terminated'].includes(alertState));
  const root = path.resolve(__dirname, '..');
  async function metadata() {
    const { stdout } = await execute(path.join(root, 'backend/.venv/bin/python'),
      [path.join(root, 'tools/android_native_control.py'), 'inspect', '--kind', 'alerts', '--data-dir', directory], { timeout: 20000 });
    return JSON.parse(stdout);
  }
  async function until(check, message, attempts = 30) {
    for (let i = 0; i < attempts; i++) {
      const result = await check();
      if (result) return result;
      await sleep(500);
    }
    throw new Error(message);
  }
  async function pid() {
    try { return (await adb('shell', 'pidof', appId)).trim(); }
    catch (error) { if (error.code === 1) return ''; throw error; }
  }
  async function clocks() {
    const before = Date.now();
    const android = Number((await adb('shell', 'date', '+%s%3N')).trim());
    const after = Date.now();
    assert(Number.isFinite(android));
    return { host_before_ms: before, host_after_ms: after, android_ms: android,
      android_minus_host_midpoint_ms: android - (before + after) / 2, roundtrip_ms: after - before };
  }
  const originalLockDisabled = (await adb('shell', 'locksettings', 'get-disabled')).trim();
  assert(['true', 'false'].includes(originalLockDisabled));
  report.alert_state = alertState;
  report.original_lock_disabled = originalLockDisabled === 'true';
  report.clocks_before = await clocks();
  try {
    await tap('Settings');
    await tap('Enable alerts');
    const allow = (await ui()).find(n => n['resource-id']?.endsWith('/permission_allow_button'));
    if (allow) await tapNode(allow);
    const phone = await until(async () => (await owner.dash()).devices.find(d =>
      d.device_type === 'phone' && d.selected && d.phone_presence?.notification_permission === 'granted'),
    'Native notification permission was not granted');
    report.reminder_device_id = phone.id;
    const at = new Date(Date.now() + 150000);
    const localTime = at.toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
    const plan = await owner.api('/app/patients/' + fixture.patient_id + '/medication-plans', {
      timezone: 'Asia/Singapore', source: 'Fictional ' + alertState + ' notification test', checked: true,
      medicines: [{ id: 'native_lifecycle_alert', name: 'Fictional Private Lifecycle Medicine', instructions: 'Fictional private instruction',
        reviewed_reference: 'Fictional reviewed reference', reference_source: 'Test label' }],
      schedule: [{ medicine_id: 'native_lifecycle_alert', local_time: localTime }],
    });
    const dose = (await owner.dash()).doses.filter(d => d.medicine_id === 'native_lifecycle_alert' && d.plan_version === plan.version)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0];
    assert(dose && Date.parse(dose.scheduled_at) > Date.now());
    report.plan_version = plan.version;
    report.dose_id = dose.id;
    report.due_at = dose.scheduled_at;
    await tap('Enable alerts');
    await find('Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.');
    const identity = await until(async () => {
      const current = await metadata();
      const occurrence = current.occurrences.find(o => o.dose_id === dose.id);
      if (!occurrence) return;
      const id = `parse.${phone.id}.${occurrence.id}.g${current.route.generation}`;
      return current.events.some(e => e.identity === id && e.stage === 'scheduled') ? id : undefined;
    }, 'Native scheduling evidence missing for this exact dose');
    report.identity = identity;
    await screenshot('native-' + alertState + '-scheduled');
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    if (alertState === 'locked') {
      await adb('shell', 'locksettings', 'set-disabled', 'false');
      await adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
      const locked = await until(async () => {
        const value = await adb('shell', 'dumpsys', 'window', 'policy');
        return value.includes('mIsShowing=true') && value.includes('SCREEN_STATE_OFF') ? value : undefined;
      }, 'Android did not enter the actual keyguard/screen-off state');
      report.lock = { showing: true, screen_off: true, secure: /\bsecure=true/.test(locked), type: 'Swipe keyguard; no credential' };
    } else {
      report.pid_before_termination = await pid();
      assert(report.pid_before_termination);
      await until(async () => {
        await adb('shell', 'am', 'kill', appId);
        await sleep(500);
        return !(await pid());
      }, 'Background process did not terminate without force-stop');
      const pkg = await adb('shell', 'dumpsys', 'package', appId);
      const user = pkg.split('\n').find(line => line.includes('User 0:'));
      assert(user?.includes('stopped=false'));
      report.termination = { command: 'am kill of the background package', process_absent: true, package_stopped: false };
    }
    pass('Native alert is scheduled for the exact dose before entering ' + alertState + ' state');
    const postedRecord = dump => dump.split(/(?=NotificationRecord\()/).find(block =>
      block.split('\n')[0].includes(appId) && block.split('\n')[0].includes('tag=' + identity + ' '));
    let posted;
    report.observation_window_seconds_after_due = 300;
    console.log('Waiting for actual OS alert ' + identity + ', due ' + dose.scheduled_at);
    while (Date.now() < Date.parse(dose.scheduled_at) + 300000) {
      posted = postedRecord(await adb('shell', 'dumpsys', 'notification', '--noredact'));
      if (posted) break;
      await sleep(3000);
    }
    assert(posted, 'Android did not post this exact notification within five minutes of its due time');
    assert(posted.includes('Open Parse to check your care schedule.'));
    assert(!posted.includes('Fictional Private Lifecycle Medicine') && !posted.includes('Fictional private instruction'));
    const postedAt = Number(posted.match(/\bwhen=(\d+)\//)?.[1]);
    assert(Number.isFinite(postedAt) && postedAt >= Date.parse(dose.scheduled_at));
    report.posted_at = new Date(postedAt).toISOString();
    report.delay_ms = postedAt - Date.parse(dose.scheduled_at);
    report.clocks_after = await clocks();
    report.clock_adjusted_delay_ms = report.delay_ms - report.clocks_after.android_minus_host_midpoint_ms;
    report.raw_notification_sha256 = createHash('sha256').update(posted).digest('hex');
    fs.writeFileSync(path.join(directory, 'native-' + alertState + '-notification-record.txt'), posted);
    if (alertState === 'locked') {
      assert((await adb('shell', 'dumpsys', 'window', 'policy')).includes('mIsShowing=true'));
      await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
      await find('Open Parse to check your care schedule.', { scroll: false });
      await screenshot('native-locked-notification');
    } else {
      report.pid_after_notification = await pid();
      await adb('shell', 'cmd', 'statusbar', 'expand-notifications');
      await find('Open Parse to check your care schedule.', { scroll: false });
      await screenshot('native-' + alertState + '-notification-shade');
    }
    assert.equal((await owner.dash()).doses.find(d => d.id === dose.id).report_state, 'unconfirmed');
    pass('Android posts the exact generic alert in ' + alertState + ' state without recording a dose');
    // Tap the actual lock-screen entry directly. Dismissing keyguard first can
    // race the shade expansion and is a different interaction from opening it.
    await tap('Open Parse to check your care schedule.', { scroll: false });
    // A real notification tap must reopen the app; do not launch it from adb here.
    await until(async () => {
      const activity = await adb('shell', 'dumpsys', 'activity', 'activities');
      return activity.split('\n').some(line => line.includes('topResumedActivity=') && line.includes(appId))
        && (await ui()).some(node => node.package === appId && (node.text || node['content-desc']));
    }, 'Notification tap did not resume the native app');
    await until(async () => (await metadata()).events.some(e => e.identity === identity && e.stage === 'opened'),
      'Native notification tap did not record opened evidence');
    assert.equal((await owner.dash()).doses.find(d => d.id === dose.id).report_state, 'unconfirmed');
    report.opened = true;
    report.medication_report = 'unconfirmed';
    await screenshot('native-' + alertState + '-opened');
    pass('Actual ' + alertState + ' notification tap opens the native app and remains separate from medication reporting');
  } finally {
    await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    await adb('shell', 'wm', 'dismiss-keyguard');
    await adb('shell', 'locksettings', 'set-disabled', originalLockDisabled);
  }
};
