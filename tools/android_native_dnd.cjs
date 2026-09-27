/* Interruption-policy checks only for the smoke harness's disposable emulator. */
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function comparablePolicy(policy) {
  // Android reconstitutes these deprecated aggregate flags from the specific
  // effects. Compare their effective restrictions without ignoring other fields.
  // https://developer.android.com/reference/android/app/NotificationManager.Policy#suppressedVisualEffects
  return policy.replace(/suppressedVisualEffects=([^\]]*?)(?=,hasPriorityChannels=)/, (_, value) => {
    const effects = new Set(value.split(',').filter(Boolean));
    if (effects.delete('SUPPRESSED_EFFECT_SCREEN_OFF')) {
      for (const name of ['FULL_SCREEN_INTENT', 'LIGHTS', 'AMBIENT']) effects.add('SUPPRESSED_EFFECT_' + name);
    }
    if (effects.delete('SUPPRESSED_EFFECT_SCREEN_ON')) effects.add('SUPPRESSED_EFFECT_PEEK');
    return 'suppressedVisualEffects=' + [...effects].sort().join(',');
  });
}

module.exports = async function dndCheck({ adb, report }) {
  async function state() {
    const dump = await adb('shell', 'dumpsys', 'notification', '--noredact');
    const zen = dump.split('\n  Zen Mode:\n')[1]?.split('\n  Zen Log:')[0];
    assert(zen, 'Android did not expose its current interruption policy');
    return {
      at: new Date().toISOString(),
      setting: (await adb('shell', 'settings', 'get', 'global', 'zen_mode')).trim(),
      mode: zen.match(/\bmZenMode=(\w+)/)?.[1],
      interruption_filter: Number(zen.match(/\bmInterruptionFilter=(\d+)/)?.[1]),
      consolidated_policy: zen.match(/\bmConsolidatedPolicy=(.+)/)?.[1],
    };
  }
  const original = await state();
  assert.equal(original.setting, '0', 'Do not disturb a pre-existing DND test');
  assert.equal(original.mode, 'ZEN_MODE_OFF');
  assert.equal(original.interruption_filter, 1);
  assert(original.consolidated_policy);
  report.dnd = { original, note: 'Actual Android interruption policy and per-notification interception; host audio is disabled, so no acoustic silence or audibility is established.' };
  let changed = false;
  async function waitFor(setting, mode, filter) {
    for (let i = 0; i < 20; i++) {
      const current = await state();
      if (current.setting === setting && current.mode === mode && current.interruption_filter === filter) return current;
      await sleep(250);
    }
    throw new Error('Android did not apply the expected Do Not Disturb policy');
  }
  return {
    async enter() {
      changed = true;
      await adb('shell', 'cmd', 'notification', 'set_dnd', 'none');
      report.dnd.entered = await waitFor('2', 'ZEN_MODE_NO_INTERRUPTIONS', 3);
    },
    async observe() {
      const current = await state();
      assert.equal(current.setting, '2');
      assert.equal(current.mode, 'ZEN_MODE_NO_INTERRUPTIONS');
      assert.equal(current.interruption_filter, 3);
      report.dnd.last_observed = current;
      return current;
    },
    async inspect(record) {
      report.dnd.at_notification = await this.observe();
      const channel = record.match(/\beffectiveNotificationChannel=(.+)/)?.[1];
      const intercepted = record.match(/^\s*mIntercept=(true|false)\s*$/m)?.[1];
      assert(channel?.includes("mId='parse-care'"), 'Inspect the exact Parse care channel');
      assert(channel.includes('mBypassDnd=false'), 'Parse must not bypass Do Not Disturb');
      assert.equal(intercepted, 'true', 'Android must intercept this exact notification under DND');
      report.dnd.notification = {
        intercepted: true,
        suppressed_visual_effects: Number(record.match(/^\s*mSuppressedVisualEffects=\s*(\d+)/m)?.[1]),
        channel,
      };
      assert(Number.isFinite(report.dnd.notification.suppressed_visual_effects));
    },
    async restore() {
      if (!changed) return;
      await adb('shell', 'cmd', 'notification', 'set_dnd', 'off');
      const restored = await waitFor(original.setting, original.mode, original.interruption_filter);
      report.dnd.restored = restored;
      assert.equal(comparablePolicy(restored.consolidated_policy), comparablePolicy(original.consolidated_policy));
      report.dnd.restored_effective_policy_matches = true;
    },
  };
};
