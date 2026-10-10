import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const root=new URL('../',import.meta.url);
async function module(path){const result=await build({entryPoints:[fileURLToPath(new URL(path,root))],bundle:true,write:false,format:'esm',target:'es2022'});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);}
const {serveAuthorizedVoice}=await module('app/voice-http.ts'),{serveCare}=await module('app/care/care-backend.ts'),{wave}=await module('app/voice-backend.ts');
const {forwardPhone}=await module('../parse-phone-companion/app/phone-proxy.ts');
const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('isolated Wi-Fi test')}}",compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET'],host:'127.0.0.1',port:0});
const originalFetch=globalThis.fetch,checks=[];
try{
  const DB=await mf.getD1Database('DB'),BUCKET=await mf.getR2Bucket('BUCKET');
  for(const name of (await readdir(new URL('drizzle/',root))).filter(name=>name.endsWith('.sql')).sort())for(const sql of (await readFile(new URL(`drizzle/${name}`,root),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await DB.prepare(sql).run();
  const privateOrigin='https://private-wifi.example',publicOrigin='https://public-wifi.example',owner={userId:'fictional-wifi-owner',email:'wifi-owner@example.test'};
  const peer={userId:'fictional-wifi-peer',email:'wifi-peer@example.test'};
  const backend={DB,BUCKET,PUBLIC_SITE_ORIGIN:privateOrigin,DASHBOARD_ALLOWED_EMAILS:`${owner.email},${peer.email}`,OPENAI_API_KEY:'synthetic-only'};
  const proxy={PRIVATE_DASHBOARD_ORIGIN:privateOrigin,PRIVATE_VOICE_SERVICE_TOKEN:'synthetic-service-only',PUBLIC_SITE_ORIGIN:publicOrigin};
  const calls={transcription:0,interpretation:0,tts:0,failTts:false};
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.redirect,'manual');
    if(url==='https://api.openai.com/v1/audio/transcriptions'){calls.transcription++;return Response.json({text:'Please make a private note that I enjoyed a short fictional garden walk this morning.'});}
    if(url==='https://api.openai.com/v1/responses'){
      calls.interpretation++;const sent=JSON.parse(options.body);assert.equal(sent.store,false);assert.equal(sent.tool_choice,'required');
      return Response.json({status:'completed',output:[{type:'function_call',name:'propose_health_note',status:'completed',arguments:JSON.stringify({operation:'propose',payload:{wording:'I enjoyed a short fictional garden walk this morning.',symptom:null,occurrence_text:'this morning',occurred_at:null,timezone:'Asia/Singapore',share_with_user_ids:[]}})}]});
    }
    if(url==='https://api.openai.com/v1/audio/speech'){
      calls.tts++;const sent=JSON.parse(options.body);assert.equal(sent.model,'gpt-4o-mini-tts');assert.equal(sent.response_format,'pcm');assert(sent.input.length<=600);
      if(calls.failTts)return Response.json({error:'synthetic TTS outage'},{status:503});
      return new Response(new Uint8Array(32000),{headers:{'Content-Type':'audio/pcm'}});
    }
    throw new Error(`Unexpected provider destination ${url}`);
  };
  async function ownerRequest(path,{data,method='GET',user=owner}={}){
    const headers=new Headers();let body;if(data!==undefined){body=JSON.stringify(data);headers.set('Content-Type','application/json');}
    if(method!=='GET'){headers.set('Origin',privateOrigin);headers.set('X-Parse-Voice','1');}
    return serveAuthorizedVoice(new Request(`${privateOrigin}/api/voice/${path}`,{method,headers,body}),user,backend);
  }
  let forwarded=0;
  async function deviceRequest(path,{data,bytes,credential='d'.repeat(64),method,headers:extra={}}={}){
    const headers=new Headers(extra);headers.set('Authorization',`Bearer ${credential}`);let body;
    if(data!==undefined){body=JSON.stringify(data);headers.set('Content-Type','application/json');}
    if(bytes){body=bytes;headers.set('Content-Type','audio/wav');}
    const verb=method??(body?'POST':'GET');
    return forwardPhone(new Request(`${publicOrigin}/api/voice/device/${path}`,{method:verb,headers,body}),proxy,async(url,init)=>{
      forwarded++;assert.equal(new URL(url).origin,privateOrigin);assert.equal(new URL(url).pathname,`/api/voice/device/${path}`);
      assert.equal(init.redirect,'manual');assert.equal(init.headers.get('OAI-Sites-Authorization'),'Bearer synthetic-service-only');
      assert.equal(init.headers.get('Authorization'),`Bearer ${credential}`);assert.equal(init.headers.get('Origin'),null);
      assert.equal(init.headers.get('oai-authenticated-user-id'),null);assert.equal(init.headers.get('oai-authenticated-user-email'),null);
      return serveAuthorizedVoice(new Request(url,init),null,backend);
    });
  }
  async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}

  await json(await serveCare(new Request(`${privateOrigin}/v1/auth/session`),owner,backend));
  const invite=await json(await ownerRequest('rooms',{method:'POST',data:{clientType:'esp32_wifi'}}),201);
  const roomId=invite.room.id,pairingToken=new URL(invite.phonePath,privateOrigin).hash.slice(6),deviceSecret='d'.repeat(64),otherSecret='e'.repeat(64);
  assert.match(pairingToken,/^[a-f0-9]{64}$/);assert.equal(invite.room.clientType,'esp32_wifi');assert.equal(invite.room.state,'waiting');
  const storedBefore=await DB.prepare('SELECT invitation_hash,device_hash FROM voice_rooms WHERE id=?').bind(roomId).first();assert.notEqual(storedBefore.invitation_hash,pairingToken);assert.equal(storedBefore.device_hash,null);
  const claimed=await json(await deviceRequest(`rooms/${roomId}/claim`,{credential:deviceSecret,data:{token:pairingToken}}),201);
  assert.equal(claimed.room.state,'pending');assert.equal(claimed.room.clientType,'esp32_wifi');assert.match(claimed.room.code,/^\d{6}$/);assert.equal(claimed.device_hash,undefined);
  const pending=await json(await deviceRequest(`rooms/${roomId}`,{credential:deviceSecret}));assert.equal(pending.room.code,claimed.room.code);assert.equal(pending.room.device_hash,undefined);
  const duplicate=await json(await deviceRequest(`rooms/${roomId}/claim`,{credential:deviceSecret,data:{token:pairingToken}}));assert.equal(duplicate.room.code,claimed.room.code);assert.equal(duplicate.room.state,'pending');
  assert.equal((await deviceRequest(`rooms/${roomId}/claim`,{credential:otherSecret,data:{token:pairingToken}})).status,409);
  assert.equal((await deviceRequest(`rooms/${roomId}/claim`,{credential:deviceSecret,data:{token:'f'.repeat(64)}})).status,409);
  assert.equal((await deviceRequest(`rooms/${roomId}`,{credential:otherSecret})).status,403);
  assert.equal((await deviceRequest(`rooms/${roomId}`,{credential:'bad'})).status,404);
  const beforeApproval=await DB.prepare('SELECT device_hash FROM voice_rooms WHERE id=?').bind(roomId).first();assert.equal(beforeApproval.device_hash,await crypto.subtle.digest('SHA-256',Buffer.from(deviceSecret)).then(bytes=>Buffer.from(bytes).toString('hex')));
  const approved=await json(await ownerRequest(`rooms/${roomId}/approve`,{method:'POST',data:{code:claimed.room.code}}));
  assert.equal(approved.room.state,'paired');assert.equal(approved.room.code,null);assert(approved.room.expiresAt>=Date.now()+30*86400000-1000);
  const paired=await json(await deviceRequest(`rooms/${roomId}`));assert.equal(paired.room.state,'paired');assert.equal(paired.room.code,null);
  const retryClaim=await json(await deviceRequest(`rooms/${roomId}/claim`,{credential:deviceSecret,data:{token:pairingToken}}));assert.equal(retryClaim.room.state,'paired');assert.equal(retryClaim.room.code,null);
  assert.equal((await deviceRequest(`rooms/${roomId}/claim`,{credential:otherSecret,data:{token:pairingToken}})).status,409);
  assert.equal((await deviceRequest(`rooms/${roomId}/approve`,{data:{code:claimed.room.code}})).status,404);
  checks.push('Wi-Fi claim binds the invitation to one stable hashed device secret, is safely retryable after a lost response, expires in 30 days after approval, and clears the displayed code once paired.');

  const secondInvite=await json(await ownerRequest('rooms',{method:'POST',data:{clientType:'esp32_wifi'}}),201),otherRoom=secondInvite.room.id;
  const secondToken=new URL(secondInvite.phonePath,privateOrigin).hash.slice(6);
  assert.equal((await deviceRequest(`rooms/${otherRoom}/claim`,{credential:deviceSecret,data:{token:secondToken}})).status,409);
  assert.equal((await deviceRequest(`rooms/${otherRoom}/claim`,{credential:otherSecret,data:{token:secondToken}})).status,201);
  assert.equal((await deviceRequest('recordings',{data:{roomId:otherRoom,recordingId:crypto.randomUUID()}})).status,403);
  assert.equal((await deviceRequest(`rooms/${otherRoom}/relay`,{data:{action:'poll'}})).status,403);
  assert.equal((await deviceRequest(`rooms/${roomId}/recordings`)).status,404);
  assert.equal((await deviceRequest(`rooms/${roomId}/relay`,{data:{status:{hardwareReady:true,phase:'idle'},action:'poll'}})).status,200);
  assert.equal((await deviceRequest(`rooms/${roomId}/relay`,{data:{action:'poll'}})).status,200);
  const latestRelay=await json(await ownerRequest(`rooms/${roomId}/relay`));assert.equal(latestRelay.online,true);assert.equal(latestRelay.status.hardwareReady,true);
  checks.push('Device bearer credentials are room-scoped, machine POSTs need no browser Origin, and the existing relay heartbeat/poll protocol works through the fixed bridge.');

  async function uploadAndFinish({failTts=false}={}){
    calls.failTts=failTts;const id=crypto.randomUUID();
    await json(await deviceRequest('recordings',{credential:deviceSecret,data:{roomId,recordingId:id}}),201);
    await json(await deviceRequest(`recordings/${id}/chunks/0`,{credential:deviceSecret,bytes:wave(new Uint8Array(32000))}));
    const finished=await json(await deviceRequest(`recordings/${id}/finish`,{credential:deviceSecret,data:{chunks:1}}));
    assert.equal(finished.recording.state,'ready');assert.equal(finished.recording.transcript,null);
  assert.equal(finished.relay.functionName,'propose_health_note');assert.equal(finished.relay.proposalStatus,'pending');assert.match(finished.relay.transcript,/garden walk/i);
    return {id,finished};
  }
  const first=await uploadAndFinish();assert.equal(calls.transcription,1);assert.equal(calls.interpretation,1);assert.equal(calls.tts,1);
  const audio=await json(await ownerRequest(`rooms/${roomId}/relay`));assert.equal(audio.latest.id,first.id);assert.match(audio.latest.replyAudioUrl,/recordings\/.+\/reply$/);
  const playback=await ownerRequest(`recordings/${first.id}/reply`);assert.equal(playback.status,200);assert.equal(playback.headers.get('Content-Type'),'audio/wav');
  const playbackBytes=new Uint8Array(await playback.arrayBuffer()),playbackView=new DataView(playbackBytes.buffer);assert.equal(playback.headers.get('Content-Length'),String(playbackBytes.length));assert.equal(playbackView.getUint32(24,true),24000);assert.equal(playbackView.getUint32(28,true),48000);assert.equal(playbackView.getUint32(40,true),32000);assert.deepEqual(playbackBytes,wave(new Uint8Array(32000),24000));
  assert.equal((await ownerRequest(`recordings/${first.id}/reply`,{user:peer})).status,404);
  assert.equal((await ownerRequest(`recordings/${first.id}/audio/0`,{user:peer})).status,404);
  const peerRecordings=await json(await ownerRequest('recordings',{user:peer}));assert(!peerRecordings.recordings.some(recording=>recording.id===first.id));
  assert.equal((await deviceRequest(`recordings/${first.id}/reply`)).status,404);
  const beforeRetry={...calls};
  const repeat=await json(await deviceRequest(`recordings/${first.id}/finish`,{credential:deviceSecret,data:{chunks:1}}));assert.equal(repeat.relay.proposalId,first.finished.relay.proposalId);assert.deepEqual(calls,beforeRetry);
  await Promise.all([deviceRequest(`recordings/${first.id}/finish`,{credential:deviceSecret,data:{chunks:1}}),deviceRequest(`recordings/${first.id}/finish`,{credential:deviceSecret,data:{chunks:1}})]);
  assert.deepEqual(calls,beforeRetry);
  const dashboard=await json(await serveCare(new Request(`${privateOrigin}/v1/auth/session`),owner,backend));const patient=dashboard.patients[0].id;
  const careDashboard=await json(await serveCare(new Request(`${privateOrigin}/v1/app/patients/${patient}/dashboard`),owner,backend));
  assert(careDashboard.proposals.some(proposal=>proposal.id===first.finished.relay.proposalId));assert(!careDashboard.notes.some(note=>note.provenance?.proposal_id===first.finished.relay.proposalId));
  checks.push('Wi-Fi upload/transcription/interpretation runs once; dashboard TTS is cached as private WAV playback, retries do not make another paid speech call, and updates remain pending for dashboard confirmation.');

  const failedTts=await uploadAndFinish({failTts:true});assert.equal(calls.transcription,2);assert.equal(calls.interpretation,2);assert.equal(calls.tts,2);
  const ttsState=await DB.prepare('SELECT state,error_code FROM voice_tts_jobs WHERE recording_id=?').bind(failedTts.id).first();assert.equal(ttsState.state,'failed');assert.equal(ttsState.error_code,'speech_unavailable');
  const stillThere=await json(await deviceRequest(`recordings/${failedTts.id}/finish`,{credential:deviceSecret,data:{chunks:1}}));assert.equal(stillThere.relay.proposalStatus,'pending');assert.equal(calls.tts,2);
  const ownerStillSees=await ownerRequest(`recordings/${failedTts.id}/reply`);assert.equal(ownerStillSees.status,404);
  checks.push('A TTS outage preserves the transcript and validated pending proposal, and retries do not repeat paid synthesis.');

  const code=String(claimed.room.code);await json(await ownerRequest(`rooms/${roomId}/revoke`,{method:'POST',data:{}}));
  assert.equal((await deviceRequest(`rooms/${roomId}`,{credential:deviceSecret})).status,410);
  assert.equal((await deviceRequest(`rooms/${roomId}/relay`,{credential:deviceSecret,data:{action:'poll'}})).status,410);
  assert.equal((await deviceRequest(`recordings/${first.id}/chunks/0`,{credential:deviceSecret,bytes:wave(new Uint8Array(32000))})).status,410);
  assert.equal((await deviceRequest(`rooms/${roomId}/claim`,{credential:deviceSecret,data:{token:pairingToken}})).status,410);
  assert.notEqual(code,'');checks.push('Dashboard revocation immediately blocks room reads, relay traffic, uploads, and claim retries.');

  const forwardedBefore=forwarded;
  assert.equal((await forwardPhone(new Request(`${publicOrigin}/api/voice/device/recordings/${first.id}/reply`,{headers:{Authorization:`Bearer ${deviceSecret}`}}),proxy,async()=>{forwarded++;throw new Error('not forwarded');})).status,404);
  assert.equal((await forwardPhone(new Request(`${publicOrigin}/api/voice/device/rooms/${roomId}`,{headers:{}}),proxy,async()=>{forwarded++;throw new Error('not forwarded');})).status,404);
  assert.equal(forwarded,forwardedBefore);
  checks.push('The public Site bridge exposes only the device allowlist and never forwards unauthenticated, playback, or dashboard-only paths.');
  console.log(JSON.stringify({passed:true,realApiRequests:0,microphoneRecorded:false,ttsCalls:calls.tts,checks},null,2));
}finally{globalThis.fetch=originalFetch;await mf.dispose();}
