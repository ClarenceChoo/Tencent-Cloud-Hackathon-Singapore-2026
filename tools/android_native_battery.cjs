/* Battery Saver controls only for the smoke harness's disposable emulator. */
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function batteryCheck({ adb, appId, report }) {
  async function state() {
    const battery = await adb('shell', 'dumpsys', 'battery');
    const power = await adb('shell', 'dumpsys', 'power');
    const alarms = await adb('shell', 'dumpsys', 'alarm');
    const machine = power.split('Battery saver state machine:')[1]?.split('AttentionDetector:')[0];
    const policy = power.split("Policy 'current full'")[1]?.split("Policy 'default adaptive'")[0]?.trim();
    assert(machine && policy, 'Android must expose actual Battery Saver state');
    const flag = (source, expression) => {
      const value = source.match(expression)?.[1];
      assert(['true', 'false'].includes(value), 'Required native boolean state is missing');
      return value === 'true';
    };
    return {
      at: new Date().toISOString(),
      low_power: (await adb('shell', 'settings', 'get', 'global', 'low_power')).trim(),
      sticky: (await adb('shell', 'settings', 'get', 'global', 'low_power_sticky')).trim(),
      enabled: flag(machine, /^\s*Enabled=(true|false)/m),
      full: flag(machine, /^\s*full=(true|false)/m),
      adaptive: flag(machine, /^\s*adaptive=(true|false)/m),
      force_all_apps_standby: flag(alarms, /^\s*Force all apps standby: (true|false)/m),
      powered: flag(power, /^\s*mIsPowered=(true|false)/m),
      wakefulness: power.match(/^\s*mWakefulness=(\w+)/m)?.[1],
      deep_force: (await adb('shell', 'cmd', 'deviceidle', 'get', 'force')).trim(),
      full_policy: policy,
      battery: {
        frozen: battery.includes('UPDATES STOPPED'),
        ac: flag(battery, /^\s*AC powered: (true|false)/m),
        usb: flag(battery, /^\s*USB powered: (true|false)/m),
        wireless: flag(battery, /^\s*Wireless powered: (true|false)/m),
        dock: flag(battery, /^\s*Dock powered: (true|false)/m),
        level: Number(battery.match(/^\s*level: (\d+)/m)?.[1]),
        status: Number(battery.match(/^\s*status: (\d+)/m)?.[1]),
      },
    };
  }
  const original = await state();
  assert(!original.enabled && !original.adaptive && !original.battery.frozen && !original.force_all_apps_standby,
    'Do not replace an existing power-state test');
  assert.equal(original.low_power, '0');
  assert.equal(original.deep_force, 'false');
  assert.equal(original.wakefulness, 'Awake');
  assert(original.powered && original.battery.level === 100 && original.battery.status === 2);
  assert(['0', 'null'].includes(original.sticky));
  assert(!(await adb('shell', 'cmd', 'deviceidle', 'whitelist')).includes(appId));
  report.power = { kind: 'battery-saver', original,
    note: 'Real Android Battery Saver/background policy with simulated unplugged 15% battery on a disposable emulator. No physical battery-life, consumption, OEM or acoustic evidence.' };
  let changed = false, released = false;
  async function until(check, message) {
    for (let i = 0; i < 30; i++) {
      const current = await state();
      if (check(current)) return current;
      await sleep(250);
    }
    throw new Error(message);
  }
  const active = value => value.enabled && value.full && value.low_power === '1' &&
    value.force_all_apps_standby && !value.powered && value.battery.frozen && value.battery.level === 15;
  return {
    get released() { return released; },
    async enter() {
      changed = true;
      await adb('shell', 'cmd', 'battery', 'unplug', '-f');
      await adb('shell', 'cmd', 'battery', 'set', '-f', 'level', '15');
      await adb('shell', 'cmd', 'battery', 'set', '-f', 'status', '3');
      await until(value => !value.powered && value.battery.level === 15, 'Android did not apply the simulated battery');
      await adb('shell', 'cmd', 'power', 'set-mode', '1');
      const entered = await until(active, 'Android did not enable actual Battery Saver background restrictions');
      assert(entered.full_policy.includes('force_background_check=true'));
      assert(entered.full_policy.includes('enable_firewall=true'));
      report.power.entered = entered;
    },
    async observe() {
      const current = await state();
      if (!released) assert(active(current), 'Battery Saver ended before the test released it');
      else assert(!current.enabled && !current.force_all_apps_standby);
      assert.equal(current.deep_force, original.deep_force);
      report.power.last_observed = current;
      return current;
    },
    async release(reason) {
      if (released || !changed) return;
      report.power.before_release = await state();
      report.power.release_reason = reason;
      await adb('shell', 'cmd', 'power', 'set-mode', '0');
      report.power.released = await until(value => !value.enabled && !value.force_all_apps_standby && value.low_power === '0',
        'Android did not disable Battery Saver restrictions');
      released = true;
    },
    async restore() {
      if (!changed) return;
      // Reset the battery even if disabling Saver fails; do not leave it frozen.
      try { await this.release('test cleanup'); }
      finally { await adb('shell', 'cmd', 'battery', 'reset', '-f'); }
      if (original.sticky === 'null') await adb('shell', 'settings', 'delete', 'global', 'low_power_sticky');
      else await adb('shell', 'settings', 'put', 'global', 'low_power_sticky', original.sticky);
      const restored = await until(value => value.powered === original.powered && !value.battery.frozen &&
        value.battery.level === original.battery.level && !value.enabled && !value.force_all_apps_standby,
      'Android did not restore its hardware battery values');
      report.power.restored = restored;
      for (const key of ['low_power', 'sticky', 'enabled', 'full', 'adaptive', 'force_all_apps_standby', 'powered', 'deep_force', 'full_policy'])
        assert.equal(restored[key], original[key], key);
      assert.deepEqual(restored.battery, original.battery);
    },
  };
};
