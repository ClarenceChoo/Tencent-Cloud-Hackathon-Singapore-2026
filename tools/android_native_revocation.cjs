/* Native access revocation and fresh enrollment in the isolated fictional fixture. */
const assert = require('node:assert/strict');
module.exports = async function revoke({ find, tap, ui, adb, screenshot, pass, owner, fixture, appId, report, phone, scheduledIds, until, alreadyRevoked = false }) {
  const before = await owner.dash();
  assert(before.notes.length > 0 && report.native_scheduled_before.length > 0);
  const imagePrefix = alreadyRevoked ? 'native-offline' : 'native';
  if (alreadyRevoked) assert(before.devices.find(d => d.id === phone.id)?.revoked_at);
  else await owner.api('/app/devices/' + phone.id + '/revoke', {});
  await find('Phone access stopped');
  await find("This phone's access has been revoked.");
  await until(async () => (await scheduledIds()).length === 0 && (await owner.dash()).active_companion.device_id === null,
    'Revocation did not clear native notifications and release the route');
  const denied = await ui();
  assert(!denied.some(n => n.text?.startsWith('HELLO, ') || n['content-desc'] === 'Tap to start recording'));
  assert(!denied.some(n => before.notes.some(note => n.text?.includes(note.wording))));
  assert(!(await adb('shell', 'dumpsys', 'notification', '--noredact')).split(/(?=NotificationRecord\()/).some(b => b.split('\n')[0].includes(appId)));
  const stopped = (await owner.dash()).devices.find(d => d.id === phone.id);
  assert(stopped.revoked_at && stopped.status === 'revoked' && !stopped.phone_presence.background_alerts_enabled && !stopped.phone_presence.foreground_ready);
  report.revoked_device = { id: stopped.id, status: stopped.status, foreground_ready: stopped.phone_presence.foreground_ready, background_alerts_enabled: stopped.phone_presence.background_alerts_enabled };
  report.native_scheduled_after_revocation = await scheduledIds();
  await screenshot(imagePrefix + '-revoked-access');
  pass('Owner revocation clears native care controls, posted/scheduled alerts and reminder routing; dashboard reports revoked access');
  await adb('shell', 'am', 'force-stop', appId);
  await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
  await find('Phone access stopped');
  await find("This phone's access has been revoked.");
  assert.equal((await owner.dash()).notes.length, before.notes.length);
  assert.equal((await scheduledIds()).length, 0);
  pass('The revoked installation remains denied across a native process restart');
  await tap('Start a new pairing');
  await find('Get pairing code');
  const address = await find('Parse HTTPS service address');
  // A warm unpair retains the visible service address. Do not append to it.
  assert(address.text === fixture.origin || !address.text, 'Unexpected replacement service address');
  if (!address.text) {
    await tap('Parse HTTPS service address');
    await adb('shell', 'input', 'text', fixture.origin);
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  }
  await tap('Get pairing code');
  const code = await until(async () => (await ui()).find(n => n['content-desc']?.startsWith('Pairing code '))?.['content-desc'].slice('Pairing code '.length), 'Native replacement enrollment did not produce a code');
  const paired = await owner.api('/app/phone-enrollments/approve', { code, patient_id: fixture.patient_id });
  assert(paired.device_id !== phone.id);
  await find('HELLO, Mei');
  const paused = (await owner.dash()).active_companion;
  await owner.api('/app/patients/' + fixture.patient_id + '/active-companion', {
    device_id: paired.device_id, expected_generation: paused.generation, other_pendants_powered_off: false,
  }, 'PUT');
  await tap('Settings');
  await tap('Enable alerts');
  await find('Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.');
  await until(async () => (await scheduledIds()).some(id => id.startsWith('parse.' + paired.device_id + '.')), 'Replacement phone did not schedule under its new identity');
  const after = await owner.dash();
  assert(after.devices.find(d => d.id === phone.id).revoked_at);
  assert.equal(after.active_companion.device_id, paired.device_id);
  assert.equal(after.notes.length, before.notes.length);
  const ids = await scheduledIds();
  assert(ids.every(id => id.startsWith('parse.' + paired.device_id + '.')));
  report.new_device_id = paired.device_id;
  report.new_route = after.active_companion;
  report.native_scheduled_after_new_pairing = ids;
  report.care_note_count_unchanged = before.notes.length;
  await screenshot(imagePrefix + '-replacement-pairing');
  pass('Explicit native re-pairing creates a different device identity, retains revoked history and schedules only for the new selected phone');
};
