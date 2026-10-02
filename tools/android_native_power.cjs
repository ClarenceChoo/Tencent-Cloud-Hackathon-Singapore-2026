/* Power-state controls only for the smoke harness's guarded disposable emulator. */
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function powerCheck({ adb, appId, report }) {
  async function state() {
    const idle = await adb('shell', 'dumpsys', 'deviceidle');
    const power = await adb('shell', 'dumpsys', 'power');
    return { at: new Date().toISOString(),
      deep_enabled: (await adb('shell', 'cmd', 'deviceidle', 'enabled', 'deep')).trim(),
      light_enabled: (await adb('shell', 'cmd', 'deviceidle', 'enabled', 'light')).trim(),
      force: (await adb('shell', 'cmd', 'deviceidle', 'get', 'force')).trim(),
      deep_state: (await adb('shell', 'cmd', 'deviceidle', 'get', 'deep')).trim(),
      light_state: (await adb('shell', 'cmd', 'deviceidle', 'get', 'light')).trim(),
      screen_on: /\bmScreenOn=true\b/.test(idle),
      charging: /\bmCharging=true\b/.test(idle),
      wakefulness: power.match(/\bmWakefulness=(\w+)/)?.[1] || null,
      device_idle_mode: /\bmDeviceIdleMode=true\b/.test(power),
    };
  }
  const original = await state();
  assert.equal(original.force, 'false', 'Do not disturb an existing forced idle test');
  assert(original.screen_on && original.deep_state === 'ACTIVE');
  assert(['0', '1'].includes(original.deep_enabled) && ['0', '1'].includes(original.light_enabled));
  assert(!(await adb('shell', 'cmd', 'deviceidle', 'whitelist')).includes(appId), 'Parse must not be exempt from Doze');
  report.power = { original, note: 'Forced Android deep Doze on a disposable emulator; charger state is left unchanged. No physical battery measurement.' };
  let released = false, entered = false;
  return {
    get released() { return released; },
    async enter() {
      await adb('shell', 'cmd', 'deviceidle', 'enable', 'deep');
      entered = true;
      await adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
      let asleep;
      for (let attempt = 0; attempt < 20; attempt++) {
        asleep = await state();
        if (!asleep.screen_on && asleep.wakefulness !== 'Awake') break;
        await sleep(250);
      }
      report.power.before_forcing = asleep;
      assert(!asleep.screen_on && asleep.wakefulness !== 'Awake', 'Wait for the actual screen-off transition before forcing Doze');
      await adb('shell', 'cmd', 'deviceidle', 'force-idle', 'deep');
      const current = await state();
      report.power.entered = current;
      assert.equal(current.force, 'true');
      assert.equal(current.deep_state, 'IDLE');
      assert(!current.screen_on && current.device_idle_mode);
      report.power.entered = current;
    },
    async observe() {
      const current = await state();
      if (!released) {
        assert.equal(current.deep_state, 'IDLE', 'Deep Doze ended before the test released it');
        assert.equal(current.force, 'true');
        assert(current.device_idle_mode);
      }
      report.power.last_observed = current;
      return current;
    },
    async release(reason) {
      if (released || !entered) return;
      report.power.before_release = await state();
      report.power.release_reason = reason;
      await adb('shell', 'cmd', 'deviceidle', 'unforce');
      await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
      await adb('shell', 'wm', 'dismiss-keyguard');
      released = true;
      for (let i = 0; i < 20; i++) {
        const current = await state();
        if (current.deep_state === 'ACTIVE' && current.force === 'false' && !current.device_idle_mode) {
          report.power.released = current;
          return;
        }
        await sleep(250);
      }
      throw new Error('Android did not leave forced deep Doze');
    },
    async restore() {
      await this.release('test cleanup');
      await adb('shell', 'cmd', 'deviceidle', original.deep_enabled === '1' ? 'enable' : 'disable', 'deep');
      await adb('shell', 'cmd', 'deviceidle', original.light_enabled === '1' ? 'enable' : 'disable', 'light');
      const restored = await state();
      assert.equal(restored.deep_enabled, original.deep_enabled);
      assert.equal(restored.light_enabled, original.light_enabled);
      assert.equal(restored.force, original.force);
      assert.equal(restored.device_idle_mode, original.device_idle_mode);
      assert.equal(restored.screen_on, original.screen_on);
      assert.equal(restored.charging, original.charging);
      report.power.restored = restored;
    },
  };
};
