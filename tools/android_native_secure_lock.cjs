/* PIN keyguard checks only for the guarded, disposable verification emulator. */
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Fictional test PIN, never a real device credential. Removed in finally.
const testPin = '826491';

module.exports = async function secureLockCheck({ adb, ui, screenshot, appId, report }) {
  async function state() {
    const policy = await adb('shell', 'dumpsys', 'window', 'policy');
    const boolean = expression => {
      const value = policy.match(expression)?.[1];
      assert(['true', 'false'].includes(value));
      return value === 'true';
    };
    return {
      at: new Date().toISOString(),
      secure: boolean(/^\s*secure=(true|false)/m),
      showing: boolean(/^\s*mIsShowing=(true|false)/m),
      input_restricted: boolean(/^\s*mInputRestricted=(true|false)/m),
      screen_state: policy.match(/^\s*screenState=(\w+)/m)?.[1],
      disabled: (await adb('shell', 'locksettings', 'get-disabled')).trim(),
      show_notifications: (await adb('shell', 'settings', 'get', 'secure', 'lock_screen_show_notifications')).trim(),
      allow_private_notifications: (await adb('shell', 'settings', 'get', 'secure', 'lock_screen_allow_private_notifications')).trim(),
    };
  }
  async function until(check, message) {
    for (let i = 0; i < 30; i++) {
      const current = await state();
      if (check(current)) return current;
      await sleep(500);
    }
    throw new Error(message);
  }
  const original = await state();
  assert(!original.secure && !original.showing && original.disabled === 'true', 'Do not modify an existing credential or keyguard test');
  assert.equal(original.screen_state, 'SCREEN_STATE_ON');
  assert.equal(original.show_notifications, '1');
  assert.equal(original.allow_private_notifications, '1', 'Exercise the app generic content with lock-screen content permitted');
  report.secure_lock = { original, note: 'Actual PIN-protected Android keyguard on a disposable emulator. A fictional test PIN is entered through the OS UI and removed after the test. No physical biometric, secure-storage or iOS claim.' };
  let changed = false;
  return {
    async enter() {
      changed = true;
      await adb('shell', 'locksettings', 'set-pin', testPin);
      await adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
      report.secure_lock.entered = await until(value => value.secure && value.showing && value.input_restricted && value.screen_state === 'SCREEN_STATE_OFF',
        'Android did not enter its secure PIN keyguard with the screen off');
    },
    async observe() {
      const current = await state();
      assert(current.secure && current.showing && current.input_restricted);
      assert.equal(current.show_notifications, original.show_notifications);
      assert.equal(current.allow_private_notifications, original.allow_private_notifications);
      report.secure_lock.last_observed = current;
      return current;
    },
    async unlock(checkBeforeUnlock) {
      report.secure_lock.after_notification_tap = await this.observe();
      let nodes;
      for (let i = 0; i < 8; i++) {
        nodes = await ui();
        if (nodes.some(n => n.package === 'com.android.systemui' &&
          (n['resource-id']?.endsWith('/pinEntry') || /\bPIN\b/i.test(n.text || n['content-desc'] || '')))) break;
        await sleep(250);
      }
      assert(nodes.some(n => n.package === 'com.android.systemui' &&
        (n['resource-id']?.endsWith('/pinEntry') || /\bPIN\b/i.test(n.text || n['content-desc'] || ''))), 'A notification tap must show the actual system PIN prompt');
      assert(!nodes.some(n => n.package === appId && (n.text || n['content-desc'])), 'Care UI must not be exposed before unlocking');
      await screenshot('native-secure-locked-pin-required');
      await checkBeforeUnlock();
      // Type into the displayed OS prompt; do not bypass it with dismiss-keyguard.
      await adb('shell', 'input', 'text', testPin);
      await adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
      report.secure_lock.unlocked = await until(value => value.secure && !value.showing && !value.input_restricted,
        'Actual PIN entry did not unlock the keyguard');
    },
    async restore() {
      if (!changed) return;
      await adb('shell', 'locksettings', 'clear', '--old', testPin);
      await adb('shell', 'locksettings', 'set-disabled', original.disabled);
      await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
      await adb('shell', 'wm', 'dismiss-keyguard');
      const restored = await until(value => !value.secure && !value.showing && value.disabled === original.disabled,
        'Android did not remove the temporary PIN and restore its original keyguard state');
      report.secure_lock.restored = restored;
      for (const key of ['secure', 'showing', 'input_restricted', 'screen_state', 'disabled', 'show_notifications', 'allow_private_notifications'])
        assert.equal(restored[key], original[key], key);
    },
  };
};
