import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const root=new URL('../',import.meta.url),baselineIndex=process.argv.indexOf('--baseline'),baseline=baselineIndex!==-1,baselineRef=baseline?process.argv[baselineIndex+1]:null;
if(baseline){assert(baselineRef&&!baselineRef.startsWith('--'),'Pass a commit ref after --baseline.');execFileSync('git',['rev-parse','--verify',`${baselineRef}^{commit}`],{cwd:fileURLToPath(root),stdio:'pipe'});}
async function moduleAt(path){
  const bundle=await build({entryPoints:[fileURLToPath(new URL(path,root))],bundle:true,write:false,format:'esm',target:'es2022',plugins:baseline?[{name:'baseline-finish',setup(builder){builder.onLoad({filter:/\/app\/voice-backend\.ts$/},args=>({contents:execFileSync('git',['show',`${baselineRef}:sites/parse-shared-voice/app/voice-backend.ts`],{cwd:fileURLToPath(root),encoding:'utf8'}),loader:'ts',resolveDir:dirname(args.path)}));}}]:[]});
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}
const [{serveAuthorizedVoice},{serveVoice,wave},{serveCare,interpretRelayRecording},{proposalDestination},{buildCareActions},{forwardPhone}]=await Promise.all([
  moduleAt('app/voice-http.ts'),moduleAt('app/voice-backend.ts'),moduleAt('app/care/care-backend.ts'),moduleAt('app/care/voice-result.ts'),moduleAt('app/care/careActions.ts'),moduleAt('../parse-phone-companion/app/phone-proxy.ts'),
]);
const tools=JSON.parse(await readFile(new URL('app/care/tool-definitions.json',root),'utf8'));
const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('isolated fictional phone test')}}",compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET'],host:'127.0.0.1',port:0});
const originalFetch=globalThis.fetch,owner={userId:'phone-owner',email:'phone-owner@example.test'},peer={userId:'phone-peer',email:'phone-peer@example.test'};
const origin='https://private-phone.test',publicOrigin='https://public-phone.test';
let transcript='Fictional walk this morning.',providerResponse=null,providerHook=null,asrFailure=false,modelCalls=0;
const checks=[];
function call(name,args){return {status:'completed',output:[{type:'function_call',name,arguments:JSON.stringify(args),status:'completed'}]};}
function proposalCall(name,payload){
  let schema=tools.find(tool=>tool.name===name).parameters.properties.payload;
  if(schema.anyOf)schema=schema.anyOf.find(option=>name==='report_medication'?option.properties.report_state.enum.includes(payload.report_state):option.properties.task_id.type===(payload.task_id?'string':'null'));
  return call(name,{operation:'propose',payload:Object.fromEntries(Object.keys(schema.properties).map(key=>[key,payload[key]??null]))});
}
const note=words=>proposalCall('propose_health_note',{wording:words,share_with_user_ids:[]});
globalThis.fetch=async(url,options)=>{
  assert.equal(options.redirect,'manual');
  if(url==='https://api.openai.com/v1/audio/transcriptions')return asrFailure?Response.json({error:'synthetic ASR failure'},{status:503}):Response.json({text:transcript});
  assert.equal(url,'https://api.openai.com/v1/responses');modelCalls++;
  if(providerHook)await providerHook();
  return providerResponse instanceof Error?Response.json({error:'synthetic model failure'},{status:503}):Response.json(providerResponse);
};
try{
  const DB=await mf.getD1Database('DB'),BUCKET=await mf.getR2Bucket('BUCKET');
  const bindings={DB,BUCKET,PUBLIC_SITE_ORIGIN:origin,PUBLIC_PHONE_ORIGIN:publicOrigin,DASHBOARD_ALLOWED_EMAILS:`${owner.email},${peer.email}`,OPENAI_API_KEY:'fictional-test-key'};
  for(const name of (await readdir(new URL('drizzle/',root))).filter(name=>name.endsWith('.sql')).sort())for(const sql of (await readFile(new URL(`drizzle/${name}`,root),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await DB.prepare(sql).run();
  async function value(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  async function care(path,data,user=owner){const headers=new Headers();if(data!==undefined){headers.set('Origin',origin);headers.set('X-CSRF-Token','parse-care');headers.set('Content-Type','application/json');}return serveCare(new Request(`${origin}/v1/${path}`,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)}),user,bindings,globalThis.fetch);}
  const session=await value(await care('auth/session')),prefix=`app/patients/${session.patients[0].id}`;
  await value(await care('auth/session',undefined,peer));
  const dashboard=async()=>value(await care(`${prefix}/dashboard`));
  const state=async()=>JSON.parse((await DB.prepare('SELECT state_json FROM care_workspaces WHERE owner_id=?').bind(owner.userId).first()).state_json);
  async function voice(path,{data,bytes,cookie,user=owner,raw=false}={}){const headers=new Headers();if(data!==undefined||bytes){headers.set('Origin',origin);headers.set('X-Parse-Voice','1');headers.set('Content-Type',bytes?'audio/wav':'application/json');}if(cookie)headers.set('Cookie',cookie);const request=new Request(`${origin}/api/voice/${path}`,{method:data!==undefined||bytes?'POST':'GET',headers,body:bytes??(data===undefined?undefined:JSON.stringify(data))});return raw?serveVoice(request,user?.userId??null,bindings,(id,rid)=>interpretRelayRecording(bindings,id,rid)):serveAuthorizedVoice(request,user,bindings);}
  async function pair(){const made=await value(await voice('rooms',{data:{}}),201),claimed=await voice(`phone/rooms/${made.room.id}/claim`,{user:null,data:{token:new URL(made.phonePath,origin).hash.slice(6)}}),cookie=claimed.headers.get('Set-Cookie').split(';')[0],claim=await value(claimed,201);await value(await voice(`rooms/${made.room.id}/approve`,{data:{code:claim.room.code}}));return {room:made.room.id,cookie};}
  const connection=await pair();
  async function record(connectionOverride=connection){const {room,cookie}=connectionOverride;const created=await value(await voice('phone/recordings',{user:null,cookie,data:{roomId:room}}),201);const id=created.recording.id;await value(await voice(`phone/recordings/${id}/chunks/0`,{user:null,cookie,bytes:wave(new Uint8Array(32000))}));return id;}
  const finish=(id,connectionOverride=connection,raw=false)=>voice(`phone/recordings/${id}/finish`,{user:null,cookie:connectionOverride.cookie,data:{chunks:1},raw});
  const inbox=async(user=owner)=>value(await voice('recordings',{user}));
  const metadata=async(id)=>(await inbox()).recordings.find(row=>row.id===id).interpretation;
  const before=await dashboard();providerResponse=note('Fictional walk this morning.');
  providerHook=async()=>assert.equal((await metadata(first)).state,'processing');
  const first=await record(),finished=await value(await finish(first));providerHook=null;
  assert.equal(modelCalls,1,'approved browser phone finish must invoke the model before manual interpretation');
  assert.equal(finished.recording.state,'ready');assert.equal(finished.recording.transcript,null);assert.equal(finished.recording.audioUrl,null);assert.equal(finished.relay,undefined);
  let latest=await dashboard();const proposal=latest.proposals.find(item=>item.payload.wording==='Fictional walk this morning.');
  assert.equal(proposal.kind,'health_note');assert.equal(proposal.status,'pending');assert.equal(latest.notes.length,before.notes.length);
  let info=await metadata(first);assert.equal(info.state,'ready');assert.equal(info.category,'health_note');assert.equal(info.proposalStatus,'pending');assert.equal(info.proposalId,proposal.id);assert.equal(info.readback,proposal.readback);assert.equal(proposalDestination(info.category).view,'timeline');
  assert.deepEqual((await inbox(peer)).recordings,[]);assert.equal((await voice('phone/recordings',{user:null,cookie:connection.cookie})).status,404);
  checks.push('Approved phone finish prepares a pending categorized dashboard proposal automatically, saves no care record, and masks all private care results.');
  const count=modelCalls;await value(await finish(first));await value(await care(`${prefix}/voice-interpretation`,{recording_id:first}));await inbox();await dashboard();assert.equal(modelCalls,count);
  await value(await care(`app/proposals/${proposal.id}/confirm`,{confirmed:true}));latest=await dashboard();assert.equal(latest.notes.length,before.notes.length+1);assert.equal(latest.notes[0].wording,'Fictional walk this morning.');assert.equal((await metadata(first)).proposalStatus,'committed');assert.match((await metadata(first)).readback,/confirmed and saved/);
  checks.push('Finish and explicit review reuse the cache. Read-only polling never calls the model. Confirm persists the category record and refreshes metadata.');
  const categoryCases=[
    ['record_measurement','measurement','timeline',{measurement_type:'blood_pressure',systolic:120,diastolic:80,unit:'mmHg',occurrence_text:'this morning',timezone:'Asia/Singapore',source_description:'fictional home monitor',reporting_actor:'patient'}],
    ['report_medication','medication_report','medications',{dose_instance_id:latest.doses.find(item=>item.report_state==='unconfirmed').id,report_state:'reported_not_yet'}],
    ['update_preventive_task','preventive_task','care',{task_type:'Fictional care task',description:'Fictional task from a stated plan.',source:'Fictional entered plan',due_date:new Date().toISOString().slice(0,10),timezone:'Asia/Singapore',state:'planned'}],
    ['request_support','support_request','support',{request_text:'Fictional transport request.',recipient_user_id:owner.email,urgency:'routine'}],
    ['update_followup','followup','support',{related_type:'support_request',related_id:latest.support_requests[0].id,check_at:new Date(Date.now()+86400000).toISOString(),permission_scope:'private',resolution_state:'open'}],
  ];
  transcript='My blood pressure was 120 over 80 this morning from my fictional home monitor.';
  for(const [name,kind,view,payload] of categoryCases){providerResponse=proposalCall(name,payload);const rid=await record();await value(await finish(rid));info=await metadata(rid);assert.equal(info.category,kind);assert.equal(info.proposalStatus,'pending');assert.equal(proposalDestination(kind).view,view);const actions=buildCareActions(await dashboard(),owner.userId,Date.now());assert.equal(actions.find(item=>item.sourceId===info.proposalId).targetView,view);}
  checks.push('All six proposal kinds reach their matching dashboard tabs and CareAction destinations.');
  providerResponse=call('respond_to_user',{intent:'clarify',spoken_text:'When was that reading taken?'});const question=await record();await value(await finish(question,connection,true));assert.equal((await metadata(question)).intent,'clarify');assert.equal((await metadata(question)).readback,'When was that reading taken?');assert.equal((await metadata(question)).category,null);
  const old=await record();await DB.prepare("UPDATE voice_recordings SET state='ready',transcript=? WHERE id=?").bind('Fictional old transcript.',old).run();assert.equal((await metadata(old)).state,'waiting');assert.equal((await DB.prepare('SELECT error_code FROM voice_recordings WHERE id=?').bind(old).first()).error_code,null);assert.equal(await DB.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(old).first(),null);providerResponse=note('Explicit old transcript review.');await value(await care(`${prefix}/voice-interpretation`,{recording_id:old}));assert.equal((await metadata(old)).category,'health_note');
  checks.push('Clarification read-back appears without a proposal. Older transcripts remain explicitly reviewable.');
  transcript='Fictional note before a provider failure.';providerResponse=new Error('synthetic');const failed=await record(),failedFinish=await value(await finish(failed));assert.equal(failedFinish.recording.state,'ready');assert.equal(failedFinish.recording.errorCode,'interpretation_unavailable');assert.equal(failedFinish.relay,undefined);assert.equal(failedFinish.recording.transcript,null);assert.equal((await metadata(failed)).state,'failed');assert.equal((await DB.prepare('SELECT transcript,audio_key FROM voice_recordings WHERE id=?').bind(failed).first()).transcript,transcript);assert(await BUCKET.get(`voice/${failed}/complete.wav`));
  providerResponse=note('Recovered fictional note.');await value(await care(`${prefix}/voice-interpretation`,{recording_id:failed}));assert.equal((await metadata(failed)).state,'ready');assert.equal((await metadata(failed)).proposalStatus,'pending');assert.equal((await DB.prepare('SELECT error_code FROM voice_recordings WHERE id=?').bind(failed).first()).error_code,null);const recoveredCount=modelCalls;await value(await finish(failed));assert.equal(modelCalls,recoveredCount);
  providerResponse=call('propose_health_note',{operation:'propose',payload:{wording:'malformed'}});const bad=await record(),proposalCount=(await state()).proposals.length;await value(await finish(bad));assert.equal((await metadata(bad)).state,'failed');assert.equal((await state()).proposals.length,proposalCount);
  asrFailure=true;const empty=await record(),asrCount=modelCalls;await value(await finish(empty));assert.equal(modelCalls,asrCount);assert.equal((await DB.prepare('SELECT error_code FROM voice_recordings WHERE id=?').bind(empty).first()).error_code,'transcription_unavailable');assert(await BUCKET.get(`voice/${empty}/complete.wav`));asrFailure=false;
  transcript='!!!';providerResponse=note('Must not save.');const invalid=await record(),invalidCount=modelCalls,invalidFinish=await value(await finish(invalid));assert.equal(invalidFinish.recording.errorCode,'interpretation_unavailable');assert.equal(invalidFinish.recording.transcript,null);assert.equal(invalidFinish.relay,undefined);assert.equal(modelCalls,invalidCount);assert.equal((await state()).proposals.length,proposalCount);assert.equal((await metadata(invalid)).state,'failed','unclear speech must report an interpretation failure');assert.equal(await DB.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(invalid).first(),null);
  transcript='x'.repeat(8001);const oversized=await record();await value(await finish(oversized));assert.equal(modelCalls,invalidCount);assert.equal((await metadata(oversized)).state,'failed');assert.equal(await DB.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(oversized).first(),null);
  checks.push('Provider failure preserves transcript and audio. Explicit retry succeeds and reuses its cache. Malformed output, absent transcript, and unclear speech create no proposals.');
  transcript='Fictional delayed revoked note.';providerResponse=note(transcript);
  for(const mode of ['room','owner','expiry']){const isolated=await pair(),rid=await record(isolated),snapshot=(await state()).proposals.length;providerHook=async()=>{if(mode==='room')await DB.prepare("UPDATE voice_rooms SET state='revoked' WHERE id=?").bind(isolated.room).run();else if(mode==='expiry')await DB.prepare('UPDATE voice_rooms SET expires_at=? WHERE id=?').bind(Date.now()-1,isolated.room).run();else bindings.DASHBOARD_ALLOWED_EMAILS=peer.email;};const result=await finish(rid,isolated);assert([200,403,410].includes(result.status));assert.equal((await state()).proposals.length,snapshot);assert.equal((await DB.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(rid).first()).state,'failed');providerHook=null;bindings.DASHBOARD_ALLOWED_EMAILS=`${owner.email},${peer.email}`;}
  const denied=await pair(),deniedId=await record(denied),deniedCount=modelCalls;bindings.DASHBOARD_ALLOWED_EMAILS=peer.email;await value(await finish(deniedId,denied));assert.equal(modelCalls,deniedCount);bindings.DASHBOARD_ALLOWED_EMAILS=`${owner.email},${peer.email}`;assert.equal((await metadata(deniedId)).state,'failed');assert.equal(await DB.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(deniedId).first(),null);
  checks.push('Owner allowlist, room approval, and expiry are rechecked before the model and before persistence. Revocation during the provider creates no proposal.');
  const workspace=await DB.prepare('SELECT state_json FROM care_workspaces WHERE owner_id=?').bind(owner.userId).first(),changed=JSON.parse(workspace.state_json),pending=changed.proposals.find(item=>item.status==='pending'&&item.kind==='measurement');pending.expires_at=new Date(Date.now()-1).toISOString();await DB.prepare('UPDATE care_workspaces SET state_json=? WHERE owner_id=?').bind(JSON.stringify(changed),owner.userId).run();
  const expiredRow=(await inbox()).recordings.find(item=>item.interpretation?.proposalId===pending.id);assert.equal(expiredRow.interpretation.proposalStatus,'expired');const expiredCount=modelCalls;await value(await finish(expiredRow.id));assert.equal(modelCalls,expiredCount);assert.equal((await metadata(expiredRow.id)).proposalStatus,'expired');
  const revised=await value(await care(`app/proposals/${(await metadata(failed)).proposalId}/revise`,{payload:{wording:'Revised fictional note.',share_with_user_ids:[]}}),201);assert.equal((await metadata(failed)).proposalId,revised.id);assert.equal((await metadata(failed)).readback,revised.readback);
  const ready=(await state()).proposals.find(item=>item.id===revised.id);ready.status='replaced';ready.replaced_by_id=proposal.id;const replacedState=await state();replacedState.proposals[replacedState.proposals.findIndex(item=>item.id===ready.id)]=ready;await DB.prepare('UPDATE care_workspaces SET state_json=? WHERE owner_id=?').bind(JSON.stringify(replacedState),owner.userId).run();assert.equal((await metadata(failed)).proposalStatus,'replaced');
  checks.push('Owner metadata derives committed, expired, revised, and replaced states from current proposals. Expired recordings do not create another model call.');
  transcript='Fictional note after another room job.';providerResponse=note(transcript);
  let releaseProvider,notifyProvider;const heldProvider=new Promise(resolve=>{releaseProvider=resolve;}),providerStarted=new Promise(resolve=>{notifyProvider=resolve;});
  providerHook=async()=>{notifyProvider();await heldProvider;};const active=await record(),activeFinish=finish(active);await providerStarted;
  await DB.prepare("UPDATE voice_recordings SET error_code='interpretation_unavailable' WHERE id=?").bind(active).run();assert.equal((await metadata(active)).state,'processing');
  const blocked=await record(),blockedCalls=modelCalls;await value(await finish(blocked));assert.equal((await metadata(blocked)).state,'failed');assert.equal(await DB.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(blocked).first(),null);
  await value(await care(`${prefix}/voice-interpretation`,{recording_id:blocked}),409);assert.equal(modelCalls,blockedCalls);assert.equal(await DB.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(blocked).first(),null);
  releaseProvider();await value(await activeFinish);providerHook=null;assert.equal((await metadata(blocked)).state,'failed');assert.equal((await metadata(active)).state,'ready');
  await value(await care(`${prefix}/voice-interpretation`,{recording_id:blocked}));assert.equal(modelCalls,blockedCalls+1);assert.equal((await metadata(blocked)).state,'ready');assert.equal((await DB.prepare('SELECT error_code FROM voice_recordings WHERE id=?').bind(blocked).first()).error_code,null);
  await DB.prepare("UPDATE voice_recordings SET error_code='interpretation_unavailable' WHERE id=?").bind(blocked).run();assert.equal((await metadata(blocked)).state,'ready');const cachedFinish=await value(await finish(blocked));assert.equal(modelCalls,blockedCalls+1);assert.equal(cachedFinish.recording.errorCode,null);
  checks.push('A busy room fails the new recording without a job or provider call. It stays failed until explicit retry after the room is idle. Current processing and ready jobs override the failure marker, and cached success clears it.');
  transcript='Fictional note over the daily interpretation limit.';providerResponse=note(transcript);const capped=await record(),capCalls=modelCalls,capAt=Date.now();
  const jobCount=(await DB.prepare('SELECT COUNT(*) AS count FROM care_voice_jobs WHERE owner_id=? AND updated_at>?').bind(owner.userId,capAt-86400000).first()).count;
  const fixtureJobs=[];for(let index=jobCount;index<100;index++){const id=crypto.randomUUID();fixtureJobs.push(DB.prepare("INSERT INTO voice_recordings (id,room_id,owner_id,client_type,state,next_sequence,frames,created_at,updated_at,transcript) VALUES (?,?,?,'phone','ready',1,16000,?,?,?)").bind(id,connection.room,owner.userId,capAt-86400001,capAt,'Fictional limit fixture.'),DB.prepare("INSERT INTO care_voice_jobs (recording_id,owner_id,state,result_json,updated_at) VALUES (?,?,'failed',?,?)").bind(id,owner.userId,JSON.stringify({attempts:1}),capAt));}await DB.batch(fixtureJobs);
  const cappedFinish=await value(await finish(capped));assert.equal(cappedFinish.recording.errorCode,'interpretation_unavailable');assert.equal((await metadata(capped)).state,'failed');assert.equal(modelCalls,capCalls);assert.equal(await DB.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(capped).first(),null);
  await value(await care(`${prefix}/voice-interpretation`,{recording_id:capped}),429);assert.equal(modelCalls,capCalls);assert.equal(await DB.prepare('SELECT state FROM care_voice_jobs WHERE recording_id=?').bind(capped).first(),null);assert.equal((await DB.prepare('SELECT COUNT(*) AS count FROM care_voice_jobs WHERE owner_id=? AND updated_at>?').bind(owner.userId,capAt-86400000).first()).count,100);
  await DB.prepare('UPDATE care_voice_jobs SET updated_at=? WHERE recording_id IN (SELECT id FROM voice_recordings WHERE created_at=?)').bind(capAt-86400001,capAt-86400001).run();await value(await care(`${prefix}/voice-interpretation`,{recording_id:capped}));assert.equal(modelCalls,capCalls+1);assert.equal((await metadata(capped)).state,'ready');assert.equal((await DB.prepare('SELECT error_code FROM voice_recordings WHERE id=?').bind(capped).first()).error_code,null);
  checks.push('The daily cap reports failed without inserting a phantom job. Repeated review cannot bypass 100 distinct jobs, and explicit retry succeeds after the daily count expires.');
  const proxyBindings={PUBLIC_SITE_ORIGIN:publicOrigin,PRIVATE_DASHBOARD_ORIGIN:origin,PRIVATE_VOICE_SERVICE_TOKEN:'synthetic-service-token'};
  const bridgeRequest=new Request(`${publicOrigin}/api/voice/phone/recordings/${first}/finish`,{method:'POST',headers:{Origin:publicOrigin,'X-Parse-Voice':'1','Content-Type':'application/json',Cookie:connection.cookie},body:JSON.stringify({chunks:1})});
  const bridged=await value(await forwardPhone(bridgeRequest.clone(),proxyBindings,async(url,options)=>serveAuthorizedVoice(new Request(url,options),null,bindings)));assert.equal(bridged.relay,undefined);assert.equal(bridged.recording.transcript,null);assert.equal(bridged.recording.audioUrl,null);
  const masked=await value(await forwardPhone(bridgeRequest.clone(),proxyBindings,async()=>Response.json({recording:{id:first,clientType:'phone'},relay:{transcript:'private',spokenText:'private readback',proposalId:'private'}})));assert.equal(masked.relay,undefined);
  checks.push('The real public bridge masks phone care results, including an upstream response with unexpected private fields.');
  console.log(JSON.stringify({passed:true,checks,modelCalls,baseline,baselineRef},null,2));
}finally{globalThis.fetch=originalFetch;await mf.dispose();}
