import definitions from "./tool-definitions.json";
import instructions from "./interpretation-instructions.json";
import type { VoiceBindings } from "../voice-backend";
import type { CareContext, CareIdentity } from "./care-backend";
import { acquireVoiceJob, finishVoiceJob, failVoiceJob, VOICE_JOB_LEASE_MS } from "./care-voice-jobs";
import { CareError, object, prepareProposal, requireCare, rows, text, validateSchema, type CareProposal, type Schema } from "./care-state";
import type { Row } from "./api";
import type { RecordingInterpretation } from "../voice-client";

export type InterpretationResult={proposal?:CareProposal;spoken_text:string;function_name:string;intent?:string};
type Result=InterpretationResult;
type Recording={id:string;room_id:string;owner_id:string;state:string;transcript:string|null;created_at:number};
const kinds:Record<string,string>={propose_health_note:'health_note',report_medication:'medication_report',record_measurement:'measurement',update_preventive_task:'preventive_task',request_support:'support_request',update_followup:'followup'};
const capabilities={
  proposals:['health notes','reported blood pressure','existing dose reports','preventive care tasks','support requests','follow-ups'],
  reads:['reviewed medicine instructions','stored support status','stored follow-up status'],
  unsupported:['create or edit medication reminders','create or activate medication plans','dispatch calls or messages'],
  confirmation:'Care updates require review and Confirm and save in the dashboard.',
};

// A cached recording may follow a manual revision of that same recording, but
// must never turn into another recording's action or revive expired speech.
export function currentRecordingResult(result:Result,proposals:CareProposal[],recordingId:string):Result{
  if(!result.proposal)return result;
  let proposal=proposals.find(item=>item.id===result.proposal!.id);
  for(let step=0;proposal?.status==='replaced'&&proposal.replaced_by_id&&step<50;step++){
    const next=proposals.find(item=>item.id===proposal!.replaced_by_id);
    if(!next||next.source_recording_id!==recordingId)break;
    proposal=next;
  }
  if(!proposal){const {proposal:unused,...rest}=result;return {...rest,spoken_text:'This proposed update is no longer available. Record your request again.'};}
  if(proposal.status==='pending'&&Date.parse(proposal.expires_at!)<=Date.now())return {...result,proposal:{...proposal,status:'expired'},spoken_text:'This proposed update has expired. Record the request again to prepare a new update.'};
  if(proposal.status==='replaced')return {...result,proposal,spoken_text:'This recording’s proposal was replaced by a later request. Review the newer recording.'};
  if(proposal.status==='committed')return {...result,proposal,spoken_text:'This update was already confirmed and saved in the dashboard.'};
  return {...result,proposal,spoken_text:proposal.readback};
}

export function recordingInterpretation(row:{id:string;state:string;transcript:string|null;error_code:string|null;job_state:string|null;result_json:string|null;job_updated_at:number|null},proposals:CareProposal[]):RecordingInterpretation|null{
  if(!row.transcript)return null;
  if(row.job_state==='processing')return {state:(row.job_updated_at??0)+VOICE_JOB_LEASE_MS>Date.now()?'processing':'failed'};
  if(row.job_state==='failed')return {state:'failed'};
  if(row.job_state!=='ready'||!row.result_json)return {state:row.job_state!=='ready'&&row.error_code==='interpretation_unavailable'?'failed':'waiting'};
  try{
    const parsed=JSON.parse(row.result_json) as Result;
    requireCare(typeof parsed.spoken_text==='string'&&typeof parsed.function_name==='string',503,'Invalid cached interpretation.');
    const current=currentRecordingResult(parsed,proposals,row.id);
    return {state:'ready',category:current.proposal?.kind.slice(0,80)??null,intent:current.intent?.slice(0,80)??null,readback:current.spoken_text.slice(0,4000),proposalId:current.proposal?.id??null,proposalStatus:current.proposal?.status??null};
  }catch{return {state:'failed'};}
}

async function conversation(db:D1Database,recording:Recording,state:CareContext['state']){
  const previous=await db.prepare(`SELECT r.id,r.transcript,r.created_at,j.result_json
    FROM voice_recordings r JOIN care_voice_jobs j ON j.recording_id=r.id AND j.owner_id=r.owner_id
    WHERE r.room_id=? AND r.owner_id=? AND r.id<>? AND r.state='ready' AND j.state='ready'
      AND r.created_at>=? AND r.created_at<=? AND j.result_json IS NOT NULL
    ORDER BY r.created_at DESC,j.updated_at DESC LIMIT 8`)
    .bind(recording.room_id,recording.owner_id,recording.id,Math.max(Date.now()-600000,recording.created_at-600000),recording.created_at)
    .all<{id:string;transcript:string;created_at:number;result_json:string}>();
  const recent_turns=previous.results.reverse().flatMap(turn=>{
    try{
      const result=currentRecordingResult(JSON.parse(turn.result_json) as Result,state.proposals,turn.id);
      return [{recording_id:turn.id,transcript:turn.transcript.slice(0,8000),application_result:{
        spoken_text:result.spoken_text.slice(0,4000),function_name:result.function_name,intent:result.intent??null,
        proposal_id:result.proposal?.id??null,proposal_status:result.proposal?.status??null,
      }}];
    }catch{return [];}
  });
  const last=recent_turns.at(-1)?.application_result;
  const current_proposal=last?.proposal_status==='pending'?state.proposals.find(item=>item.id===last.proposal_id)??null:null;
  return {recent_turns,current_proposal};
}

function explicitConfirmation(transcript:string){
  const value=transcript.toLowerCase().replace(/[\p{P}\p{S}]/gu,' ').replace(/\s+/g,' ').trim();
  return /^(yes( please| that is right| that s right| that is correct| that s correct| confirm( it| that)?| save( it| that)?)?|confirm( it| that| this update)?|save( it| that)|that s (right|correct)|that is (right|correct)|correct|好|好的|是|是的|确认|确认保存|对|对的|没错)$/.test(value);
}

function measurementClarification(payload:Row,utterances:string[]):string|null{
  const normalize=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu,' ').replace(/\s+/g,' ').trim();
  const stated=(value:unknown)=>!!text(value).trim()&&utterances.some(utterance=>` ${normalize(utterance)} `.includes(` ${normalize(text(value))} `));
  if(!payload.occurred_at&&!payload.occurrence_text)return 'When was this blood-pressure reading taken?';
  if(payload.occurrence_text&&!stated(payload.occurrence_text))return 'When was this blood-pressure reading taken? Please give the time in your own words.';
  if(!stated(payload.source_description)||/^(unknown|unspecified|not (specified|stated|provided|given)|unclear|none|n a)$/i.test(normalize(text(payload.source_description))))return 'What device or location was used to take this blood-pressure reading?';
  return null;
}

async function provider(bindings:VoiceBindings,transcript:string,context:Row,fetchImpl:typeof fetch):Promise<{name:string;arguments:Row}>{
  requireCare(bindings.OPENAI_API_KEY,503,'Voice interpretation is not configured. Your transcript is still available.');
  const response=await fetchImpl('https://api.openai.com/v1/responses',{
    method:'POST',headers:{Authorization:`Bearer ${bindings.OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:'gpt-4.1',temperature:0,instructions,input:[{role:'user',content:JSON.stringify({transcript,context})}],tools:definitions,tool_choice:'required',parallel_tool_calls:false,max_output_tokens:1800,store:false}),redirect:'manual',signal:AbortSignal.timeout(45000),
  });
  requireCare(response.ok,503,'OpenAI could not prepare this update. Your transcript remains available.');
  const reader=response.body?.getReader();requireCare(reader,503,'OpenAI returned no care function.');const parts:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;requireCare(size<=2000000,503,'The interpretation response was too large.');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const buffer=new Uint8Array(size);let at=0;for(const part of parts){buffer.set(part,at);at+=part.length;}
  let result:Row;try{result=object(JSON.parse(new TextDecoder().decode(buffer)));}catch{throw new CareError(503,'OpenAI returned an invalid care function.');}
  requireCare(result.status==='completed'&&Array.isArray(result.output),503,'OpenAI did not complete the care function.');
  requireCare(result.output.every(item=>item&&typeof item==='object'&&!Array.isArray(item)),503,'OpenAI returned an invalid care function.');
  const calls=rows(result.output).filter(item=>item.type==='function_call');requireCare(calls.length===1,503,'OpenAI must select exactly one care function.');
  const call=calls[0],definition=definitions.find(item=>item.name===call.name);requireCare(definition&&(!call.status||call.status==='completed')&&typeof call.arguments==='string'&&call.arguments.length<=16000,503,'OpenAI returned an unsupported care function.');
  let args:Row;try{args=object(validateSchema(JSON.parse(call.arguments as string),definition.parameters as unknown as Schema));}catch{throw new CareError(503,'The care function contained invalid details. Nothing was saved.');}
  return {name:definition.name,arguments:args};
}

export async function interpretRecording(db:D1Database,context:CareContext,user:CareIdentity,bindings:VoiceBindings,recordingId:string,fetchImpl:typeof fetch,beforePersist:()=>Promise<void>=async()=>{}):Promise<Result>{
  requireCare(context.isOwner&&/^[a-f0-9-]{36}$/.test(recordingId),404,'Choose a recording from your own dashboard.');
  const recording=await db.prepare('SELECT id,room_id,owner_id,state,transcript,created_at FROM voice_recordings WHERE id = ? AND owner_id = ?').bind(recordingId,user.userId).first<Recording>();
  requireCare(recording&&recording.created_at+86400000>Date.now()&&recording.state==='ready'&&recording.transcript,409,'Wait for a completed recording with a transcript.');
  const transcript=recording.transcript.trim();
  requireCare(transcript.length<=8000&&/[\p{L}\p{N}]/u.test(transcript),422,'No clear spoken request was found. Record your request again.');
  const cached=await db.prepare('SELECT state,result_json,updated_at FROM care_voice_jobs WHERE recording_id = ? AND owner_id = ?').bind(recordingId,user.userId).first<{state:string;result_json:string|null;updated_at:number}>();
  if(cached?.state==='ready'&&cached.result_json){
    await beforePersist();
    const result=currentRecordingResult(JSON.parse(cached.result_json) as Result,context.state.proposals,recordingId);
    await db.prepare("UPDATE voice_recordings SET error_code = NULL WHERE id = ? AND owner_id = ? AND error_code = 'interpretation_unavailable'").bind(recordingId,user.userId).run();
    return result;
  }
  const recent=await db.prepare('SELECT COUNT(*) AS count FROM care_voice_jobs WHERE owner_id = ? AND updated_at > ?').bind(user.userId,Date.now()-86400000).first<{count:number}>();
  requireCare((recent?.count??0)<100||!!cached,429,'The daily interpretation limit was reached.');
  const leaseAt=await acquireVoiceJob(db,user.userId,recordingId,recording.room_id);
  try{
    const state=context.state,{recent_turns,current_proposal:current}=await conversation(db,recording,state);
    await beforePersist();
    const call=await provider(bindings,transcript,{
      device:{patient_id:state.patient.id,preferred_name:state.patient.preferred_name,language:state.patient.language,calling_route:state.patient.calling_route,timezone:state.patient.timezone},server_time:new Date().toISOString(),reviewed_vocabulary:state.vocabulary,
      recent_turns,current_proposal:current,supported_capabilities:capabilities,active_medication_plan:state.medication_plans.find(plan=>plan.active===true)??null,doses:state.doses.filter(dose=>dose.plan_version===state.medication_plans.find(plan=>plan.active===true)?.version).slice(0,100),permitted_recipients:state.allowed_recipients,
      health_notes:state.notes.filter(note=>!note.deleted_at).slice(0,30),preventive_tasks:state.preventive_tasks.slice(0,30),support_requests:state.support_requests.slice(0,30),followups:state.followups.slice(0,30),
    },fetchImpl);
    let result:Result;
    if(kinds[call.name]){
      const operation=text(call.arguments.operation);requireCare(['propose','correct'].includes(operation),422,'The update operation is invalid.');
      if(operation==='correct')requireCare(current&&current.kind===kinds[call.name],409,'Open the identified pending proposal before correcting it.');
      const evidence=[transcript];
      if(recent_turns.at(-1)?.application_result.intent==='clarify'||operation==='correct')evidence.push(...recent_turns.map(turn=>turn.transcript));
      if(operation==='correct'&&current)evidence.push(text(current.payload.source_description),text(current.payload.occurrence_text));
      const question=call.name==='record_measurement'?measurementClarification(object(call.arguments.payload),evidence):null;
      if(question)result={spoken_text:question,function_name:'respond_to_user',intent:'clarify'};
      else{
        const proposal=prepareProposal(state,kinds[call.name],object(call.arguments.payload),user.email.trim().toLowerCase(),recordingId);
        if(operation==='correct'&&current){current.status='replaced';current.replaced_by_id=proposal.id;}result={proposal,spoken_text:proposal.readback,function_name:call.name,intent:operation==='correct'?'correct':'proposal'};
      }
    }else if(call.name==='confirm_current_update'){
      result=current&&explicitConfirmation(transcript)
        ?{proposal:current,spoken_text:'Review this exact proposal and choose Confirm and save on the dashboard. No record has been saved by the voice function.',function_name:call.name,intent:'confirm'}
        :{spoken_text:'Which update do you want to review? Open the exact proposal in the dashboard before confirming it.',function_name:'respond_to_user',intent:'clarify'};
    }else if(call.name==='get_medication_explanation'){
      const plan=state.medication_plans.find(item=>item.active===true),medicine=rows(plan?.medicines).find(item=>item.id===call.arguments.medicine_id);requireCare(medicine,422,'The identified medicine is not in the active checked plan.');
      result={spoken_text:`Checked plan: ${text(medicine.name)}. ${text(medicine.reviewed_reference)||text(medicine.instructions)} Source: ${text(medicine.reference_source)||text(plan?.source)}.`,function_name:call.name,intent:'explain'};
    }else if(call.name==='get_support_status'){
      const record=state.support_requests.find(item=>item.id===call.arguments.record_id);requireCare(record,422,'This support request is unavailable.');
      result={spoken_text:`Stored request status: ${text(record.status)}.${record.acknowledged_at?` Human acknowledgement recorded at ${record.acknowledged_at}.`:' No human acknowledgement is recorded.'}${record.outcome?` Reported outcome: ${record.outcome}.`:''}`,function_name:call.name,intent:'support_status'};
    }else if(call.name==='get_followup_status'){
      const record=state.followups.find(item=>item.id===call.arguments.record_id);requireCare(record,422,'This follow-up is unavailable.');result={spoken_text:`Stored follow-up status: ${text(record.resolution_state)}.${record.reported_outcome?` Human-reported outcome: ${record.reported_outcome}.`:' No human-reported outcome is recorded.'}`,function_name:call.name,intent:'followup_status'};
    }else{
      requireCare(call.name==='respond_to_user'&&['clarify','chat'].includes(text(call.arguments.intent)),503,'This care function is unsupported.');result={spoken_text:text(call.arguments.spoken_text),function_name:call.name,intent:text(call.arguments.intent)};
    }
    await beforePersist();
    await finishVoiceJob(db,context,user.userId,recordingId,leaseAt,result);
    await db.prepare("UPDATE voice_recordings SET error_code = NULL WHERE id = ? AND owner_id = ? AND error_code = 'interpretation_unavailable'").bind(recordingId,user.userId).run();
    return result;
  }catch(error){
    await failVoiceJob(db,user.userId,recordingId,leaseAt);
    if(error instanceof CareError)throw error;
    throw new CareError(503,'OpenAI could not prepare this update. Your transcript remains available.');
  }
}
