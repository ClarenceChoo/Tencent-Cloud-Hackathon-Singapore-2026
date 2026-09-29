/* Emulator-only incoming calls, native capture/player state and real reminder ACKs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function calls({ find, tap, ui, adb, screenshot, pass, owner, directory, appId, report }) {
  const root = path.resolve(__dirname, '..');
  const number = '15550100001'; // Emulator modem only: no external telephone call.
  const cache = '/data/user/0/' + appId + '/cache';
  const replyFile = path.join(directory, 'reply.wav');
  const originalTone = fs.readFileSync(replyFile);
  const uploads = () => fs.readFileSync(path.join(directory, 'native-uploads.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  const beforeUploads = uploads();
  const beforeNotes = (await owner.dash()).notes.map(n => n.id).sort();
  report.initial_upload_count = beforeUploads;
  report.initial_note_ids = beforeNotes;
  assert((await adb('shell', 'id')).includes('uid=0'));
  async function callState() {
    const dump = (await adb('shell', 'dumpsys', 'telephony.registry')).split('mServiceState=')[0];
    const value = name => Number(dump.match(new RegExp('\\b' + name + '=(\\d+)'))?.[1]);
    const state = { call: value('mCallState'), ringing: value('mRingingCallState'), foreground: value('mForegroundCallState') };
    assert(Object.values(state).every(Number.isFinite));
    return state;
  }
  assert.equal((await callState()).call, 0, 'Do not interrupt an existing emulator call');
  assert((await adb('shell', 'wm', 'size')).includes('1080x2400'), 'Answer coordinates are from the inspected 1080x2400 emulator notification');
  let callCreated = false;
  const uid = (await adb('shell', 'pm', 'list', 'packages', '-U', appId)).match(/\buid:(\d+)/)?.[1];
  assert(uid);
  async function until(check, message, attempts = 30) {
    for (let i = 0; i < attempts; i++) {
      const value = await check();
      if (value) return value;
      await sleep(350);
    }
    throw new Error(message);
  }
  async function control(mode) {
    const { stdout } = await execute(path.join(root, 'backend/.venv/bin/python'),
      [path.join(root, 'tools/android_native_control.py'), mode, '--kind', 'medication', '--data-dir', directory], { timeout: 30000 });
    return JSON.parse(stdout);
  }
  async function audioFiles(prefix) {
    return (await adb('shell', 'find', cache, '-type', 'f', '-name', prefix + '*')).trim().split('\n').filter(Boolean);
  }
  async function players() {
    const dump = await adb('shell', 'dumpsys', 'audio');
    return dump.split('\n').filter(line => line.includes('AudioPlaybackConfiguration') && line.includes('u/pid:' + uid + '/'));
  }
  async function incoming(stage) {
    assert((await adb('emu', 'gsm', 'call', number)).includes('OK'));
    callCreated = true;
    const ringing = await until(async () => {
      const state = await callState();
      return state.call === 1 ? state : null;
    }, 'Emulated incoming call did not reach Android telephony');
    // UIAutomator omits this nonfocused heads-up window. These coordinates are
    // the Answer button observed in call-inspect.png on this exact emulator.
    // Capture the current screen before tapping, and require actual ACTIVE state.
    // Let the heads-up entry finish its animation/touch-protection interval.
    await sleep(1600);
    await adb('shell', 'screencap', '-p', '/sdcard/parse-call-ringing.png');
    await adb('pull', '/sdcard/parse-call-ringing.png', path.join(directory, 'native-call-' + stage + '-ringing.png'));
    if (stage === 'playback') {
      report.players_while_ringing = await players();
      assert(!report.players_while_ringing.some(p => p.includes('state:started')), 'Playback was not interrupted by ringing before Answer');
      const activity = await adb('shell', 'dumpsys', 'activity', 'activities');
      report.app_resumed_while_ringing = activity.split('\n').some(line => line.includes('topResumedActivity=') && line.includes(appId));
    }
    await adb('shell', 'input', 'tap', '545', '427');
    const active = await until(async () => {
      const state = await callState();
      return state.call === 2 && state.foreground === 1 ? state : null;
    }, 'Native dialer did not answer the simulated incoming call');
    report.calls.push({ stage, ringing, active });
    // The call timer animates continuously, so do not wait for UIAutomator idle.
    await adb('shell', 'screencap', '-p', '/sdcard/parse-call-active.png');
    await adb('pull', '/sdcard/parse-call-active.png', path.join(directory, 'native-call-' + stage + '.png'));
  }
  async function endCall() {
    if (callCreated) {
      await adb('emu', 'gsm', 'cancel', number);
      await until(async () => (await callState()).call === 0, 'Simulated call did not end');
      callCreated = false;
    }
  }
  async function foreground() {
    await adb('shell', 'am', 'start', '-W', '-n', appId + '/sg.parse.companion.MainActivity');
    await find('HELLO, Mei');
    await find('Tap to start recording');
  }
  report.calls = [];
  report.call_simulation = 'Android emulator GSM modem and native dialer; no external call, physical handset or acoustic audibility evidence';
  try {
    await find('HELLO, Mei');
    await tap('Tap to start recording');
    await find('Tap to finish', { scroll: false });
    assert((await audioFiles('recording-')).length > 0, 'Native capture file was not created');
    await incoming('recording');
    await until(async () => (await audioFiles('recording-')).length === 0, 'Call interruption did not remove captured audio');
    assert.equal(uploads(), beforeUploads);
    await endCall();
    await foreground();
    assert.equal(uploads(), beforeUploads);
    assert.deepEqual((await owner.dash()).notes.map(n => n.id).sort(), beforeNotes);
    const nodes = await ui();
    assert(!nodes.some(n => n.text === 'Tap to finish'));
    await screenshot('native-call-recording-return');
    pass('An incoming simulated call stops native recording, deletes its cache file and returns without uploading or restarting capture');

    // An 18-second PCM tone gives the native call time to interrupt active playback.
    const frames = 18 * 16000;
    const wav = Buffer.alloc(44 + frames * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
    for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(1500 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + i * 2);
    fs.writeFileSync(replyFile + '.call.tmp', wav);
    fs.renameSync(replyFile + '.call.tmp', replyFile);
    report.call_tone_seconds = 18;
    const queued = await control('enqueue');
    assert(queued.command_id && queued.dose_id);
    report.call_reminder = { id: queued.command_id, dose_id: queued.dose_id };
    await until(async () => (await control('inspect')).attempts.find(a => a.id === queued.command_id)?.acks.some(a => a.stage === 'playback_started'), 'Native reminder did not start');
    report.players_before_call = await players();
    assert(report.players_before_call.some(p => p.includes('state:started')), 'Android did not report an actively playing native audio track');
    await incoming('playback');
    await until(async () => !(await players()).some(p => p.includes('state:started')), 'Native player kept playing during the call');
    await until(async () => (await audioFiles('parse-reply-')).length === 0, 'Interrupted reply cache was retained');
    report.players_during_call = await players();
    await endCall();
    await foreground();
    const interrupted = await until(async () => {
      const attempt = (await control('inspect')).attempts.find(a => a.id === queued.command_id);
      return attempt?.acks.some(a => a.stage === 'interrupted') ? attempt : null;
    }, 'Interrupted playback was not acknowledged');
    assert(!interrupted.acks.some(a => a.stage === 'playback_completed'));
    report.interrupted_reminder = interrupted;
    assert.equal((await owner.dash()).doses.find(d => d.id === queued.dose_id).report_state, 'unconfirmed');
    await screenshot('native-call-playback-return');
    await adb('shell', 'am', 'force-stop', appId);
    await foreground();
    await sleep(5000);
    const after = (await control('inspect')).attempts.find(a => a.id === queued.command_id);
    assert.deepEqual(after, interrupted, 'Interrupted reminder replayed after restart');
    assert(!(await players()).some(p => p.includes('state:started')));
    assert.equal(uploads(), beforeUploads);
    assert.deepEqual((await owner.dash()).notes.map(n => n.id).sort(), beforeNotes);
    report.medication_report = 'unconfirmed';
    pass('A simulated call interrupts actual native reminder playback, removes cached speech, records interruption rather than completion and does not replay or report medication taken');
  } finally {
    fs.writeFileSync(replyFile + '.restore.tmp', originalTone);
    fs.renameSync(replyFile + '.restore.tmp', replyFile);
    await endCall();
    // A failed observation must not leave a recording running to its upload cap.
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  }
};
