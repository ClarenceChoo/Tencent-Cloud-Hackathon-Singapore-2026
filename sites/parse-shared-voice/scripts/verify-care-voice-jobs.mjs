import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';

const compiled=await build({entryPoints:[fileURLToPath(new URL('../app/care/care-voice-jobs.ts',import.meta.url))],bundle:true,write:false,format:'esm',target:'es2022'});
const jobs=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('test')}}",compatibilityDate:'2026-05-15',d1Databases:['DB'],host:'127.0.0.1',port:0});
try{
 const db=await mf.getD1Database('DB');
 await db.prepare('CREATE TABLE voice_recordings (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, room_id TEXT NOT NULL)').run();
 await db.prepare('CREATE TABLE care_voice_jobs (recording_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, updated_at INTEGER NOT NULL)').run();
 await db.prepare('CREATE TABLE care_workspaces (owner_id TEXT PRIMARY KEY, version INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)').run();
 const owner='owner',room='room',recording='recording',otherRecording='recording-other';
 await db.prepare('INSERT INTO voice_recordings VALUES (?,?,?)').bind(recording,owner,room).run();
 await db.prepare('INSERT INTO voice_recordings VALUES (?,?,?)').bind(otherRecording,owner,room).run();
 await db.prepare('INSERT INTO care_workspaces VALUES (?,1,?,?)').bind(owner,'{}',Date.now()).run();
 const firstLease=await jobs.acquireVoiceJob(db,owner,recording,room);
 assert.equal((await jobs.acquireVoiceJob(db,owner,recording,room).catch(error=>error.status)),409,'a fresh per-recording lease cannot be duplicated');
 assert.equal((await jobs.acquireVoiceJob(db,owner,otherRecording,room).catch(error=>error.status)),409,'a different fresh recording in the same room is blocked');
 await db.prepare('UPDATE care_voice_jobs SET updated_at=? WHERE recording_id=?').bind(Date.now()-jobs.VOICE_JOB_LEASE_MS-1,recording).run();
 const nextLease=await jobs.acquireVoiceJob(db,owner,recording,room);
 assert(nextLease>firstLease,'reclaimed lease uses a fresh monotonic fencing token');
 await jobs.failVoiceJob(db,owner,recording,firstLease);
 let job=await db.prepare('SELECT state,updated_at FROM care_voice_jobs WHERE recording_id=?').bind(recording).first();
 assert.equal(job.state,'processing');assert.equal(job.updated_at,nextLease,'late failure cannot release the replacement lease');
 const context={state:{proposals:[{same:'intentionally identical result'}]},workspace:{owner_id:owner,version:1,state_json:'{}'}};
 const staleResult={transcript:'same',proposal:{same:'intentionally identical result'}};
 await assert.rejects(jobs.finishVoiceJob(db,context,owner,recording,firstLease,staleResult),error=>error.status===409,'late completion with an identical result must fail its lease fence');
 const unchanged=await db.prepare('SELECT version,state_json FROM care_workspaces WHERE owner_id=?').bind(owner).first();
 assert.equal(unchanged.version,1);assert.equal(unchanged.state_json,'{}');
 await jobs.finishVoiceJob(db,context,owner,recording,nextLease,staleResult);
 job=await db.prepare('SELECT state,updated_at,result_json FROM care_voice_jobs WHERE recording_id=?').bind(recording).first();
 assert.equal(job.state,'ready');assert.equal(job.updated_at,nextLease);assert.equal(job.result_json,JSON.stringify(staleResult));
 const saved=await db.prepare('SELECT version,state_json FROM care_workspaces WHERE owner_id=?').bind(owner).first();
 assert.equal(saved.version,2);assert.equal(saved.state_json,JSON.stringify(context.state));
 assert.equal((await jobs.acquireVoiceJob(db,owner,recording,room).catch(error=>error.status)),409,'a ready idempotent result cannot be overwritten');
 const versionRecording='recording-version-conflict',versionRoom='room-version-conflict';
 await db.prepare('INSERT INTO voice_recordings VALUES (?,?,?)').bind(versionRecording,owner,versionRoom).run();
 const versionLease=await jobs.acquireVoiceJob(db,owner,versionRecording,versionRoom);
 await db.prepare('UPDATE care_workspaces SET version=version+1,state_json=? WHERE owner_id=?').bind('{"changed":true}',owner).run();
 const staleContext={state:{must_not:'persist'},workspace:{owner_id:owner,version:2,state_json:'{"changed":true}'}};
 await assert.rejects(jobs.finishVoiceJob(db,staleContext,owner,versionRecording,versionLease,{transcript:'late'}),error=>error.status===409,'a changed workspace version rejects an old result');
 const conflictedJob=await db.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(versionRecording).first();
 const conflictedWorkspace=await db.prepare('SELECT version,state_json FROM care_workspaces WHERE owner_id=?').bind(owner).first();
 assert.equal(conflictedJob.state,'processing');assert.equal(conflictedWorkspace.version,3);assert.equal(conflictedWorkspace.state_json,'{"changed":true}');
 const retryRecording='recording-retry-limit',retryRoom='room-retry-limit';
 await db.prepare('INSERT INTO voice_recordings VALUES (?,?,?)').bind(retryRecording,owner,retryRoom).run();
 for(let attempt=1;attempt<=jobs.MAX_VOICE_JOB_ATTEMPTS;attempt++){
  const lease=await jobs.acquireVoiceJob(db,owner,retryRecording,retryRoom);
  const processing=await db.prepare('SELECT result_json FROM care_voice_jobs WHERE recording_id=?').bind(retryRecording).first();
  assert.equal(JSON.parse(processing.result_json).attempts,attempt,`acquisition records attempt ${attempt}`);
  await jobs.failVoiceJob(db,owner,retryRecording,lease);
 }
 const retryFailure=await jobs.acquireVoiceJob(db,owner,retryRecording,retryRoom).catch(error=>error);
 assert.equal(retryFailure.status,429);assert.match(retryFailure.message,/after three attempts/);
 const failed=await db.prepare('SELECT state,result_json FROM care_voice_jobs WHERE recording_id=?').bind(retryRecording).first();
 assert.equal(failed.state,'failed');assert.equal(JSON.parse(failed.result_json).attempts,jobs.MAX_VOICE_JOB_ATTEMPTS,'failed job keeps only its bounded attempt counter');
 const frozenRecording='recording-frozen-clock',frozenRoom='room-frozen-clock',originalNow=Date.now;
 await db.prepare('INSERT INTO voice_recordings VALUES (?,?,?)').bind(frozenRecording,owner,frozenRoom).run();
 Date.now=()=>1_800_000_000_000;
 try{
  const lease1=await jobs.acquireVoiceJob(db,owner,frozenRecording,frozenRoom);await jobs.failVoiceJob(db,owner,frozenRecording,lease1);
  const lease2=await jobs.acquireVoiceJob(db,owner,frozenRecording,frozenRoom);assert(lease2>lease1,'second same-millisecond lease is distinct');await jobs.failVoiceJob(db,owner,frozenRecording,lease2);
  const lease3=await jobs.acquireVoiceJob(db,owner,frozenRecording,frozenRoom);assert(lease3>lease2,'third same-millisecond lease is distinct');
  await jobs.failVoiceJob(db,owner,frozenRecording,lease1);
  const frozen=await db.prepare('SELECT state,updated_at FROM care_voice_jobs WHERE recording_id=?').bind(frozenRecording).first();
  assert.equal(frozen.state,'processing');assert.equal(frozen.updated_at,lease3,'late failure cannot match a reused millisecond token');
  await jobs.failVoiceJob(db,owner,frozenRecording,lease3);
 }finally{Date.now=originalNow;}
 const finished=await db.prepare('SELECT result_json FROM care_voice_jobs WHERE recording_id=?').bind(recording).first();
 assert.equal(finished.result_json,JSON.stringify(staleResult),'completed cache exposes the real result without attempt metadata');
 console.log(JSON.stringify({passed:true,checks:['fresh same-recording acquisition rejected','different fresh recording in same room blocked','reclaimed lease fenced by monotonic token','late failure cannot fail a replacement lease','late completion with identical result cannot write workspace','workspace version conflict rejects job and state writes','current lease atomically saves ready result and workspace state','ready result is never reacquired','failed retries count to three and the fourth call is rejected','ready cache overwrites internal attempt metadata with actual result','leases remain unique across same-millisecond failures'],sqlProbe:'SQLite lease token predicate verified in isolated Miniflare D1; changes() is not used'},null,2));
}finally{await mf.dispose();}
