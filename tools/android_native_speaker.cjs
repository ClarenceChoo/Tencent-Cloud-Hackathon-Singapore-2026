/* Native speaker setup against the existing fictional loopback service. No live TTS. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function speaker({ find, tap, tapNode, ui, adb, screenshot, pass, owner, fixture, directory, appId, report }) {
  const root = path.resolve(__dirname, '..');
  assert.equal(appId, 'sg.parse.companion.verification');
  assert.equal((await adb('shell','getprop','ro.kernel.qemu')).trim(), '1');
  assert.equal((await adb('shell','settings','get','secure','accessibility_enabled')).trim(), '0');
  assert((await adb('shell','id')).includes('uid=0'));
  const tone = path.join(directory,'reply.wav');
  const original = fs.readFileSync(tone);
  const digest = data => createHash('sha256').update(data).digest('hex');
  const evidence = report.speaker = { original_tone_sha256:digest(original) };
  const dashboard = await owner.dash();
  const device = dashboard.active_companion.device_id;
  const care = d => Object.fromEntries(['notes','measurements','preventive_tasks','support_requests','followups'].map(k=>[k,d[k].map(r=>r.id).sort()]));
  const uploads = () => fs.readFileSync(path.join(directory,'native-uploads.jsonl'),'utf8').trim().split('\n').length;
  async function snapshot() {
    const {stdout} = await execute(path.join(root,'backend/.venv/bin/python'), ['-c', `
import json,sqlite3,sys
from pathlib import Path
p=Path(sys.argv[1]); meta=json.loads((p/'fixture.json').read_text())
assert meta['origin'].startswith('https://127.0.0.1:')
with sqlite3.connect('file:'+str(p/'fixture.db')+'?mode=ro',uri=True) as db:
 assert db.execute("SELECT 1 FROM patients WHERE id=? AND name='Fictional Mei Tan'",(meta['patient_id'],)).fetchone()
 rows=db.execute('SELECT id,duration_ms,content_sha256 FROM audio_assets WHERE device_id=? ORDER BY created_at',(sys.argv[2],)).fetchall()
 print(json.dumps({'assets':[dict(zip(['id','duration_ms','sha256'],r)) for r in rows], 'turns':db.execute('SELECT count(*) FROM voice_turns').fetchone()[0], 'proposals':db.execute('SELECT count(*) FROM confirmation_proposals').fetchone()[0]}))
`, directory, device]);
    return JSON.parse(stdout);
  }
  const cache = () => adb('shell','find','/data/user/0/'+appId+'/cache','-type','f','-name','parse-reply-*.wav');
  const microphone = async () => /android.permission.RECORD_AUDIO: granted=true/.test(await adb('shell','dumpsys','package',appId));
  const audio = async name => {
    const dump = await adb('shell','dumpsys','audio');
    fs.writeFileSync(path.join(directory,name+'.txt'),dump);
    return dump;
  };
  evidence.before = await snapshot(); evidence.care_before=care(dashboard); evidence.route_before=dashboard.active_companion;
  evidence.uploads_before=uploads();evidence.microphone_before=await microphone();
  assert.equal(evidence.microphone_before,false,'Use the freshly reinstalled verification app without microphone access');
  const longTone = Buffer.alloc(44+16000*2*18); original.copy(longTone,0,0,44);
  longTone.writeUInt32LE(longTone.length-8,4);longTone.writeUInt32LE(longTone.length-44,40);
  for(let n=0;n<16000*18;n++)longTone.writeInt16LE(Math.round(1500*Math.sin(2*Math.PI*440*n/16000)),44+n*2);
  evidence.long_tone_sha256=digest(longTone);
  await tap('Settings'); await find('Test speaker');
  await screenshot('native-speaker-ready');
  try {
    fs.writeFileSync(tone,longTone);
    await tap('Test speaker');
    const stop=await find('Stop speaker test',{scroll:false,attempts:3});
    await find('Simulated audio test. This does not verify live speech.',{scroll:false,attempts:3});
    evidence.playback_cache=(await cache()).trim().split('\n').filter(Boolean);
    assert.equal(evidence.playback_cache.length,1);
    const dump=await audio('native-speaker-playing-audio');
    evidence.player_pid=(await adb('shell','pidof',appId)).trim();
    evidence.playback_rows=dump.split('\n').filter(line=>line.includes('/'+evidence.player_pid+' ')&&line.includes('state:started'));
    assert(evidence.playback_rows.length,'No started native player for this app process');
    await screenshot('native-speaker-playing');
    await tapNode(stop);
    await find('Speaker test stopped.',{scroll:false,attempts:4});
    assert.equal((await cache()).trim(),'');
    const stopped=await audio('native-speaker-stopped-audio');
    assert(!stopped.split('\n').some(line=>line.includes('/'+evidence.player_pid+' ')&&line.includes('state:started')));
    assert.equal(await microphone(),false);
    pass('Native Test speaker plays a private fixture clip with microphone denied; explicit Stop releases playback and deletes its cached audio');
    await screenshot('native-speaker-stopped');

    await tap('Test speaker');
    await find('Stop speaker test',{scroll:false,attempts:3});
    await adb('shell','input','keyevent','KEYCODE_HOME');
    await sleep(600);
    assert.equal((await cache()).trim(),'');
    await adb('shell','am','start','-W','-n',appId+'/sg.parse.companion.MainActivity');
    await find('Test speaker');
    const returned = await ui();
    evidence.background_status = returned.map(n=>n.text).filter(t=>t==='Speaker test stopped.'||t==='Speech playback was interrupted.');
    assert(evidence.background_status.length,'Return must retain a truthful stopped/interrupted status');
    assert.equal((await cache()).trim(),'');
    const resumedAudio=await audio('native-speaker-resumed-audio');
    assert(!resumedAudio.split('\n').some(line=>line.includes('/'+evidence.player_pid+' ')&&line.includes('state:started')));
    pass('Backgrounding stops the native speaker check, clears audio and does not resume playback on return');
    await screenshot('native-speaker-resumed');

    fs.writeFileSync(tone,original);
    await tap('Test speaker');
    await sleep(1800);
    const settled=await ui();
    assert(!settled.some(n=>n['content-desc']==='Stop speaker test'));
    assert.equal((await cache()).trim(),'');
    assert.equal(await microphone(),false);
    evidence.after=await snapshot(); evidence.uploads_after=uploads();
    const after=await owner.dash(); evidence.care_after=care(after);evidence.route_after=after.active_companion;
    assert.deepEqual(evidence.care_after,evidence.care_before);
    assert.deepEqual(evidence.route_after,evidence.route_before);
    assert.equal(evidence.after.turns,evidence.before.turns);assert.equal(evidence.after.proposals,evidence.before.proposals);
    assert.equal(evidence.uploads_after,evidence.uploads_before);
    evidence.new_assets=evidence.after.assets.filter(a=>!evidence.before.assets.some(old=>old.id===a.id));
    assert.deepEqual(evidence.new_assets.map(a=>a.duration_ms),[18000,18000,1000]);
    pass('A completed native fixture-tone check leaves pairing, routing, all care records, recording uploads and proposal counts unchanged');
    await screenshot('native-speaker-completed');
  } finally {
    fs.writeFileSync(tone,original);
    evidence.restored_tone_sha256=digest(fs.readFileSync(tone));
    assert.equal(evidence.restored_tone_sha256,evidence.original_tone_sha256);
  }
};
