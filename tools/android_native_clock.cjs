/* Disposable-emulator wall-clock/time-zone verification. Never changes the host clock. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function clockCheck({ adb, tap, find, screenshot, pass, owner, directory, appId, report }) {
  const root = path.resolve(__dirname, '..');
  const original = {
    autoTime: (await adb('shell', 'settings', 'get', 'global', 'auto_time')).trim(),
    autoZone: (await adb('shell', 'settings', 'get', 'global', 'auto_time_zone')).trim(),
    zone: (await adb('shell', 'getprop', 'persist.sys.timezone')).trim(),
  };
  assert(['0', '1'].includes(original.autoTime) && ['0', '1'].includes(original.autoZone));
  assert(/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(original.zone));
  assert((await adb('shell', 'id')).includes('uid=0'));
  async function clocks() {
    const before = Date.now();
    const android = Number((await adb('shell', 'date', '+%s%3N')).trim());
    const after = Date.now();
    assert(Number.isFinite(android));
    return { android_ms: android, host_midpoint_ms: (before + after) / 2,
      offset_ms: android - (before + after) / 2, roundtrip_ms: after - before };
  }
  async function nativeAlarms() {
    const text = await adb('shell', 'dumpsys', 'alarm');
    const alarms = [...text.matchAll(/RTC_WAKEUP #\d+: Alarm\{[^\n]*type 0 origWhen (\d+) whenElapsed (\d+) sg\.parse\.companion\.verification\}/g)]
      .map(match => ({ at: Number(match[1]), elapsed_at: Number(match[2]) })).sort((a, b) => a.at - b.at);
    const xml = await adb('exec-out', 'cat', '/data/user/0/' + appId + '/shared_prefs/expo.modules.notifications.SharedPreferencesNotificationsStore.xml');
    const identities = [...xml.matchAll(/<string name="notification_request-([^"]+)"/g)].map(m => m[1]).sort();
    assert(alarms.length > 0 && alarms.length === identities.length, 'Native alarm records must match the scheduled identity count');
    assert.equal(new Set(identities).size, identities.length);
    return { alarms, identities };
  }
  async function snapshot(name) {
    const dashboard = await owner.dash();
    const device = dashboard.devices.find(d => d.id === dashboard.active_companion.device_id);
    assert(device?.phone_presence?.foreground_ready);
    const { stdout } = await execute(path.join(root, 'backend/.venv/bin/python'),
      [path.join(root, 'tools/android_native_control.py'), 'inspect', '--kind', 'alerts', '--data-dir', directory], { timeout: 20000 });
    const metadata = JSON.parse(stdout);
    const events = metadata.events;
    const revision = metadata.phone_schedules.find(state => state.device_id === device.id)?.revision;
    assert(revision && /^[a-f0-9]{64}$/.test(revision), "Native phone must report its actual schedule revision");
    const result = { name, host_at: new Date().toISOString(), clocks: await clocks(),
      zone: (await adb('shell', 'getprop', 'persist.sys.timezone')).trim(),
      ...await nativeAlarms(), route: dashboard.active_companion, revision, presence: device.phone_presence,
      last_seen: device.last_seen, notes: dashboard.notes.map(n => n.id).sort(),
      doses: dashboard.doses.map(d => ({ id: d.id, report_state: d.report_state })).sort((a, b) => a.id.localeCompare(b.id)),
      scheduling_events: events.filter(e => e.stage === 'scheduled' && e.identity.startsWith('parse.' + device.id + '.')).length };
    report.clock_samples.push(result);
    return result;
  }
  function compare(initial, current) {
    assert.deepEqual(current.identities, initial.identities);
    assert.deepEqual(current.route, initial.route);
    assert.deepEqual(current.notes, initial.notes);
    assert.deepEqual(current.doses, initial.doses);
    assert.equal(current.revision, initial.revision);
    current.corrected_trigger_error_ms = current.alarms.map((alarm, i) =>
      alarm.at - current.clocks.offset_ms - (initial.alarms[i].at - initial.clocks.offset_ms));
    assert(current.corrected_trigger_error_ms.every(error => Math.abs(error) < 5000),
      'Native alarms drifted from the server due time after the device clock changed: ' + current.corrected_trigger_error_ms.join(', ') + ' ms');
  }
  let initialSample;
  report.clock_samples = [];
  report.original_clock_settings = original;
  const baselineClock = await clocks();
  report.original_clock = baselineClock;
  try {
    await tap('Settings');
    await tap('Enable alerts');
    await find('Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.');
    await sleep(1500);
    const before = await snapshot('original');
    initialSample = before;
    assert(before.alarms.every(a => a.at - before.clocks.android_ms > 3600000), 'Use only fixture alerts at least one hour in the future');
    await adb('shell', 'settings', 'put', 'global', 'auto_time', '0');
    await adb('shell', 'settings', 'put', 'global', 'auto_time_zone', '0');
    for (const offset of [-300000, 300000]) {
      const changedAt = Date.now();
      await adb('shell', 'cmd', 'alarm', 'set-time', String(Math.round(Date.now() + baselineClock.offset_ms + offset)));
      await sleep(6500); // At least one real foreground polling interval, without a restart.
      const observed = await snapshot(offset < 0 ? 'clock-back-five-minutes' : 'clock-forward-five-minutes');
      assert(Math.abs(observed.clocks.offset_ms - baselineClock.offset_ms - offset) < 1500, 'Requested emulator clock change did not take effect');
      assert(Date.parse(observed.presence.reported_at) >= changedAt, 'No fresh foreground presence after the clock change');
      compare(before, observed);
      assert(observed.scheduling_events >= before.scheduling_events + before.identities.length);
      pass('Native alarms retain their server due time after the running emulator clock moves ' + (offset < 0 ? 'back' : 'forward') + ' five minutes');
    }
    await adb('shell', 'cmd', 'alarm', 'set-time', String(Math.round(Date.now() + baselineClock.offset_ms)));
    await sleep(6500);
    const restored = await snapshot('clock-restored');
    compare(before, restored);
    const zone = original.zone === 'Pacific/Honolulu' ? 'Asia/Singapore' : 'Pacific/Honolulu';
    await adb('shell', 'cmd', 'alarm', 'set-timezone', zone);
    await sleep(6500);
    const changed = await snapshot('timezone-changed');
    assert.equal(changed.zone, zone);
    compare(before, changed);
    assert(changed.scheduling_events >= restored.scheduling_events + restored.identities.length, 'Time-zone change did not rebuild the native schedule');
    await screenshot('native-clock-timezone');
    pass('A device time-zone change rebuilds generic alarms without changing the care-plan time, route, care records or notification identities');
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await adb('shell', 'cmd', 'alarm', 'set-time', String(Math.round(Date.now() + baselineClock.offset_ms - 300000)));
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await sleep(3500);
    const resumed = await snapshot('background-clock-change-resumed');
    compare(before, resumed);
    pass('Foreground resume refreshes the unchanged care schedule after a clock change in the background');
  } finally {
    await adb('shell', 'cmd', 'alarm', 'set-time', String(Math.round(Date.now() + baselineClock.offset_ms)));
    await adb('shell', 'cmd', 'alarm', 'set-timezone', original.zone);
    await adb('shell', 'settings', 'put', 'global', 'auto_time_zone', original.autoZone);
    await adb('shell', 'settings', 'put', 'global', 'auto_time', original.autoTime);
    // Also repair alarms on the old buggy build when this regression fails.
    await adb('shell', 'am', 'force-stop', appId);
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    // Cold startup can outlast a fixed sleep while another build is running.
    // Observe the actual native alarms before claiming the fixture is restored.
    let restoredAlarms, restoredClocks, restoredErrors;
    for (let attempt = 0; attempt < 30; attempt++) {
      restoredAlarms = await nativeAlarms();
      restoredClocks = await clocks();
      restoredErrors = initialSample ? restoredAlarms.alarms.map((alarm, i) =>
        alarm.at - restoredClocks.offset_ms - (initialSample.alarms[i]?.at - initialSample.clocks.offset_ms)) : [];
      if (!initialSample || (restoredAlarms.alarms.length === initialSample.alarms.length &&
        restoredErrors.every(error => Number.isFinite(error) && Math.abs(error) < 5000))) break;
      await sleep(1000);
    }
    report.restored_clock_settings = {
      autoTime: (await adb('shell', 'settings', 'get', 'global', 'auto_time')).trim(),
      autoZone: (await adb('shell', 'settings', 'get', 'global', 'auto_time_zone')).trim(),
      zone: (await adb('shell', 'getprop', 'persist.sys.timezone')).trim(), clocks: restoredClocks,
      ...restoredAlarms, corrected_trigger_error_ms: restoredErrors,
    };
    assert(restoredErrors.every(error => Number.isFinite(error) && Math.abs(error) < 5000), 'Native alarms were not restored after the clock test');
    assert.equal(report.restored_clock_settings.autoTime, original.autoTime);
    assert.equal(report.restored_clock_settings.autoZone, original.autoZone);
    assert.equal(report.restored_clock_settings.zone, original.zone);
    assert(Math.abs(report.restored_clock_settings.clocks.offset_ms - baselineClock.offset_ms) < 1500);
  }
};
