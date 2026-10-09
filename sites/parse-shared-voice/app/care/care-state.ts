import payloadDefinitions from "./payload-definitions.json";
import { previewDashboard } from "./uiPreview";
import type { Dashboard, Proposal, Row, VocabularyView } from "./api";

export type CareProposal=Proposal&{created_at?:string;source_recording_id?:string;source_type?:string;record_type?:string;record_id?:string;confirmed_at?:string;replaced_by_id?:string};
export type CareState=Omit<Dashboard,"proposals">&{proposals:CareProposal[];vocabulary:VocabularyView};
export type Schema={type?:string;anyOf?:Schema[];$ref?:string;$defs?:Record<string,Schema>;properties?:Record<string,Schema>;required?:string[];additionalProperties?:boolean;items?:Schema;default?:unknown;enum?:unknown[];minLength?:number;maxLength?:number;minItems?:number;maxItems?:number;minimum?:number;maximum?:number;format?:string};
export class CareError extends Error {constructor(readonly status:number,message:string){super(message);}}
export function requireCare(value:unknown,status:number,message:string):asserts value {if(!value)throw new CareError(status,message);}
export const text=(value:unknown)=>typeof value==='string'?value:'';
export const rows=(value:unknown):Row[]=>Array.isArray(value)?value as Row[]:[];
export const strings=(value:unknown):string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string')?value:[];
export const iso=()=>new Date().toISOString();
export const id=()=>crypto.randomUUID();
export function object(value:unknown):Row {requireCare(value&&typeof value==='object'&&!Array.isArray(value),422,'Use a valid object.');return value as Row;}
export function validateSchema(value:unknown,schema:Schema,root:Schema=schema,path='details'):unknown {
  if(schema.$ref){const referenced=root.$defs?.[schema.$ref.split('/').pop()!];requireCare(referenced,422,'This schema is unavailable.');return validateSchema(value,referenced,root,path);}
  if(value===undefined&&schema.default!==undefined)return structuredClone(schema.default);
  if(schema.anyOf){for(const option of schema.anyOf){try{return validateSchema(value,option,root,path);}catch(error){if(!(error instanceof CareError))throw error;}}throw new CareError(422,`Check ${path.replaceAll('_',' ')}.`);}
  if(schema.enum)requireCare(schema.enum.includes(value),422,`Choose a valid ${path.replaceAll('_',' ')}.`);
  if(schema.type==='null'){requireCare(value===null,422,`Check ${path}.`);return null;}
  if(schema.type==='object'){
    const input=object(value),properties=schema.properties??{},result:Row={};
    if(schema.additionalProperties===false)requireCare(Object.keys(input).every(key=>Object.hasOwn(properties,key)),422,`Unsupported field in ${path}.`);
    for(const [key,child] of Object.entries(properties)){
      if(input[key]===undefined&&!(schema.required??[]).includes(key)&&child.default===undefined)continue;
      requireCare(input[key]!==undefined||child.default!==undefined,422,`Enter ${key.replaceAll('_',' ')}.`);
      result[key]=validateSchema(input[key],child,root,key);
    }return result;
  }
  if(schema.type==='array'){
    requireCare(Array.isArray(value),422,`Check ${path}.`);requireCare(value.length<=(schema.maxItems??100)&&value.length>=(schema.minItems??0),422,`Check the number of ${path}.`);
    return value.map(item=>schema.items?validateSchema(item,schema.items,root,path):item);
  }
  if(schema.type==='string'){
    requireCare(typeof value==='string',422,`Enter ${path.replaceAll('_',' ')}.`);const cleaned=value.trim();
    requireCare(cleaned.length>=(schema.minLength??0)&&cleaned.length<=(schema.maxLength??5000),422,`Check the length of ${path.replaceAll('_',' ')}.`);
    if(schema.format==='date-time'){
      const date=cleaned.slice(0,10),calendar=Date.parse(`${date}T00:00:00Z`);
      requireCare(/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(cleaned)
        &&Number.isFinite(calendar)&&new Date(calendar).toISOString().slice(0,10)===date&&Number.isFinite(Date.parse(cleaned)),422,`Enter a valid ${path.replaceAll('_',' ')} with a timezone offset.`);
    }
    if(schema.format==='date'){
      const parsed=Date.parse(cleaned+'T00:00:00Z');
      requireCare(/^\d{4}-\d\d-\d\d$/.test(cleaned)&&Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===cleaned,422,`Enter a valid ${path.replaceAll('_',' ')}.`);
    }
    return cleaned;
  }
  if(schema.type==='integer'||schema.type==='number'){
    requireCare(typeof value==='number'&&Number.isFinite(value)&&(schema.type!=='integer'||Number.isInteger(value)),422,`Enter a number for ${path}.`);
    requireCare(value>=(schema.minimum??-Infinity)&&value<=(schema.maximum??Infinity),422,`Check ${path.replaceAll('_',' ')}.`);return value;
  }
  if(schema.type==='boolean'){requireCare(typeof value==='boolean',422,`Check ${path}.`);return value;}
  return value;
}

export function seedState(email:string,name:string):CareState {
  const sample=previewDashboard(),mapping=new Map<string,string>();
  function collect(value:unknown){if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object'){const record=value as Row;if(typeof record.id==='string')mapping.set(record.id,id());Object.values(record).forEach(collect);}}
  collect(sample);mapping.set('sample-caregiver',email);
  function replace(value:unknown):unknown {if(typeof value==='string')return mapping.get(value)??value;if(Array.isArray(value))return value.map(replace);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replace(item)]));return value;}
  const state=replace(sample) as CareState;
  state.permissions=['*'];state.access_grants=[];state.allowed_recipients=[{id:email,name,relationship:'caregiver'}];state.summaries=[];
  state.active_companion=null;state.devices=[];
  state.vocabulary={version:1,terms:[],reviewed_by_user_id:null,reviewed_at:null};
  for(const request of state.support_requests){request.recipient_name=name;request.recipient_user_id=email;}
  for(const record of [...state.notes,...state.measurements,...state.doses,...state.preventive_tasks,...state.support_requests,...state.followups]){
    record.version=1;record.patient_id=state.patient.id;record.provenance={type:'dashboard',confirmed_at:record.confirmed_at??null,fictional_sample:true};
  }
  for(const followup of state.followups){followup.related_id=state.support_requests[0]?.id;followup.permitted_user_ids=[email];followup.permission_scope='private';}
  for(const note of state.notes)note.shared_with_user_ids=[];
  return state;
}

const states=new Set(['planned','due','arranged','completed','declined','needs_discussion']);
const transitions:Record<string,string[]>={planned:['due','arranged','declined','needs_discussion'],due:['arranged','declined','needs_discussion'],arranged:['completed','declined','needs_discussion'],completed:['needs_discussion'],declined:['needs_discussion','arranged'],needs_discussion:['planned','due','arranged','declined']};
const reports=new Set(['reported_taken','reported_skipped','reported_not_yet','reported_uncertain']);
const derived:Record<string,string[]>={health_note:['share_with_names'],medication_report:['plan_version','medicine_name','scheduled_at','previous_report_state','previous_confirmation_proposal_id'],preventive_task:['previous_state','base_version'],support_request:['recipient_name','calling_route','calling_route_message'],measurement:['base_version'],followup:['previous_resolution_state','base_version','permitted_user_ids']};
export function sourcePayload(kind:string,value:Row):Row {
  const result=Object.fromEntries(Object.entries(value).filter(([key,item])=>item!==null&&!derived[kind]?.includes(key)));
  if(kind==='followup'&&result.followup_id)for(const key of ['related_type','related_id','check_at','permission_scope'])delete result[key];
  return result;
}
function timeZone(value:unknown){try {new Intl.DateTimeFormat('en',{timeZone:text(value)}).format();}catch{throw new CareError(422,'Choose a valid timezone.');}}
function recipient(state:CareState,email:unknown){return state.allowed_recipients.find(user=>user.id===email);}
function current(state:CareState,collection:keyof Dashboard,recordId:unknown){const record=rows(state[collection]).find(row=>row.id===recordId&&!row.deleted_at&&!row.superseded_at);requireCare(record,422,'The referenced record is no longer available.');return record;}

export function validatePayload(kind:string,input:Row,state:CareState,actor:string):Row {
  const definition=(payloadDefinitions as Record<string,Schema>)[kind];requireCare(definition,422,'Choose a supported entry type.');
  const payload=object(validateSchema(sourcePayload(kind,input),definition));
  for(const key of Object.keys(payload))if(payload[key]===null)delete payload[key];
  if(payload.timezone)timeZone(payload.timezone);
  if(kind==='health_note'){
    requireCare(!(payload.occurred_at&&payload.occurrence_text),422,'Use an exact time or an approximate time, rather than both.');
    const users=strings(payload.share_with_user_ids);requireCare(new Set(users).size===users.length&&users.every(email=>!!recipient(state,email)),422,'Choose currently permitted people for sharing.');
    payload.share_with_user_ids=users;payload.share_with_names=users.map(email=>recipient(state,email)!.name);
  }
  if(kind==='medication_report'){
    requireCare(reports.has(text(payload.report_state))&&(!payload.taken_time_text||payload.report_state==='reported_taken'),422,'Choose a valid reported medication status.');
    const dose=current(state,'doses',payload.dose_instance_id),active=state.medication_plans.find(plan=>plan.active===true);
    requireCare(active&&dose.plan_version===active.version,409,'This dose is no longer in the active checked plan.');
    requireCare(['unconfirmed','reported_not_yet','reported_uncertain'].includes(text(dose.report_state)),409,'This dose already has a final confirmed report.');
    Object.assign(payload,{plan_version:dose.plan_version,medicine_name:dose.medicine_name,scheduled_at:dose.scheduled_at,previous_report_state:dose.report_state,previous_confirmation_proposal_id:dose.confirmation_proposal_id??null});
  }
  if(kind==='measurement'){
    requireCare(payload.measurement_type==='blood_pressure'&&payload.unit==='mmHg'&&!!payload.occurred_at!==!!payload.occurrence_text,422,'Use a reported blood-pressure reading with its source and one occurrence time.');
    requireCare(['patient','caregiver'].includes(text(payload.reporting_actor)),422,'Choose the person who reported this reading.');
    if(payload.supersedes_id)payload.base_version=current(state,'measurements',payload.supersedes_id).version??1;
  }
  if(kind==='preventive_task'){
    requireCare(states.has(text(payload.state)),422,'Choose a valid care-plan status.');
    if(payload.task_id){
      requireCare(!['task_type','description','source','due_date','timezone'].some(key=>payload[key]),422,'A task update cannot replace its original care-plan details.');
      const task=current(state,'preventive_tasks',payload.task_id);requireCare(transitions[text(task.state)]?.includes(text(payload.state)),409,'That care-plan transition is no longer available.');
      payload.previous_state=task.state;payload.base_version=task.version??1;
    }else requireCare(['task_type','description','source','due_date','timezone'].every(key=>payload[key]),422,'Enter the task, care-plan description, source, due date and timezone.');
  }
  if(kind==='support_request'){
    const user=recipient(state,payload.recipient_user_id);requireCare(user,422,'Choose a permitted recipient.');requireCare(['routine','urgent'].includes(text(payload.urgency)),422,'Choose routine or urgent.');payload.recipient_name=user.name;
    if(payload.urgency==='urgent')payload.calling_route_message=state.patient.calling_route||'Use your usual phone contact method. No help has been dispatched.';
  }
  if(kind==='followup'){
    if(payload.followup_id){
      const followup=current(state,'followups',payload.followup_id);requireCare(followup.resolution_state==='open'&&payload.resolution_state==='resolved'&&text(payload.reported_outcome),409,'Resolving an open follow-up requires a reported outcome.');
      Object.assign(payload,{related_type:followup.related_type,related_id:followup.related_id,check_at:followup.check_at,permission_scope:followup.permission_scope,permitted_user_ids:followup.permitted_user_ids,previous_resolution_state:'open',base_version:followup.version??1});
    }else{
      const collection={health_note:'notes',support_request:'support_requests',medication_report:'doses'}[text(payload.related_type)] as keyof Dashboard|undefined;
      requireCare(collection&&payload.check_at&&['private','related_recipients'].includes(text(payload.permission_scope))&&payload.resolution_state==='open'&&!payload.reported_outcome,422,'Choose an existing related record, a follow-up time and who may see it.');
      const related=current(state,collection,payload.related_id);
      requireCare(payload.related_type!=='medication_report'||payload.permission_scope==='private',422,'Medication follow-ups stay private.');
      const audience=payload.related_type==='support_request'?[text(related.recipient_user_id)]:strings(related.shared_with_user_ids);
      payload.permitted_user_ids=payload.permission_scope==='private'?[actor]:audience;
      requireCare(strings(payload.permitted_user_ids).length>0,422,'The related record has no sharing recipients. Choose private instead.');
    }
  }
  return payload;
}

export function readback(kind:string,payload:Row):string {
  const when=payload.occurred_at?` Occurred at ${text(payload.occurred_at)}.`:payload.occurrence_text?` Reported time: ${text(payload.occurrence_text)}.`:' No occurrence time was stated.';
  if(kind==='health_note')return `Record the reported note: “${text(payload.wording)}”.${when} ${strings(payload.share_with_names).length?`Share with ${strings(payload.share_with_names).join(', ')}.`:'Keep this note private.'}`;
  if(kind==='measurement')return `Record the reported external blood pressure ${payload.systolic}/${payload.diastolic} mmHg from ${text(payload.source_description)}, reported by ${text(payload.reporting_actor)}.${when}${payload.supersedes_id?' This corrects the identified earlier reading.':''}`;
  if(kind==='medication_report')return `Record ${text(payload.medicine_name)} for the scheduled dose at ${text(payload.scheduled_at)} as ${text(payload.report_state).replaceAll('_',' ')}.${payload.taken_time_text?` Reported timing: ${text(payload.taken_time_text)}.`:''} This is a reported status.`;
  if(kind==='preventive_task')return payload.task_id?`Update the identified care-plan task from ${text(payload.previous_state).replaceAll('_',' ')} to ${text(payload.state).replaceAll('_',' ')}.${payload.appointment_date?` Appointment: ${payload.appointment_date}.`:''}${payload.completion_date?` Completion: ${payload.completion_date}.`:''}`:`Add the care-plan task “${text(payload.description)}”, source ${text(payload.source)}, due ${text(payload.due_date)}, status ${text(payload.state)}.`;
  if(kind==='support_request')return `Share the support request “${text(payload.request_text)}” with ${text(payload.recipient_name)}. Urgency: ${text(payload.urgency)}.${payload.barrier_text?` Reported barrier: ${payload.barrier_text}.`:''} This does not dispatch help.${payload.calling_route_message?` ${payload.calling_route_message}`:''}`;
  return payload.followup_id?`Resolve the identified follow-up with the reported outcome “${text(payload.reported_outcome)}”.`:`Add a follow-up for the identified ${text(payload.related_type).replaceAll('_',' ')} at ${text(payload.check_at)}. ${payload.permission_scope==='private'?'Keep it private.':'Share with the related record’s permitted recipients.'}`;
}

export function prepareProposal(state:CareState,kind:string,input:Row,actor:string,sourceRecording?:string):CareProposal {
  requireCare(state.proposals.filter(proposal=>proposal.status==='pending'&&Date.parse(proposal.expires_at!)>Date.now()).length<50,429,'Review the current proposals before adding more.');
  const payload=validatePayload(kind,input,state,actor),proposal:CareProposal={id:id(),created_at:iso(),kind,payload,readback:readback(kind,payload),status:'pending',expires_at:new Date(Date.now()+120_000).toISOString(),source_type:sourceRecording?'phone':'dashboard',...(sourceRecording?{source_recording_id:sourceRecording}:{})};
  state.proposals.unshift(proposal);return proposal;
}

export function invalidateSummaries(state:CareState){for(const summary of state.summaries){summary.invalidated_at=iso();summary.source_access_current=false;summary.url=null;summary.share_active=false;}}
export function commitProposal(state:CareState,proposal:CareProposal,actor:string):{status:string;record_type:string;record_id:string} {
  if(proposal.status==='committed')return {status:'committed',record_type:proposal.record_type!,record_id:proposal.record_id!};
  requireCare(proposal.status==='pending'&&Date.parse(proposal.expires_at!)>Date.now(),409,'This proposal expired or changed. Prepare and review a fresh version.');
  const checked=validatePayload(proposal.kind,proposal.payload,state,actor);
  for(const key of ['base_version','previous_state','previous_report_state','previous_confirmation_proposal_id','plan_version','previous_resolution_state'])requireCare(JSON.stringify(checked[key])===JSON.stringify(proposal.payload[key]),409,'The referenced record changed. Review a fresh proposal before saving.');
  const timestamp=iso(),recordId=id(),provenance={type:proposal.source_type??'dashboard',confirmed_at:timestamp,proposal_id:proposal.id,recording_id:proposal.source_recording_id??null};
  let record:Row={...checked,id:recordId,patient_id:state.patient.id,version:1,created_at:timestamp,confirmed_at:timestamp,provenance},recordType=proposal.kind;
  if(proposal.kind==='health_note'){record.shared_with_user_ids=strings(checked.share_with_user_ids);state.notes.unshift(record);}
  if(proposal.kind==='measurement'){
    if(checked.supersedes_id){const previous=current(state,'measurements',checked.supersedes_id);previous.superseded_at=timestamp;previous.superseded_by_id=recordId;previous.version=Number(previous.version??1)+1;invalidateSummaries(state);}
    state.measurements.unshift(record);
  }
  if(proposal.kind==='medication_report'){
    record=current(state,'doses',checked.dose_instance_id);record.report_history=[...rows(record.report_history),{id:recordId,report_state:checked.report_state,taken_time_text:checked.taken_time_text??null,report_time:timestamp,provenance}];
    Object.assign(record,{report_state:checked.report_state,report_time:timestamp,taken_time_text:checked.taken_time_text??null,confirmation_proposal_id:proposal.id,version:Number(record.version??1)+1,provenance});invalidateSummaries(state);
  }
  if(proposal.kind==='preventive_task'){
    if(checked.task_id){record=current(state,'preventive_tasks',checked.task_id);record.transitions=[...rows(record.transitions),{id:recordId,from_state:record.state,to_state:checked.state,appointment_date:checked.appointment_date??null,completion_date:checked.completion_date??null,provenance}];Object.assign(record,{state:checked.state,version:Number(record.version??1)+1,...(checked.appointment_date?{appointment_date:checked.appointment_date}:{}),...(checked.completion_date?{completion_date:checked.completion_date}:{})});invalidateSummaries(state);}else state.preventive_tasks.unshift(record);
  }
  if(proposal.kind==='support_request'){record.status='open';record.requester_name=state.patient.name;state.support_requests.unshift(record);}
  if(proposal.kind==='followup'){
    if(checked.followup_id){record=current(state,'followups',checked.followup_id);record.resolutions=[...rows(record.resolutions),{id:recordId,reported_outcome:checked.reported_outcome,resolved_at:timestamp,provenance}];Object.assign(record,{resolution_state:'resolved',reported_outcome:checked.reported_outcome,resolved_at:timestamp,version:Number(record.version??1)+1});invalidateSummaries(state);}else {record.description=`Follow up on ${text(checked.related_type).replaceAll('_',' ')}`;state.followups.unshift(record);}
  }
  recordType=proposal.kind;Object.assign(proposal,{status:'committed',confirmed_at:timestamp,record_type:recordType,record_id:text(record.id)});
  return {status:'committed',record_type:recordType,record_id:text(record.id)};
}
