/* Native 200% text layout and deliberate actions on the fictional emulator only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function largeText({ arm, ui, adb, tapNode, screenshot, pass, owner, caregiver, restricted, fixture, directory, appId, report }) {
  const originalScale = (await adb('shell', 'settings', 'get', 'system', 'font_scale')).trim();
  assert(/^(?:0\.\d+|[12](?:\.\d+)?)$/.test(originalScale));
  assert((await adb('shell', 'wm', 'size')).includes('1080x2400'));
  assert((await adb('shell', 'wm', 'density')).includes('Physical density: 420'));
  const before = await owner.dash();
  const baselineIds = before.notes.map(n => n.id).sort();
  const uploads = () => fs.readFileSync(path.join(directory, 'native-uploads.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  const beforeUploads = uploads();
  report.large_text = { scale: 2, original_scale: originalScale, density_dpi: 420,
    screen_reader_tested: false, controls: [], baseline_note_ids: baselineIds };
  const evidence = report.large_text;
  const cache = '/data/user/0/' + appId + '/cache';
  const bounds = node => node.bounds.match(/\d+/g).map(Number);
  const matching = (nodes, label) => nodes.find(n => n['content-desc'] === label || n.text === label);
  const pending = path.join(directory, 'next-utterance.json');
  let ownsPending = false;
  async function scroll(down, distance = 650, duration = 550) {
    await adb('shell', 'input', 'swipe', '980', down ? '1800' : '600', '980', String(down ? 1800 - distance : 600 + distance), String(duration));
  }
  async function top() {
    // A bounded reset through the current care list; this never activates controls.
    for (let i = 0; i < 12; i++) await scroll(false, 1400, 180);
  }
  async function seek(label, { attempts = 18, actionable = false } = {}) {
    for (let i = 0; i < attempts; i++) {
      const nodes = await ui();
      if (label === 'Cancel recording') {
        evidence.cancel_observations ??= [];
        evidence.cancel_observations.push(nodes.filter(n => n.text || n['content-desc']).map(n => ({
          text: n.text, label: n['content-desc'], bounds: n.bounds, enabled: n.enabled,
        })));
      }
      const node = matching(nodes, label);
      if (node) {
        const [x1, y1, x2, y2] = bounds(node);
        if (x2 > x1 && y2 > y1 && y1 > 150 && y2 < 2250 && node.enabled === 'true') {
          assert(x1 >= 0 && x2 <= 1080, 'Horizontal control overflow: ' + label);
          if (actionable) {
            assert.equal(node.clickable, 'true', label);
            assert(x2 - x1 >= 126 && y2 - y1 >= 126, 'Touch target below 48 logical units: ' + label);
            evidence.controls.push({ label, bounds: node.bounds, width_dp: (x2 - x1) / 2.625, height_dp: (y2 - y1) / 2.625 });
          }
          return node;
        }
        // Android can expose an offscreen node with inverted clipped bounds.
        // Move toward its actual edge without flinging past the control.
        if (y1 >= 2250 || y2 > y1) { await scroll(y1 > 150, 400); continue; }
      }
      await scroll(true);
    }
    throw new Error('Large-text control not fully reachable: ' + label);
  }
  async function tap(label, options = {}) { await tapNode(await seek(label, { ...options, actionable: true })); }
  async function reopen() {
    await adb('shell', 'am', 'force-stop', appId);
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await seek('HELLO, Mei', { attempts: 4 });
  }
  try {
    await adb('shell', 'settings', 'put', 'system', 'font_scale', '2.0');
    await reopen();
    assert.equal((await adb('shell', 'settings', 'get', 'system', 'font_scale')).trim(), '2.0');
    await screenshot('native-large-text-intro');
    await seek('Tap to start recording', { actionable: true });
    await screenshot('native-large-text-talk');

    // Cancel is exercised before creating any scripted proposal.
    await tap('Tap to start recording');
    const started = Date.now();
    await tap('Cancel recording', { attempts: 3 });
    evidence.cancel_elapsed_ms = Date.now() - started;
    assert(evidence.cancel_elapsed_ms < 16000, 'Cancel took too close to the recording ceiling');
    // A UI tap starts asynchronous native stop/delete work; observe its completion.
    for (let i = 0; i < 30; i++) {
      if (!(await adb('shell', 'find', cache, '-type', 'f', '-name', 'recording-*')).trim()) break;
      await sleep(100);
    }
    assert.equal(uploads(), beforeUploads, 'Cancelled capture was uploaded');
    assert.equal((await adb('shell', 'find', cache, '-type', 'f', '-name', 'recording-*')).trim(), '');
    assert.deepEqual((await owner.dash()).notes.map(n => n.id).sort(), baselineIds);
    await top();
    await seek('Stopped. You can speak when you are ready.');
    await screenshot('native-large-text-cancelled');
    pass('At 200% native text size, Talk and Cancel are reachable with at least 48dp targets; cancellation deletes capture without upload');

    const wording = 'Fictional large-text review ' + Date.now();
    evidence.wording = wording;
    await top();
    await seek('Tap to start recording', { actionable: true });
    arm('large-text-note', { intent: 'proposal', kind: 'health_note', payload: {
      wording, occurrence_text: 'after a fictional walk', share_with_user_ids: [fixture.caregiver_id] } });
    ownsPending = true;
    await tap('Tap to start recording');
    await sleep(1000);
    await tap('Recording. Tap to send.', { attempts: 2 });
    for (let i = 0; i < 40; i++) {
      const nodes = await ui();
      if (!fs.existsSync(pending) && matching(nodes, 'Tap to start recording')?.enabled === 'true') break;
      if (i === 39) throw new Error('Native large-text voice turn did not settle');
      await sleep(250);
    }
    assert(!fs.existsSync(pending));
    ownsPending = false;
    assert.equal(uploads(), beforeUploads + 1);
    assert.deepEqual((await owner.dash()).notes.map(n => n.id).sort(), baselineIds);
    await seek('Have I got that right?');
    await screenshot('native-large-text-review');
    await seek('Confirm and save', { actionable: true });
    await seek('Cancel this update', { actionable: true });
    await screenshot('native-large-text-confirm-controls');
    await top();
    await tap('Confirm and save');
    await caregiver.page.getByRole('heading', { name: wording, exact: true }).waitFor();
    const after = (await owner.dash()).notes;
    assert.equal(after.length, baselineIds.length + 1);
    assert.equal(after.filter(n => n.wording === wording).length, 1);
    assert.equal(after.find(n => n.wording === wording).provenance.type, 'phone');
    assert(!(await restricted.dash()).notes.some(n => n.wording === wording));
    evidence.note_id = after.find(n => n.wording === wording).id;
    await caregiver.page.screenshot({ path: path.join(directory, 'native-large-text-caregiver.png'), fullPage: true });
    pass('At 200% native text size, read-back and both proposal actions remain reachable; explicit confirmation saves one permitted phone-sourced note');

    for (const [tab, heading, capture] of [
      ['Today', 'Recent care', 'today'],
      ['Medicines', 'Your checked plan', 'medicines'],
      ['Care', 'Care and follow-ups', 'care'],
      ['Settings', 'This phone', 'settings'],
    ]) {
      await top();
      await tap(tab);
      await seek(heading);
      await screenshot('native-large-text-' + capture);
    }
    await seek('Open phone permission settings', { actionable: true });
    await seek('Open care dashboard', { actionable: true });
    await seek('Unpair this phone', { actionable: true });
    await screenshot('native-large-text-settings-actions');
    await reopen();
    assert.equal((await owner.dash()).notes.filter(n => n.wording === wording).length, 1);
    pass('At 200% text size, all four care tabs and Settings actions are reachable; restart preserves the one confirmed note');
  } catch (error) {
    await adb('shell', 'screencap', '-p', '/sdcard/parse-large-text-failure.png');
    await adb('pull', '/sdcard/parse-large-text-failure.png', path.join(directory, 'native-large-text-failure.png'));
    throw error;
  } finally {
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    if (ownsPending && fs.existsSync(pending)) fs.unlinkSync(pending);
    await adb('shell', 'settings', 'put', 'system', 'font_scale', originalScale);
    evidence.restored_font_scale = (await adb('shell', 'settings', 'get', 'system', 'font_scale')).trim();
    assert.equal(evidence.restored_font_scale, originalScale);
  }
};
