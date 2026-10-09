// Explicit, bounded live verification using the already approved local demo key.
// This script is never part of the normal build or simulated checks.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

if(process.argv[2]!=='--use-approved-demo-key')throw new Error('Run the explicit approved-demo-key check to make three fictional API requests.');
const root=new URL('../',import.meta.url);
const key=parseEnv(await readFile(new URL('../../backend/.env',root),'utf8')).OPENAI_API_KEY;
assert(key,'The previously approved demo key is not available.');
const bundle=await build({entryPoints:[fileURLToPath(new URL('app/care/care-backend.ts',root))],bundle:true,write:false,format:'esm',target:'es2022'});
const {serveCare}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('fictional live care check')}}",compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET'],host:'127.0.0.1',port:0});
let requests=0;
const checks=[];
try{
  const DB=await mf.getD1Database('DB'),BUCKET=await mf.getR2Bucket('BUCKET'),origin='https://fictional-care-test.example';
  for(const name of (await readdir(new URL('drizzle/',root))).filter(name=>name.endsWith('.sql')).sort())for(const sql of (await readFile(new URL(`drizzle/${name}`,root),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await DB.prepare(sql).run();
  const user={userId:'fictional-live-owner',email:'fictional-owner@example.test',displayName:'Fictional owner'};
  const bindings={DB,BUCKET,OPENAI_API_KEY:key,PUBLIC_SITE_ORIGIN:origin,DASHBOARD_ALLOWED_EMAILS:user.email};
  const limitedFetch=async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.redirect,'manual');
    assert(requests<3,'The three-request verification limit was reached.');requests++;
    return fetch(url,options);
  };
  async function req(path,data){
    const response=await serveCare(new Request(`${origin}/v1/${path}`,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json','Origin':origin,'X-CSRF-Token':'parse-care'}:{},body:data?JSON.stringify(data):undefined}),user,bindings,limitedFetch);
    assert(response.ok,`Care verification returned HTTP ${response.status}: ${await response.clone().text()}`);return response.json();
  }
  const session=await req('auth/session'),patient=session.patients[0].id,prefix=`app/patients/${patient}`;
  const initial=await req(`${prefix}/dashboard`),task=initial.preventive_tasks.find(row=>row.state==='arranged');assert(task);
  const samples=[
    {name:'propose_health_note',words:'Please record that I enjoyed a short walk in the garden this morning. Keep this note private.',kind:'health_note'},
    {name:'record_measurement',words:'Please record my blood pressure as 120 over 80, measured using my fictional home blood pressure monitor this morning. I am the patient reporting this reading.',kind:'measurement'},
    {name:'update_preventive_task',words:`Please mark the existing care-plan task "${task.description}" as completed on ${new Date().toISOString().slice(0,10)}.`,kind:'preventive_task'},
  ];
  for(const sample of samples){
    const room=crypto.randomUUID(),recording=crypto.randomUUID(),now=Date.now();
    await DB.prepare("INSERT INTO voice_rooms (id,owner_id,invitation_hash,state,created_at,expires_at,updated_at) VALUES (?,?,'fictional','paired',?,?,?)").bind(room,user.userId,now,now+86400000,now).run();
    await DB.prepare("INSERT INTO voice_recordings (id,room_id,owner_id,state,next_sequence,frames,created_at,updated_at,transcript) VALUES (?,?,?,'ready',1,16000,?,?,?)").bind(recording,room,user.userId,now,now,sample.words).run();
    const result=await req(`${prefix}/voice-interpretation`,{recording_id:recording});
    assert.equal(result.function_name,sample.name);assert.equal(result.proposal?.kind,sample.kind);assert.equal(result.proposal.status,'pending');
    const before=await req(`${prefix}/dashboard`);assert.equal(before.proposals.find(row=>row.id===result.proposal.id).status,'pending');
    if(sample.kind==='health_note'){assert.match(result.proposal.payload.wording,/walk/i);assert.deepEqual(result.proposal.payload.share_with_user_ids,[]);assert(!before.notes.some(row=>row.provenance?.proposal_id===result.proposal.id));}
    if(sample.kind==='measurement'){assert.equal(result.proposal.payload.systolic,120);assert.equal(result.proposal.payload.diastolic,80);assert.equal(result.proposal.payload.occurrence_text,'this morning');assert(!result.proposal.payload.occurred_at);}
    if(sample.kind==='preventive_task'){assert.equal(result.proposal.payload.task_id,task.id);assert.equal(result.proposal.payload.state,'completed');assert.equal(before.preventive_tasks.find(row=>row.id===task.id).state,'arranged');}
    const callsBefore=requests,cached=await req(`${prefix}/voice-interpretation`,{recording_id:recording});assert.equal(cached.proposal.id,result.proposal.id);assert.equal(requests,callsBefore);
    const saved=await req(`app/proposals/${result.proposal.id}/confirm`,{confirmed:true});assert.equal(saved.status,'committed');
    checks.push({function:result.function_name,serverValidated:true,separateConfirmation:true,repeatedReviewUsesCache:true});
    console.log(JSON.stringify({function:result.function_name,passed:true}));
  }
  console.log(JSON.stringify({passed:true,realApiRequests:requests,checks,microphoneRecorded:false,storage:'isolated local fictional care space'},null,2));
}finally{await mf.dispose();}
