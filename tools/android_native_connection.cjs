/* Actual native reconnection UI; isolated fictional HTTPS fault proxy only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function connection({ find, tapNode, ui, adb, screenshot, pass, owner, directory, appId, report }) {
  const events = () => fs.readFileSync(path.join(directory, 'fault-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  function fault(value) {
    const temporary = path.join(directory, 'fault-mode.connection.tmp');
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, 'fault-mode.json'));
  }
  async function until(check, message) {
    for (let i = 0; i < 25; i++) {
      const value = await check();
      if (value) return value;
      await sleep(500);
    }
    throw new Error(message);
  }
  const snapshot = dashboard => ({
    device_ids: dashboard.devices.map(d => d.id).sort(),
    selected_device: dashboard.active_companion.device_id,
    generation: dashboard.active_companion.generation,
    notes: dashboard.notes.map(n => n.id).sort(),
    doses: dashboard.doses.map(d => ({ id: d.id, report_state: d.report_state })).sort((a,b) => a.id.localeCompare(b.id)),
  });
  const before = snapshot(await owner.dash());
  report.connection_before = before;
  const offset = events().length;
  try {
    fault({ offline: true });
    await adb('reverse', 'tcp:8443', 'tcp:8444');
    // Restart closes any connections opened before the reverse mapping changed.
    await adb('shell', 'am', 'force-stop', appId);
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await find('Cannot reach Parse', { scroll: false });
    await until(() => events().slice(offset).some(e => e.kind === 'offline_connection_closed'), 'Native startup did not encounter the connection fault');
    const cold = await ui();
    assert(!cold.some(n => ['Tap to start recording', 'Hold to talk', 'Retry pairing', 'Get pairing code', 'Parse HTTPS service address'].includes(n['content-desc'])));
    assert(!cold.some(n => /java\.io|IOException|unexpected end of stream/.test(n.text || '')));
    await screenshot('native-connection-offline');
    assert.deepEqual(snapshot(await owner.dash()), before);
    pass('Native cold offline startup explains the connection failure without exposing care, recording, raw transport errors or a replacement enrollment');

    const retry = await find('Retry connection', { scroll: false });
    fault({});
    await tapNode(retry);
    await find('HELLO, Mei');
    assert.deepEqual(snapshot(await owner.dash()), before);
    await screenshot('native-connection-recovered');
    pass('The real Retry connection control restores the same selected native phone without changing notes, dose reports or routing');

    fault({ offline: true });
    await find('Cannot refresh Parse');
    const warm = await ui();
    assert(warm.some(n => n.text?.includes('Showing previously loaded care details')));
    assert(!warm.some(n => /java\.io|IOException|unexpected end of stream/.test(n.text || '')));
    await screenshot('native-connection-warm-offline');
    fault({});
    await until(async () => !(await ui()).some(n => n.text === 'Cannot refresh Parse'), 'Automatic foreground retry did not clear the stale-care warning');
    await find('HELLO, Mei');
    const after = snapshot(await owner.dash());
    assert.deepEqual(after, before);
    report.connection_after = after;
    report.offline_faults_observed = events().slice(offset).filter(e => e.kind === 'offline_connection_closed').length;
    pass('A warm connection failure labels the retained care details; foreground polling recovers without creating a care fact or identity');
  } finally {
    fault({});
    await adb('reverse', 'tcp:8443', 'tcp:8443');
  }
};
