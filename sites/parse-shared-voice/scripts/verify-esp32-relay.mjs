import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const root=new URL('../',import.meta.url);
async function module(path){const result=await build({entryPoints:[fileURLToPath(new URL(path,root))],bundle:true,write:false,format:'esm',target:'es2022'});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);}
const {serveAuthorizedVoice}=await module('app/voice-http.ts'),{serveCare}=await module('app/care/care-backend.ts'),{wave}=await module('app/voice-backend.ts');
const {forwardPhone}=await module('../parse-phone-companion/app/phone-proxy.ts');
const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('test')}}",compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET'],host:'127.0.0.1',port:0});
const originalFetch=globalThis.fetch;
try{
 const DB=await mf.getD1Database('DB'),BUCKET=await mf.getR2Bucket('BUCKET');
 for(const name of (await readdir(new URL('drizzle/',root))).filter(name=>name.endsWith('.sql')).sort())for(const sql of (await readFile(new URL(`drizzle/${name}`,root),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await DB.prepare(sql).run();
 const origin='https://private.example',phoneOrigin='https://phone.example',owner={userId:'relay-owner',email:'owner@example.test'};
 const bindings={DB,BUCKET,PUBLIC_SITE_ORIGIN:origin,PUBLIC_PHONE_ORIGIN:phoneOrigin,DASHBOARD_ALLOWED_EMAILS:owner.email,OPENAI_API_KEY:'synthetic-only'};
 const proxy={PRIVATE_DASHBOARD_ORIGIN:origin,PRIVATE_VOICE_SERVICE_TOKEN:'synthetic-service',PUBLIC_SITE_ORIGIN:phoneOrigin};
 let transcriptions=0,interpretations=0,revokeDuringInterpretation=null;
 globalThis.fetch=async(url,options)=>{
  if(url==='https://api.openai.com/v1/audio/transcriptions'){transcriptions++;return Response.json({text:'Please note that I enjoyed a walk today.'});}
  assert.equal(url,'https://api.openai.com/v1/responses');interpretations++;
  if(revokeDuringInterpretation)await DB.prepare("UPDATE voice_rooms SET state='revoked' WHERE id=?").bind(revokeDuringInterpretation).run();
  return Response.json({status:'completed',output:[{type:'function_call',name:'propose_health_note',status:'completed',arguments:JSON.stringify({operation:'propose',payload:{wording:'I enjoyed a walk today.',symptom:null,timezone:null,occurrence_text:'today',occurred_at:null,share_with_user_ids:[]}})}]});
 };
 async function care(path){const response=await serveCare(new Request(origin+'/v1/'+path),owner,bindings);assert.equal(response.status,200);return response.json();}
 const session=await care('auth/session'),patient=session.patients[0].id;
 async function req(path,{data,cookie,bytes,publicApi=false,user=owner}={}){
  const headers=new Headers(),body=bytes??(data===undefined?undefined:JSON.stringify(data));
  if(body){headers.set('Content-Type',bytes?'audio/wav':'application/json');headers.set('Origin',publicApi?phoneOrigin:origin);headers.set('X-Parse-Voice','1');}
  if(cookie)headers.set('Cookie',cookie);
  const request=new Request((publicApi?phoneOrigin:origin)+'/api/voice/'+(publicApi?'phone/':'')+path,{method:body?'POST':'GET',headers,body});
  return publicApi?forwardPhone(request,proxy,async(url,options)=>serveAuthorizedVoice(new Request(url,options),null,bindings)):serveAuthorizedVoice(request,user,bindings);
 }
 async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
 const invite=await json(await req('rooms',{data:{clientType:'esp32'}}),201),room=invite.room.id,token=new URL(invite.phonePath,origin).hash.slice(6);
 const claimed=await req(`rooms/${room}/claim`,{publicApi:true,data:{token}}),cookie=claimed.headers.get('Set-Cookie').split(';')[0],pending=await json(claimed,201);
 assert.equal(pending.room.clientType,'esp32');
 assert.equal((await req('recordings',{publicApi:true,data:{roomId:room},cookie})).status,403);
 await json(await req(`rooms/${room}/approve`,{data:{code:pending.room.code}}));
 // Cloud capture requests are deliberate, scoped, expiring, and claimed once.
 const commandId=crypto.randomUUID(),claimId=crypto.randomUUID();
 assert.equal((await req(`rooms/${room}/capture`,{data:{commandId}})).status,409);
 assert.equal((await req(`rooms/${room}/relay`,{publicApi:true,data:{status:{hardwareReady:true}},cookie:'parse_voice_phone='+'f'.repeat(64)})).status,403);
 await json(await req(`rooms/${room}/relay`,{publicApi:true,data:{status:{hardwareReady:true,busy:false,phase:'idle'}},cookie}));
 const queued=await json(await req(`rooms/${room}/capture`,{data:{commandId}}),202);assert.equal(queued.command.state,'queued');
 const duplicate=await json(await req(`rooms/${room}/capture`,{data:{commandId}}));assert.equal(duplicate.reused,true);
 assert.equal((await req(`rooms/${room}/capture`,{data:{commandId:crypto.randomUUID()}})).status,409);
 assert.equal((await req(`rooms/${room}/relay`,{user:{userId:'other',email:owner.email}})).status,404);
 const poll=await json(await req(`rooms/${room}/relay`,{publicApi:true,data:{},cookie}));assert.equal(poll.command.id,commandId);assert.equal(poll.latest,undefined);
 const claimBody={action:'claim',commandId,claimId};
 assert.equal((await json(await req(`rooms/${room}/relay`,{publicApi:true,data:claimBody,cookie}))).claimed,true);
 assert.equal((await json(await req(`rooms/${room}/relay`,{publicApi:true,data:claimBody,cookie}))).claimed,true);
 assert.equal((await req(`rooms/${room}/relay`,{publicApi:true,data:{...claimBody,claimId:crypto.randomUUID()},cookie})).status,409);
 await json(await req(`rooms/${room}/relay`,{publicApi:true,data:{action:'complete',commandId,claimId},cookie}));
 assert.equal((await req(`rooms/${room}/relay`,{publicApi:true,data:claimBody,cookie})).status,409);
 const expiredId=crypto.randomUUID();await json(await req(`rooms/${room}/capture`,{data:{commandId:expiredId}}),202);
 await DB.prepare('UPDATE voice_relay_commands SET expires_at=? WHERE id=?').bind(Date.now()-1,expiredId).run();
 assert.equal((await req(`rooms/${room}/relay`,{publicApi:true,data:{action:'claim',commandId:expiredId,claimId:crypto.randomUUID()},cookie})).status,409);
 await DB.prepare('UPDATE voice_relay_status SET last_seen=? WHERE room_id=?').bind(Date.now()-20000,room).run();
 assert.equal((await req(`rooms/${room}/capture`,{data:{commandId:crypto.randomUUID()}})).status,409);
 const rid=crypto.randomUUID(),data={roomId:room,recordingId:rid};
 await json(await req('recordings',{publicApi:true,data,cookie}),201);
 const reused=await json(await req('recordings',{publicApi:true,data,cookie}),201);assert.equal(reused.recording.id,rid);assert.equal(reused.reused,true);
 const chunk=wave(new Uint8Array(32000));await json(await req(`recordings/${rid}/chunks/0`,{publicApi:true,bytes:chunk,cookie}));
 const finished=await json(await req(`recordings/${rid}/finish`,{publicApi:true,data:{chunks:1},cookie}));
 assert.equal(finished.relay.functionName,'propose_health_note');assert.equal(finished.relay.proposalStatus,'pending');assert.match(finished.relay.transcript,/walk/);
 await json(await req(`recordings/${rid}/reply`,{publicApi:true,bytes:chunk,cookie}));
 assert.equal((await req(`recordings/${rid}/reply`)).status,200);
 assert.equal((await req(`recordings/${rid}/reply`,{publicApi:true,cookie})).status,404);
 assert.equal((await req(`recordings/${rid}/reply`,{user:{userId:'other',email:owner.email}})).status,404);
 await json(await req(`recordings/${rid}/reply`,{publicApi:true,bytes:chunk,cookie}));
 const studio=await json(await req(`rooms/${room}/relay`));assert.equal(studio.latest.id,rid);assert.match(studio.latest.replyAudioUrl,/reply$/);assert.equal(studio.latest.reply.hasProposal,true);
 const dashboard=await care(`app/patients/${patient}/dashboard`);assert(dashboard.proposals.some(p=>p.id===finished.relay.proposalId));assert(!dashboard.notes.some(n=>n.provenance?.proposal_id===finished.relay.proposalId));
 const retried=await json(await req(`recordings/${rid}/finish`,{publicApi:true,data:{chunks:1},cookie}));assert.equal(retried.relay.proposalId,finished.relay.proposalId);assert.equal(transcriptions,1);assert.equal(interpretations,1);
 assert.equal((await req(`recordings/${rid}`,{publicApi:true,cookie})).status,404);assert.equal((await req(`recordings/${rid}`,{user:{userId:'other',email:owner.email}})).status,404);
 const second=crypto.randomUUID();await json(await req('recordings',{publicApi:true,data:{roomId:room,recordingId:second},cookie}),201);await json(await req(`recordings/${second}/chunks/0`,{publicApi:true,bytes:chunk,cookie}));
 revokeDuringInterpretation=room;assert.equal((await req(`recordings/${second}/finish`,{publicApi:true,data:{chunks:1},cookie})).status,410);
 assert.equal((await req(`rooms/${room}/relay`,{publicApi:true,data:{},cookie})).status,410);
 const after=await care(`app/patients/${patient}/dashboard`);assert.equal(after.proposals.length,dashboard.proposals.length);
 console.log(JSON.stringify({passed:true,checks:['Cloud capture requires fresh relay heartbeat and approved pairing','Commands are idempotent, expire, and accept only one claim','Spoken reply and studio results are owner-scoped','Approved ESP32 pairing required','Real bridge forwards only scoped reply fields','Upload and finish retries reuse the same recording and proposal','Transcription and care function run once','Proposal appears on dashboard without a committed care record','Other identities and phone read routes are rejected','Revocation during interpretation prevents proposal persistence']},null,2));
}finally{globalThis.fetch=originalFetch;await mf.dispose();}
