/* Actual recent-apps swipe on the smoke harness's disposable emulator. */
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function recentsCheck({ adb, ui, screenshot, appId, report }) {
  async function state() {
    const dump = await adb('shell', 'dumpsys', 'activity', 'recents');
    const tasks = dump.split(/(?=^\s*\* Recent #\d+:)/m).filter(block =>
      block.includes('mActivityComponent=' + appId + '/sg.parse.companion.MainActivity')).map(block => {
      const id = block.match(/^\s*\* Recent #\d+: Task\{[^\n]*?#(\d+)\b/m)?.[1];
      assert(id, 'Expected task identity from the actual Recent tasks section');
      return Number(id);
    });
    let pid;
    try { pid = (await adb('shell', 'pidof', appId)).trim(); }
    catch (error) { if (error.code !== 1) throw error; pid = null; }
    const pkg = await adb('shell', 'dumpsys', 'package', appId);
    const user = pkg.split('\n').find(line => line.includes('User 0:'));
    assert(user && /\bstopped=(true|false)/.test(user));
    return { at: new Date().toISOString(), task_ids: tasks, pid,
      package_stopped: /\bstopped=true\b/.test(user) };
  }
  const original = await state();
  assert.equal(original.task_ids.length, 1, 'Dismiss exactly one known verification task');
  assert(original.pid && !original.package_stopped);
  report.recents = { original, note: 'Actual upward swipe of the Parse local verification card. Task removal, process presence and package stopped state are recorded separately; no am kill or force-stop is used.' };
  return {
    async dismiss() {
      await adb('shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH');
      let card;
      for (let i = 0; i < 8; i++) {
        card = (await ui()).find(n => n.package === 'com.android.launcher3' &&
          n['resource-id']?.endsWith('/snapshot') && n['content-desc'] === 'Parse local verification');
        if (card) break;
        await sleep(250);
      }
      assert(card, 'Select the real verification card from the native overview');
      const [x1, y1, x2, y2] = card.bounds.match(/\d+/g).map(Number);
      assert(x2 - x1 > 300 && y2 - y1 > 400 && x1 >= 0);
      const x = Math.round((x1 + x2) / 2), startY = Math.round((y1 + y2) / 2);
      report.recents.gesture = { card_label: card['content-desc'], bounds: card.bounds, from: [x, startY], to: [x, 40], duration_ms: 350 };
      await screenshot('native-recents-card-before-swipe');
      await adb('shell', 'input', 'swipe', String(x), String(startY), String(x), '40', '350');
      let current;
      for (let i = 0; i < 30; i++) {
        current = await state();
        if (current.task_ids.length === 0) break;
        await sleep(250);
      }
      report.recents.after_swipe = current;
      assert.equal(current.task_ids.length, 0, 'The actual verification task must be removed');
      assert(!current.package_stopped, 'A recents swipe must not be reported as a force-stop');
      await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
      await screenshot('native-recents-dismissed');
    },
    async observe() {
      const current = await state();
      assert.equal(current.task_ids.length, 0, 'No Parse task may reopen before the notification is tapped');
      assert(!current.package_stopped);
      report.recents.last_observed = current;
      return current;
    },
    async opened() {
      const current = await state();
      assert.equal(current.task_ids.length, 1);
      assert(!original.task_ids.includes(current.task_ids[0]), 'Opening should create a new task after dismissal');
      assert(current.pid && !current.package_stopped);
      report.recents.after_opening = current;
    },
  };
};
