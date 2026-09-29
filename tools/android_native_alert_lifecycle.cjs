/* Actual Android local alerts with a swipe keyguard or normal background process death. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function alertLifecycle({ find, tap, tapNode, ui, adb, screenshot, pass, owner, fixture, directory, appId, report, alertState }) {
  assert(['locked', 'secure-locked', 'terminated', 'recents', 'offline-plan', 'revoked', 'offline-revoked', 'doze', 'dnd', 'battery-saver'].includes(alertState));
  const lockedScreen = alertState === 'locked' || alertState === 'secure-locked';
  const batterySaver = alertState === 'battery-saver';
  const powerName = batterySaver ? 'Battery Saver' : 'deep Doze';
  const offlinePlan = alertState === 'offline-plan';
  const offlineRevoked = alertState === 'offline-revoked';
  const offline = offlinePlan || offlineRevoked;
  const root = path.resolve(__dirname, '..');
  async function control(mode, kind) {
    const { stdout } = await execute(path.join(root, 'backend/.venv/bin/python'),
      [path.join(root, 'tools/android_native_control.py'), mode, '--kind', kind, '--data-dir', directory], { timeout: 30000 });
    return JSON.parse(stdout);
  }
  async function scheduledIds() {
    assert((await adb('shell', 'id')).includes('uid=0'), 'Read-only native notification-store inspection requires the disposable emulator');
    const xml = await adb('exec-out', 'cat', '/data/user/0/' + appId + '/shared_prefs/expo.modules.notifications.SharedPreferencesNotificationsStore.xml');
    return [...xml.matchAll(/<string name="notification_request-([^"]+)"/g)].map(match => match[1]).sort();
  }
  function fault(value) {
    const temporary = path.join(directory, 'fault-mode.alert.tmp');
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, 'fault-mode.json'));
  }
  function proxyEvents() {
    const file = path.join(directory, 'fault-events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  }
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
  const power = alertState === 'doze' ? await require('./android_native_power.cjs')({ adb, appId, report }) :
    batterySaver ? await require('./android_native_battery.cjs')({ adb, appId, report }) : null;
  const dnd = alertState === 'dnd' ? await require('./android_native_dnd.cjs')({ adb, report }) : null;
  const secureLock = alertState === 'secure-locked' ? await require('./android_native_secure_lock.cjs')({ adb, ui, screenshot, appId, report }) : null;
  const recents = alertState === 'recents' ? await require('./android_native_recents.cjs')({ adb, ui, screenshot, appId, report }) : null;
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
    report.native_scheduled_before = await scheduledIds();
    assert(report.native_scheduled_before.includes(identity));
    if (alertState === 'revoked') {
      await require('./android_native_revocation.cjs')({ find, tap, ui, adb, screenshot, pass, owner, fixture, appId, report, phone, scheduledIds, until });
      return;
    }
    await screenshot('native-' + alertState + '-scheduled');
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    if (offline) {
      fault({ offline: true });
      await adb('reverse', 'tcp:8443', 'tcp:8444');
      report.fault_event_offset = proxyEvents().length;
    }
    if (secureLock) {
      await secureLock.enter();
    } else if (alertState === 'locked') {
      await adb('shell', 'locksettings', 'set-disabled', 'false');
      await adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
      const locked = await until(async () => {
        const value = await adb('shell', 'dumpsys', 'window', 'policy');
        return value.includes('mIsShowing=true') && value.includes('SCREEN_STATE_OFF') ? value : undefined;
      }, 'Android did not enter the actual keyguard/screen-off state');
      report.lock = { showing: true, screen_off: true, secure: /\bsecure=true/.test(locked), type: 'Swipe keyguard; no credential' };
    } else if (power) {
      await power.enter();
    } else if (dnd) {
      await dnd.enter();
    } else if (recents) {
      await recents.dismiss();
      report.native_scheduled_after_dismissal = await scheduledIds();
      assert(report.native_scheduled_after_dismissal.includes(identity));
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
    let posted, changedPlan, revokedOffline, restrictedCommand;
    const notesBefore = (await owner.dash()).notes.length;
    report.notes_before = notesBefore;
    report.observation_window_seconds_after_due = power ? 420 : 300;
    console.log('Waiting for actual OS alert ' + identity + ', due ' + dose.scheduled_at);
    while (Date.now() < Date.parse(dose.scheduled_at) + report.observation_window_seconds_after_due * 1000) {
      if ((power || dnd || secureLock || recents) && !restrictedCommand && Date.now() >= Date.parse(dose.scheduled_at)) {
        await control('tick', 'medication');
        restrictedCommand = (await metadata()).commands.find(c => c.dose_id === dose.id);
        assert(restrictedCommand && restrictedCommand.state === 'queued' && !restrictedCommand.audio_accessed && restrictedCommand.acks.length === 0);
        if (power) {
          report[batterySaver ? 'command_while_battery_saver' : 'command_while_idle'] = restrictedCommand;
          report.power.at_due = await power.observe();
        } else if (dnd) {
          report.command_while_dnd = restrictedCommand;
          report.dnd.at_due = await dnd.observe();
        } else if (secureLock) {
          report.command_while_locked = restrictedCommand;
          report.secure_lock.at_due = await secureLock.observe();
        } else {
          report.command_while_dismissed = restrictedCommand;
          report.recents.at_due = await recents.observe();
        }
      }
      if (offlineRevoked && !revokedOffline && Date.now() >= Date.parse(dose.scheduled_at)) {
        await control('tick', 'medication');
        const old = (await metadata()).commands.find(c => c.dose_id === dose.id);
        assert(old && old.state === 'queued' && !old.audio_accessed && old.acks.length === 0);
        report.queued_before_revocation = old;
        await owner.api('/app/devices/' + phone.id + '/revoke', {});
        const dashboard = await owner.dash();
        revokedOffline = dashboard.devices.find(d => d.id === phone.id);
        // Revocation denies access immediately, but a selected phone must still
        // attest local cleanup before the route can move to another companion.
        assert(revokedOffline.revoked_at && dashboard.active_companion.device_id === phone.id);
        assert(!revokedOffline.phone_presence.foreground_ready && !revokedOffline.phone_presence.background_alerts_enabled);
        report.revoked_while_offline_at = revokedOffline.revoked_at;
        report.route_waiting_for_cleanup = dashboard.active_companion;
        report.native_scheduled_while_revoked_offline = await scheduledIds();
        assert(report.native_scheduled_while_revoked_offline.includes(identity));
        const pending = (await metadata()).commands.find(c => c.id === old.id);
        assert(pending && !pending.audio_accessed && pending.acks.length === 0);
        report.command_after_offline_revocation = pending;
        const session = await (await owner.context.request.get('/v1/auth/session')).json();
        const rejected = await owner.context.request.put('/v1/app/patients/' + fixture.patient_id + '/active-companion', {
          headers: { Origin: fixture.origin, 'X-CSRF-Token': session.csrf_token },
          data: { device_id: null, expected_generation: dashboard.active_companion.generation, other_pendants_powered_off: false },
        });
        assert.equal(rejected.status(), 409);
        assert((await rejected.json()).detail.includes('Pause reminders'));
        report.offline_revoked_route_switch_rejected = true;
        pass('Owner revocation marks the offline phone denied; reminder handoff remains blocked until local cleanup and the retained alert stays generic');
      }
      if (offlinePlan && !changedPlan && Date.now() >= Date.parse(dose.scheduled_at)) {
        await control('tick', 'medication');
        const old = (await metadata()).commands.find(c => c.dose_id === dose.id);
        assert(old && old.state === 'queued' && !old.audio_accessed && old.acks.length === 0);
        report.queued_before_change = old;
        const newTime = new Date(Date.now() + 20 * 60000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
        changedPlan = await owner.api('/app/patients/' + fixture.patient_id + '/medication-plans', {
          timezone: 'Asia/Singapore', source: 'Fictional replacement while phone is offline', checked: true,
          medicines: [{ id: 'replacement_alert', name: 'Fictional Current Replacement Medicine', instructions: 'Fictional replacement instruction', reviewed_reference: 'Fictional new reference', reference_source: 'New test label' }],
          schedule: [{ medicine_id: 'replacement_alert', local_time: newTime }],
        });
        report.replacement_plan_version = changedPlan.version;
        const route = (await owner.dash()).active_companion;
        const session = await (await owner.context.request.get('/v1/auth/session')).json();
        const rejected = await owner.context.request.put('/v1/app/patients/' + fixture.patient_id + '/active-companion', {
          headers: { Origin: fixture.origin, 'X-CSRF-Token': session.csrf_token },
          data: { device_id: null, expected_generation: route.generation, other_pendants_powered_off: false },
        });
        assert.equal(rejected.status(), 409);
        assert((await rejected.json()).detail.includes('Pause reminders'));
        assert.equal((await owner.dash()).active_companion.device_id, phone.id);
        report.offline_route_switch_rejected = true;
        pass('A real queued reminder becomes stale while offline; remote route switching requires local phone cleanup');
      }
      posted = postedRecord(await adb('shell', 'dumpsys', 'notification', '--noredact'));
      if (posted) {
        if (power) {
          report.power.delivery_phase = power.released ? 'after leaving ' + powerName : 'during ' + powerName;
          report.power.at_notification = await power.observe();
          const command = (await metadata()).commands.find(c => c.id === restrictedCommand?.id);
          assert(command && !command.audio_accessed && command.acks.length === 0);
          report.command_before_opening = command;
          if (!batterySaver) await power.release('generic alert observed');
        }
        if (dnd) {
          await dnd.inspect(posted);
          const command = (await metadata()).commands.find(c => c.id === restrictedCommand?.id);
          assert(command && !command.audio_accessed && command.acks.length === 0);
          report.command_before_opening = command;
        }
        if (secureLock) {
          report.secure_lock.at_notification = await secureLock.observe();
          const command = (await metadata()).commands.find(c => c.id === restrictedCommand?.id);
          assert(command && !command.audio_accessed && command.acks.length === 0);
          report.command_before_opening = command;
        }
        if (recents) {
          report.recents.at_notification = await recents.observe();
          const command = (await metadata()).commands.find(c => c.id === restrictedCommand?.id);
          assert(command && !command.audio_accessed && command.acks.length === 0);
          report.command_before_opening = command;
        }
        break;
      }
      if (power && !power.released && Date.now() >= Date.parse(dose.scheduled_at) + 120000) {
        report.power.no_alert_observed_by = new Date().toISOString();
        report.power.still_scheduled_before_release = (await scheduledIds()).includes(identity);
        assert(report.power.still_scheduled_before_release);
        await power.release('two-minute observation after due time elapsed without an OS alert');
      }
      await sleep(3000);
    }
    assert(posted, 'Android did not post this exact notification within the bounded observation window');
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
    if (lockedScreen) {
      assert((await adb('shell', 'dumpsys', 'window', 'policy')).includes('mIsShowing=true'));
      await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
      await find('Open Parse to check your care schedule.', { scroll: false });
      await screenshot('native-' + alertState + '-notification');
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
    if (secureLock) await secureLock.unlock(async () => {
      const command = (await metadata()).commands.find(c => c.id === restrictedCommand.id);
      assert(command && !command.audio_accessed && command.acks.length === 0);
      report.command_before_unlocking = command;
      assert.equal((await owner.dash()).doses.find(d => d.id === dose.id).report_state, 'unconfirmed');
      pass('Secure keyguard requires PIN entry and exposes no care UI or reminder playback after the notification tap');
    });
    // A real notification tap must reopen the app; do not launch it from adb here.
    await until(async () => {
      const activity = await adb('shell', 'dumpsys', 'activity', 'activities');
      return activity.split('\n').some(line => line.includes('topResumedActivity=') && line.includes(appId))
        && (await ui()).some(node => node.package === appId && (node.text || node['content-desc']));
    }, 'Notification tap did not resume the native app');
    if (offline) {
      assert(changedPlan || revokedOffline);
      await until(() => proxyEvents().slice(report.fault_event_offset).some(e => e.kind === 'offline_connection_closed'), 'Notification tap did not encounter the offline proxy');
      const offlineUi = await ui();
      assert(!offlineUi.some(n => n['content-desc'] === 'Tap to start recording' || n.text?.startsWith('HELLO, ')));
      await find('Cannot reach Parse', { scroll: false });
      await screenshot('native-' + alertState + '-opened-offline');
      const old = (await metadata()).commands.find(c => c.id === (report.queued_before_change || report.queued_before_revocation).id);
      assert(old && !old.audio_accessed && !old.acks.includes('playback_started') && !old.acks.includes('playback_completed'));
      report.stale_command_while_offline = old;
      pass('The stale alert remains generic and an offline tap offers no recording or old reminder playback');
      fault({});
      if (offlineRevoked) {
        // Foreground sync retries the saved identity automatically. A manual
        // Retry button may already be gone by the next UI dump after reconnect.
        await require('./android_native_revocation.cjs')({ find, tap, ui, adb, screenshot, pass, owner, fixture, appId, report, phone, scheduledIds, until, alreadyRevoked: true });
        const after = (await metadata()).commands.find(c => c.id === old.id);
        assert(after && !after.audio_accessed && !after.acks.includes('playback_started') && !after.acks.includes('playback_completed'));
        assert.equal((await owner.dash()).notes.length, notesBefore);
        assert.equal((await owner.dash()).doses.find(d => d.id === dose.id).report_state, 'unconfirmed');
        report.stale_command_after_reconnect = after;
        report.medication_report = 'unconfirmed';
        pass('Offline revocation is enforced on reconnect and after restart; deliberate fresh pairing retains history without stale playback or a dose report');
        return;
      }
      await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
      await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
      await find('HELLO, Mei');
      await tap('Medicines');
      await find('Fictional Current Replacement Medicine');
      await screenshot('native-offline-plan-current-medicine');
      await until(async () => !(await scheduledIds()).includes(identity), 'Stale native alarm remains scheduled after current sync');
      const after = (await metadata()).commands.find(c => c.id === old.id);
      assert(after && !after.audio_accessed && !after.acks.includes('playback_started') && !after.acks.includes('playback_completed'));
      assert.equal((await owner.dash()).notes.length, notesBefore);
      report.stale_command_after_reconnect = after;
      await tap('Settings');
      await tap('Pause reminders');
      await until(async () => (await owner.dash()).active_companion.device_id === null && (await scheduledIds()).length === 0, 'Pause did not clear native schedule and release the route');
      const paused = (await owner.dash()).active_companion;
      report.route_after_local_pause = paused;
      report.native_scheduled_after_pause = await scheduledIds();
      assert(!(await adb('shell', 'dumpsys', 'notification', '--noredact')).split(/(?=NotificationRecord\()/).some(b => b.split('\n')[0].includes(appId)));
      await owner.api('/app/patients/' + fixture.patient_id + '/active-companion', { device_id: phone.id, expected_generation: paused.generation, other_pendants_powered_off: false }, 'PUT');
      const selected = (await owner.dash()).active_companion;
      assert(selected.generation > paused.generation);
      await tap('Enable alerts');
      await until(async () => (await scheduledIds()).some(id => id.endsWith('.g' + selected.generation)), 'New route generation did not rebuild the native schedule');
      report.route_after_reselection = selected;
      report.native_scheduled_after_reselection = await scheduledIds();
      assert(report.native_scheduled_after_reselection.every(id => id.endsWith('.g' + selected.generation)));
      assert.equal((await owner.dash()).doses.find(d => d.id === dose.id).report_state, 'unconfirmed');
      report.medication_report = 'unconfirmed';
      pass('Reconnect shows the replacement plan without stale audio; local Pause clears alerts before a new routing generation is selected');
      return;
    }
    await until(async () => (await metadata()).events.some(e => e.identity === identity && e.stage === 'opened'),
      'Native notification tap did not record opened evidence');
    assert.equal((await owner.dash()).doses.find(d => d.id === dose.id).report_state, 'unconfirmed');
    report.opened = true;
    report.medication_report = 'unconfirmed';
    if (power || dnd || secureLock || recents) {
      report.command_after_opening = (await metadata()).commands.find(c => c.id === restrictedCommand.id);
      report.notes_after = (await owner.dash()).notes.length;
      assert.equal(report.notes_after, notesBefore);
    }
    if (batterySaver) report.power.after_opening = await power.observe();
    if (dnd) report.dnd.after_opening = await dnd.observe();
    if (recents) {
      await recents.opened();
      // A new process can record the tap before its first reminder poll. Wait
      // for actual player acknowledgements rather than treating opening as speech.
      await until(async () => {
        const command = (await metadata()).commands.find(c => c.id === restrictedCommand.id);
        report.command_after_opening = command;
        return command?.state === 'playback_completed' && command.audio_accessed &&
          command.acks.includes('playback_started') && command.acks.includes('playback_completed');
      }, 'The current reminder did not finish native playback after recents dismissal');
      report.notes_after = (await owner.dash()).notes.length;
      assert.equal(report.notes_after, notesBefore);
      assert.equal((await owner.dash()).doses.find(d => d.id === dose.id).report_state, 'unconfirmed');
    }
    await screenshot('native-' + alertState + '-opened');
    pass('Actual ' + alertState + ' notification tap opens the native app and remains separate from medication reporting');
  } finally {
    if (secureLock) await secureLock.restore();
    if (dnd) await dnd.restore();
    if (power) await power.restore();
    if (offline) { fault({}); await adb('reverse', 'tcp:8443', 'tcp:8443'); }
    await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    await adb('shell', 'wm', 'dismiss-keyguard');
    await adb('shell', 'locksettings', 'set-disabled', originalLockDisabled);
  }
};
