import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const root=new URL('../',import.meta.url),bundle=await build({entryPoints:[fileURLToPath(new URL('app/care/care-backend.ts',root))],bundle:true,write:false,format:'esm',target:'es2022'});
const {serveCare}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const tools=JSON.parse(await readFile(new URL('app/care/tool-definitions.json',root),'utf8'));
const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('care test')}}",compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET'],host:'127.0.0.1',port:0});
const checks=[];
try {
  const DB=await mf.getD1Database('DB'),BUCKET=await mf.getR2Bucket('BUCKET'),origin='https://care-test.example';
  for(const name of (await readdir(new URL('drizzle/',root))).filter(name=>name.endsWith('.sql')).sort())for(const sql of (await readFile(new URL(`drizzle/${name}`,root),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await DB.prepare(sql).run();
  const owner={userId:'owner',email:'owner@example.test',displayName:'Demo owner'},teammate={userId:'teammate',email:'teammate@example.test',displayName:'Demo teammate'},outsider={userId:'outside',email:'outside@example.test'};
  const bindings={DB,BUCKET,PUBLIC_SITE_ORIGIN:origin,DASHBOARD_ALLOWED_EMAILS:'owner@example.test,teammate@example.test,calvin@example.test',OPENAI_API_KEY:'synthetic-test-secret'};
  let calls=0,nextCall=null;
  const fakeFetch=async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer synthetic-test-secret');
    const sent=JSON.parse(options.body);assert.equal(sent.store,false);assert.equal(sent.tool_choice,'required');assert.equal(sent.parallel_tool_calls,false);assert.equal(sent.tools.length,11);calls++;
    assert(nextCall);return Response.json({status:'completed',output:[{type:'function_call',name:nextCall.name,arguments:JSON.stringify(nextCall.args),status:'completed'}]});
  };
  async function req(path,{user=owner,data,method,requestOrigin=origin,headers={}}={}){
    const h=new Headers(headers);let body;
    if(data!==undefined){body=JSON.stringify(data);h.set('Content-Type','application/json');}
    const verb=method??(body?'POST':'GET');if(!['GET','HEAD'].includes(verb)){h.set('Origin',requestOrigin);h.set('X-CSRF-Token','parse-care');}
    return serveCare(new Request(`${origin}/v1/${path}`,{method:verb,headers:h,body}),user,bindings,fakeFetch);
  }
  async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  assert.equal((await req('auth/session',{user:null})).status,401);assert.equal((await req('auth/session',{user:outsider})).status,403);
  const session=await json(await req('auth/session')),patient=session.patients[0].id;
  const peer=await json(await req('auth/session',{user:teammate}));assert.notEqual(peer.patients[0].id,patient);
  const prefix=`app/patients/${patient}`;
  async function dashboard(){return json(await req(`${prefix}/dashboard`));}
  assert.equal((await req(`${prefix}/dashboard`,{user:teammate})).status,404);
  assert.equal((await req(`${prefix}/proposals`,{data:{kind:'health_note',payload:{wording:'Fictional test'}},requestOrigin:'https://outside.example'})).status,403);
  checks.push('Native dashboard allowlist, account isolation and cross-site writes are enforced by the real care API.');
  const before=await dashboard();assert(before.notes.length&&before.measurements.length&&before.medication_plans.length&&before.preventive_tasks.length);
  async function propose(kind,payload){return json(await req(`${prefix}/proposals`,{data:{kind,payload}}),201);}
  async function confirm(proposal){return json(await req(`app/proposals/${proposal.id}/confirm`,{data:{confirmed:true}}));}
  const note=await propose('health_note',{wording:'Fictional walk recorded through the migrated dashboard.',timezone:'Asia/Singapore'});
  assert.equal((await dashboard()).notes.length,before.notes.length);assert.equal((await req(`app/proposals/${note.id}/confirm`,{data:{confirmed:false}})).status,400);
  const saved=await confirm(note);assert.equal(saved.status,'committed');await confirm(note);assert.equal((await dashboard()).notes.filter(row=>row.id===saved.record_id).length,1);
  const revised=await propose('health_note',{wording:'Initial fictional draft.'});
  const replacement=await json(await req(`app/proposals/${revised.id}/revise`,{data:{payload:{wording:'Corrected fictional draft.'}}}),201);assert.equal((await req(`app/proposals/${revised.id}/confirm`,{data:{confirmed:true}})).status,409);await confirm(replacement);
  checks.push('Manual entries persist after a fresh read, require separate confirmation, preserve revised proposals and prevent duplicate saves.');
  const reading=await propose('measurement',{measurement_type:'blood_pressure',systolic:120,diastolic:80,unit:'mmHg',occurrence_text:'this morning',timezone:'Asia/Singapore',source_description:'fictional home monitor',reporting_actor:'patient'});await confirm(reading);
  assert.equal((await req(`${prefix}/proposals`,{data:{kind:'measurement',payload:{measurement_type:'blood_pressure',systolic:120,diastolic:80,unit:'mmHg',timezone:'Asia/Singapore',source_description:'fictional monitor',reporting_actor:'patient'}}})).status,422);
  const data=await dashboard(),dose=data.doses.find(row=>row.report_state==='unconfirmed'),task=data.preventive_tasks[0];
  const report=await propose('medication_report',{dose_instance_id:dose.id,report_state:'reported_taken',taken_time_text:'after breakfast'});await confirm(report);assert.equal((await dashboard()).doses.find(row=>row.id===dose.id).report_state,'reported_taken');
  const transition=await propose('preventive_task',{task_id:task.id,state:'completed',completion_date:new Date().toISOString().slice(0,10)});await confirm(transition);assert.equal((await dashboard()).preventive_tasks.find(row=>row.id===task.id).state,'completed');
  assert.equal((await req(`${prefix}/proposals`,{data:{kind:'preventive_task',payload:{task_type:'Fictional task',description:'Invalid date check',source:'Fictional plan',state:'planned',due_date:'2026-99-01',timezone:'Asia/Singapore'}}})).status,422);
  const support=await propose('support_request',{request_text:'Fictional transport request.',recipient_user_id:owner.email,urgency:'routine'});const supportSaved=await confirm(support);
  await json(await req(`app/support-requests/${supportSaved.record_id}/acknowledge`,{method:'POST'}));await json(await req(`app/support-requests/${supportSaved.record_id}/resolve`,{data:{outcome:'Fictional arrangement confirmed by the demo owner.'}}));
  const followup=await propose('followup',{related_type:'support_request',related_id:supportSaved.record_id,check_at:new Date(Date.now()+86400000).toISOString(),permission_scope:'private',resolution_state:'open'});const followSaved=await confirm(followup);
  const resolution=await propose('followup',{followup_id:followSaved.record_id,reported_outcome:'Fictional follow-up checked.',resolution_state:'resolved'});await confirm(resolution);
  checks.push('Reported medication status, external readings, care-plan transitions, support acknowledgement/outcomes and follow-ups use confirmed records.');
  const query=await json(await req(`${prefix}/queries`,{data:{kind:'latest_reading'}}));assert(query.items[0].source_id);await json(await req(`${prefix}/query-sources/measurement/${query.items[0].source_id}`));
  const vocabulary=await json(await req(`${prefix}/vocabulary`));await json(await req(`${prefix}/vocabulary`,{method:'PUT',data:{expected_version:vocabulary.version,terms:[{canonical:'Fictional name',aliases:[],category:'person'}]}}));assert.equal((await req(`${prefix}/vocabulary`,{method:'PUT',data:{expected_version:vocabulary.version,terms:[]}})).status,409);
  const grant=await json(await req(`${prefix}/grants`,{data:{user_id:teammate.email,scopes:['read:notes','read:measurements','ack:support']}}),201);
  const peerSession=await json(await req('auth/session',{user:teammate}));assert(peerSession.patients.some(row=>row.id===patient));
  let sharedView=await json(await req(`${prefix}/dashboard`,{user:teammate}));assert.equal(sharedView.notes.length,0);assert.equal(sharedView.summaries.length,0);assert.equal(sharedView.proposals.length,0);assert.equal(sharedView.devices.length,0);
  assert.equal((await req(`${prefix}/vocabulary`,{user:teammate})).status,403);
  await json(await req(`app/notes/${saved.record_id}/sharing`,{method:'PUT',data:{user_ids:[teammate.email]}}));sharedView=await json(await req(`${prefix}/dashboard`,{user:teammate}));assert.equal(sharedView.notes.length,1);
  assert.equal((await req(`${prefix}/proposals`,{user:teammate,data:{kind:'health_note',payload:{wording:'Forbidden write'}}})).status,403);
  checks.push('Ask Parse returns source-linked records; reviewed names use version checks; care sharing exposes only permitted records and never gives administrative or phone access.');
  const summary=await json(await req(`${prefix}/summaries`,{data:{start_date:'2020-01-01',end_date:'2030-01-01',purpose:'doctor_visit',questions:['A fictional question?']}}),201);
  const unreported=(await dashboard()).doses.filter(row=>!row.report_time).map(row=>row.id);assert(!summary.sources.some(source=>unreported.includes(source.id)));
  assert.equal((await req(`app/summaries/${summary.id}/share`,{data:{expires_in_seconds:3600}})).status,409);
  const reviewedSummary=await json(await req(`app/summaries/${summary.id}`,{method:'PUT',data:{sections:summary.sections,questions:['A fictional question?'],omitted_source_ids:[],reviewed:true}}));assert.equal(reviewedSummary.status,'reviewed');await json(await req(`app/summaries/${summary.id}/print`));
  const link=await json(await req(`app/summaries/${summary.id}/share`,{data:{expires_in_seconds:3600}})),linkPath=link.url.slice(1);
  await json(await req(linkPath,{user:teammate}));assert.equal((await req(linkPath,{user:null})).status,401);
  await json(await req(`app/notes/${saved.record_id}/sharing`,{method:'PUT',data:{user_ids:[]}}));assert.equal((await req(linkPath,{user:teammate})).status,410);assert.equal((await req(`app/summaries/${summary.id}/print`)).status,410);
  await json(await req(`app/grants/${grant.id}`,{method:'DELETE'}));assert.equal((await req(`${prefix}/dashboard`,{user:teammate})).status,404);
  checks.push('Summary review precedes print/sharing, links stay inside the private audience, and source/sharing changes or revoked grants invalidate access immediately.');

  async function record(transcript,room=crypto.randomUUID()){const recording=crypto.randomUUID(),now=Date.now();await DB.prepare("INSERT OR IGNORE INTO voice_rooms (id,owner_id,invitation_hash,state,created_at,expires_at,updated_at) VALUES (?,?,'test','paired',?,?,?)").bind(room,owner.userId,now,now+86400000,now).run();await DB.prepare("INSERT INTO voice_recordings (id,room_id,owner_id,state,next_sequence,frames,created_at,updated_at,transcript) VALUES (?,?,?,'ready',1,16000,?,?,?)").bind(recording,room,owner.userId,now,now,transcript).run();return recording;}
  function strictPayload(name,payload){let schema=tools.find(tool=>tool.name===name).parameters.properties.payload;if(schema.anyOf)schema=schema.anyOf.find(option=>name==='report_medication'?option.properties.report_state.enum.includes(payload.report_state):option.properties.task_id.type===(payload.task_id?'string':'null'));return Object.fromEntries(Object.keys(schema.properties).map(key=>[key,payload[key]??null]));}
  async function interpret(name,payloadOrArgs,transcript='Fictional voice test',room){
    nextCall={name,args:name==='respond_to_user'?payloadOrArgs:name==='confirm_current_update'?{}:name.startsWith('get_')?payloadOrArgs:{operation:'propose',payload:strictPayload(name,payloadOrArgs)}};
    const recording=await record(transcript,room),result=await json(await req(`${prefix}/voice-interpretation`,{data:{recording_id:recording}}));return {recording,result};
  }
  const aiNote=await interpret('propose_health_note',{wording:'Fictional note from an approved phone.',share_with_user_ids:[]});assert(aiNote.result.proposal);const count=calls;
  await json(await req(`${prefix}/voice-interpretation`,{data:{recording_id:aiNote.recording}}));assert.equal(calls,count);
  assert.equal((await dashboard()).notes.some(row=>row.wording==='Fictional note from an approved phone.'),false);await confirm(aiNote.result.proposal);assert((await dashboard()).notes.some(row=>row.wording==='Fictional note from an approved phone.'));
  const aiReading=await interpret('record_measurement',{measurement_type:'blood_pressure',systolic:118,diastolic:76,unit:'mmHg',occurrence_text:'this morning',timezone:'Asia/Singapore',source_description:'fictional home monitor',reporting_actor:'patient'},'My blood pressure was 118 over 76 this morning from my fictional home monitor.');
  const revisedReading=await json(await req(`app/proposals/${aiReading.result.proposal.id}/revise`,{data:{payload:{...aiReading.result.proposal.payload,systolic:122}}}),201);
  const cachedReading=await json(await req(`${prefix}/voice-interpretation`,{data:{recording_id:aiReading.recording}}));assert.equal(cachedReading.proposal.id,revisedReading.id);assert.equal(cachedReading.proposal.payload.systolic,122);await confirm(revisedReading);
  const newTask=await interpret('update_preventive_task',{task_type:'Fictional care task',description:'Fictional task from a stated care plan.',source:'Fictional entered plan',due_date:new Date().toISOString().slice(0,10),timezone:'Asia/Singapore',state:'planned'});await confirm(newTask.result.proposal);
  const aiSupport=await interpret('request_support',{request_text:'Fictional help request from the phone.',recipient_user_id:owner.email,urgency:'routine'});const aiSupportSaved=await confirm(aiSupport.result.proposal);
  const aiFollow=await interpret('update_followup',{related_type:'support_request',related_id:aiSupportSaved.record_id,check_at:new Date(Date.now()+86400000).toISOString(),permission_scope:'private',resolution_state:'open'});await confirm(aiFollow.result.proposal);
  // Create a newly checked fictional plan to give the medication tool an active, unreported dose.
  await json(await req(`${prefix}/medication-plans`,{data:{checked:true,timezone:'Asia/Singapore',source:'Fictional checked demo label',medicines:[{id:'fictional-med',name:'Fictional medicine',instructions:'Fictional label instructions only',reviewed_reference:'Fictional label instructions only',reference_source:'Fictional label'}],schedule:[{medicine_id:'fictional-med',local_time:'09:00'}]}}),201);
  const nextDose=(await dashboard()).doses.find(row=>row.medicine_id==='fictional-med'&&row.report_state==='unconfirmed');const aiMed=await interpret('report_medication',{dose_instance_id:nextDose.id,report_state:'reported_not_yet'});await confirm(aiMed.result.proposal);
  const explain=await interpret('get_medication_explanation',{medicine_id:'fictional-med'});assert.match(explain.result.spoken_text,/Fictional label instructions/);
  const status=await interpret('get_support_status',{record_id:aiSupportSaved.record_id});assert.match(status.result.spoken_text,/No human acknowledgement/);
  const followStatus=await interpret('get_followup_status',{record_id:(await dashboard()).followups[0].id});assert.match(followStatus.result.spoken_text,/No human-reported outcome/);
  const chat=await interpret('respond_to_user',{intent:'clarify',spoken_text:'Which fictional medicine are you referring to?'});assert.equal(chat.result.proposal,undefined);
  const confirmationRoom=crypto.randomUUID();
  const pending=(await interpret('propose_health_note',{wording:'Fictional explicit confirmation check.'},'Please record this fictional observation.',confirmationRoom)).result.proposal;
  const confirmed=await interpret('confirm_current_update',{},'Yes, confirm that.',confirmationRoom);assert.equal(confirmed.result.proposal.id,pending.id);assert.equal((await dashboard()).proposals.find(row=>row.id===pending.id).status,'pending');await confirm(pending);
  assert.equal((await req(`${prefix}/voice-interpretation`,{user:teammate,data:{recording_id:aiNote.recording}})).status,404);
  checks.push('All eleven actual server function handlers accept strict calls, grounded reads never invent acknowledgement, duplicate interpretation is cached, and no model call commits a record.');
  console.log(JSON.stringify({passed:true,checks,simulatedProviderCalls:calls,realApiRequests:0,microphoneRecorded:false},null,2));
}finally{await mf.dispose();}
