import { careActivity } from "./care-activity";
import { presentCareLabels } from "./presentation";
import { dashboardAccess, type DashboardIdentity } from "../dashboard-access";
import type { VoiceBindings } from "../voice-backend";
import type { Dashboard, Row } from "./api";
import { CareError, commitProposal, id, invalidateSummaries, iso, object, prepareProposal, requireCare, rows, seedState, strings, text, type CareState } from "./care-state";
import { interpretRecording } from "./care-interpretation";

export type CareIdentity=DashboardIdentity&{displayName?:string};
type Workspace={owner_id:string;owner_email:string;patient_id:string;version:number;state_json:string;updated_at:number};
type Grant={id:string;owner_id:string;user_email:string;scopes_json:string;created_at:number;revoked_at:number|null};
type Context={workspace:Workspace;state:CareState;grants:Grant[];permissions:string[];isOwner:boolean};
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const grantScopes=new Set(['read:dashboard','read:notes','read:measurements','read:medications','ack:support','resolve:support']);
const identifiers=/^[a-zA-Z0-9_-]{1,160}$/;
const normalize=(email:string)=>email.trim().toLowerCase();
function allowedEmails(bindings:VoiceBindings){return (bindings.DASHBOARD_ALLOWED_EMAILS??'').split(',').map(normalize).filter(Boolean);}
async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');}
async function requestBody(request:Request):Promise<Row>{
  requireCare(Number(request.headers.get('Content-Length')??0)<=65536,413,'This update is too large.');
  const reader=request.body?.getReader();requireCare(reader,400,'This update is missing.');let bytes=0;const parts:Uint8Array[]=[];
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;requireCare(bytes<=65536,413,'This update is too large.');parts.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
  const buffer=new Uint8Array(bytes);let at=0;for(const part of parts){buffer.set(part,at);at+=part.length;}
  try{return object(JSON.parse(new TextDecoder().decode(buffer)));}catch(error){if(error instanceof CareError)throw error;throw new CareError(400,'Use a valid update.');}
}
function assertOwner(context:Context){requireCare(context.isOwner,403,'The care-space owner manages this change.');}
function assertPermission(context:Context,scope:string){requireCare(context.isOwner||context.permissions.includes(scope),403,'Your account does not have permission for this change.');}
export async function persistCare(db:D1Database,context:Context,extra:D1PreparedStatement[]=[]){
  const serialized=JSON.stringify(context.state);requireCare(serialized.length<=900000,413,'This care space is full.');
  const updated=db.prepare('UPDATE care_workspaces SET state_json = ?, version = version + 1, updated_at = ? WHERE owner_id = ? AND version = ?').bind(serialized,Date.now(),context.workspace.owner_id,context.workspace.version);
  const result=extra.length?(await db.batch([...extra,updated])).at(-1)!:await updated.run();
  requireCare(result.meta.changes===1,409,'The care space changed while you were reviewing. Refresh and try again.');
  context.workspace.version++;context.workspace.state_json=serialized;
}
async function initialize(db:D1Database,user:CareIdentity){
  const email=normalize(user.email),name=user.displayName||email;
  const existing=await db.prepare('SELECT * FROM care_workspaces WHERE owner_id = ?').bind(user.userId).first<Workspace>();if(existing)return existing;
  const state=seedState(email,name);
  await db.prepare('INSERT OR IGNORE INTO care_workspaces (owner_id,owner_email,patient_id,version,state_json,updated_at) VALUES (?,?,?,1,?,?)').bind(user.userId,email,state.patient.id,JSON.stringify(state),Date.now()).run();
  return (await db.prepare('SELECT * FROM care_workspaces WHERE owner_id = ?').bind(user.userId).first<Workspace>())!;
}
async function contexts(db:D1Database,user:CareIdentity,bindings:VoiceBindings):Promise<Context[]>{
  const own=await initialize(db,user),email=normalize(user.email),allowed=allowedEmails(bindings);
  const all=await db.prepare('SELECT DISTINCT w.* FROM care_workspaces w LEFT JOIN care_grants g ON g.owner_id = w.owner_id WHERE w.owner_id = ? OR (g.user_email = ? AND g.revoked_at IS NULL) LIMIT 30').bind(user.userId,email).all<Workspace>();
  const ordered=[own,...all.results.filter(workspace=>workspace.owner_id!==own.owner_id&&allowed.includes(workspace.owner_email))];
  return Promise.all(ordered.map(async workspace=>{
    const grantRows=await db.prepare('SELECT * FROM care_grants WHERE owner_id = ? AND revoked_at IS NULL').bind(workspace.owner_id).all<Grant>();
    const grants=grantRows.results.filter(grant=>allowed.includes(grant.user_email)),isOwner=workspace.owner_id===user.userId;
    const permissions=isOwner?['*']:Array.from(new Set(grants.filter(grant=>grant.user_email===email).flatMap(grant=>strings(JSON.parse(grant.scopes_json)))));
    const state=presentCareLabels(JSON.parse(workspace.state_json) as CareState) as CareState;
    state.allowed_recipients=[{id:workspace.owner_email,name:isOwner?(user.displayName||email):workspace.owner_email,relationship:'caregiver'},...grants.map(grant=>({id:grant.user_email,name:grant.user_email,relationship:'caregiver'}))];
    state.access_grants=grants.map(grant=>({id:grant.id,relationship:'caregiver',user:{id:grant.user_email,name:grant.user_email,email:grant.user_email},scopes:JSON.parse(grant.scopes_json),expires_at:null}));
    return {workspace,state,grants,permissions,isOwner};
  }));
}
function visible(context:Context,email:string):Dashboard {
  const result=structuredClone(context.state);result.permissions=context.permissions;result.notes=result.notes.filter(note=>!note.deleted_at&&(context.isOwner||(context.permissions.includes('read:notes')&&strings(note.shared_with_user_ids).includes(email))));
  if(!context.isOwner){
    result.measurements=context.permissions.includes('read:measurements')?result.measurements:[];
    result.medication_plans=context.permissions.includes('read:medications')?result.medication_plans:[];result.doses=context.permissions.includes('read:medications')?result.doses:[];
    result.preventive_tasks=context.permissions.includes('read:dashboard')?result.preventive_tasks:[];
    result.support_requests=result.support_requests.filter(record=>record.recipient_user_id===email);
    result.followups=result.followups.filter(record=>strings(record.permitted_user_ids).includes(email));
    result.proposals=[];result.summaries=[];result.devices=[];result.active_companion=null;result.access_grants=[];result.allowed_recipients=[];
    result.patient={id:result.patient.id,name:result.patient.name,preferred_name:result.patient.preferred_name,timezone:result.patient.timezone};
  }
  delete (result as Partial<CareState>).vocabulary;return result;
}
function findRecord(context:Context,id:string,collection:keyof Dashboard){const record=rows(context.state[collection]).find(row=>row.id===id&&!row.deleted_at);requireCare(record,404,'This record is unavailable.');return record;}
function summaryCurrent(context:Context,summary:Row){
  requireCare(!summary.invalidated_at&&summary.source_access_current!==false,410,'A source record or sharing permission changed. Prepare and review a fresh summary.');
  const collections:Record<string,keyof Dashboard>={health_note:'notes',measurement:'measurements',medication_report:'doses',preventive_task:'preventive_tasks',support_request:'support_requests',followup:'followups'};
  for(const source of rows(summary.sources)){
    const collection=collections[text(source.type)];requireCare(collection,410,'A summary source is unavailable.');
    const record=findRecord(context,text(source.id),collection);requireCare(!record.superseded_at&&Number(record.version??1)===Number(source.version),410,'A summary source changed. Prepare a fresh summary.');
  }
}
function queryItem(record:Row,sourceType:string):Row{return {...record,source_type:sourceType,source_id:record.id,source_version:record.version??1,recorded_at:record.confirmed_at??record.report_time??record.created_at??null,occurred_at:record.occurred_at??null};}
function day(date:string,timeZone:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(date));return ['year','month','day'].map(part=>parts.find(item=>item.type===part)?.value).join('-');}
function concise(record:Row,kind:string){
  if(kind==='health_note')return text(record.wording);
  if(kind==='measurement')return `Reported external blood pressure ${record.systolic}/${record.diastolic} ${text(record.unit)}. Source: ${text(record.source_description)}. Occurrence: ${text(record.occurred_at||record.occurrence_text)||'unknown'}.`;
  if(kind==='medication_report')return `${text(record.medicine_name)}: ${text(record.report_state).replaceAll('_',' ')} at scheduled ${text(record.scheduled_at)}.`;
  if(kind==='preventive_task')return `${text(record.description)}. Recorded status: ${text(record.state)}. Due date: ${text(record.due_date)||'unknown'}.`;
  if(kind==='support_request')return `${text(record.request_text)}. Stored status: ${text(record.status)}.`;
  return `${text(record.description)}. Stored outcome: ${text(record.reported_outcome)||text(record.resolution_state)||'unknown'}.`;
}

export async function serveCare(request:Request,user:CareIdentity|null,bindings:VoiceBindings,fetchImpl:typeof fetch=fetch):Promise<Response>{
  try{
    const access=dashboardAccess(user,bindings);requireCare(access==='allowed',access==='anonymous'?401:403,access==='anonymous'?'Sign in with an invited ChatGPT account.':'This account has not been invited to the dashboard.');
    requireCare(bindings.DB,503,'Care storage is temporarily unavailable.');const db=bindings.DB,actor=user!,email=normalize(actor.email),url=new URL(request.url),path=url.pathname.replace(/^\/v1\/?/,'');
    if(!['GET','HEAD'].includes(request.method))requireCare(request.headers.get('Origin')===(bindings.PUBLIC_SITE_ORIGIN||url.origin)&&request.headers.get('X-CSRF-Token')==='parse-care',403,'Make this change from the signed-in Parse dashboard.');
    const available=await contexts(db,actor,bindings);
    if(path==='auth/session'&&request.method==='GET')return reply({user:{id:email,name:actor.displayName||email,email,role:'owner'},patients:available.map(context=>visible(context,email).patient),csrf_token:'parse-care'});
    if(path==='auth/logout'&&request.method==='POST')return reply({sign_out_path:'/signout-with-chatgpt?return_to=%2F'});
    const shared=/^shared\/summaries\/([a-f0-9]{64})$/.exec(path);
    if(shared&&request.method==='GET'){
      const link=await db.prepare('SELECT owner_id,summary_id,expires_at FROM care_summary_links WHERE token_hash = ? AND revoked_at IS NULL').bind(await hash(shared[1])).first<{owner_id:string;summary_id:string;expires_at:number}>();requireCare(link&&link.expires_at>Date.now(),410,'This summary link expired or was revoked.');
      const workspace=await db.prepare('SELECT * FROM care_workspaces WHERE owner_id = ?').bind(link.owner_id).first<Workspace>();requireCare(workspace&&allowedEmails(bindings).includes(workspace.owner_email),410,'This summary is no longer available.');
      const state=JSON.parse(workspace.state_json) as CareState,context:Context={workspace,state,grants:[],permissions:[],isOwner:false};
      const summary=findRecord(context,link.summary_id,'summaries');summaryCurrent(context,summary);requireCare(summary.status==='reviewed',410,'This summary needs a fresh review.');
      return reply({patient:{name:state.patient.name,preferred_name:state.patient.preferred_name},summary:{...summary,url:undefined,share_token:undefined}});
    }
    const patientRoute=/^app\/patients\/([a-zA-Z0-9_-]{1,160})\/(.+)$/.exec(path);
    let context:Context|undefined;
    if(patientRoute)context=available.find(candidate=>candidate.state.patient.id===patientRoute[1]);
    else{
      const objectMatch=/^app\/(proposals|support-requests|summaries|notes|grants|devices)\/([a-zA-Z0-9_-]{1,160})(?:\/.*)?$/.exec(path);
      if(objectMatch){
        const collection=({proposals:'proposals','support-requests':'support_requests',summaries:'summaries',notes:'notes'} as Record<string,keyof Dashboard>)[objectMatch[1]];
        context=collection?available.find(candidate=>rows(candidate.state[collection]).some(record=>record.id===objectMatch[2])):objectMatch[1]==='grants'?available.find(candidate=>candidate.grants.some(grant=>grant.id===objectMatch[2])):available.find(candidate=>candidate.isOwner);
      }
    }
    requireCare(context,404,'This care space or record is unavailable.');const currentContext=context,state=context.state,action=patientRoute?.[2]??path;
    const ownerVersion=context.workspace.version,ownerId=context.workspace.owner_id;
    if(action==='activity'&&request.method==='GET')return reply(await careActivity(db,visible(context,email),context.isOwner?ownerId:null,url.searchParams));
    if(action==='dashboard'&&request.method==='GET'){
      if(context.isOwner){
        const rooms=await db.prepare("SELECT id,state,updated_at FROM voice_rooms WHERE owner_id = ? AND state IN ('paired','pending') AND expires_at > ? ORDER BY created_at DESC").bind(ownerId,Date.now()).all<{id:string;state:string;updated_at:number}>();
        state.devices=rooms.results.map(room=>({id:room.id,device_type:'phone',platform:'web',display_name:'Paired browser',status:room.state==='paired'?'connected':'awaiting_connection',last_seen:null,pairing_approved_at:new Date(room.updated_at).toISOString(),revoked_at:null,selected:state.active_companion?.device_id===room.id}));
        state.device_setup={service_address:bindings.PUBLIC_PHONE_ORIGIN??url.origin,voice_service:bindings.OPENAI_API_KEY?'configured':'unconfigured',live_voice_verified:false,scheduler_enabled:false};
        if(!state.active_companion&&rooms.results.some(room=>room.state==='paired'))state.active_companion={device_id:rooms.results.find(room=>room.state==='paired')!.id,generation:1};
      }return reply(visible(context,email));
    }
    if(action==='vocabulary'&&request.method==='GET'){assertOwner(context);return reply(state.vocabulary);}
    if(action==='vocabulary/suggestions'&&request.method==='GET'){
      const data=visible(context,email);return reply({suggestions:data.medication_plans.flatMap(plan=>rows(plan.medicines).map(medicine=>({canonical:medicine.name,aliases:[],category:'medicine'})))});
    }
    if(action==='vocabulary'&&request.method==='PUT'){
      assertOwner(context);const data=await requestBody(request);requireCare(data.expected_version===state.vocabulary.version,409,'The reviewed names changed. Reload them before saving.');
      const terms=rows(data.terms);requireCare(Array.isArray(data.terms)&&terms.length<=100,422,'Keep at most 100 reviewed names.');const spellings=new Set<string>();
      for(const term of terms){requireCare(text(term.canonical).trim().length>0&&text(term.canonical).length<=120&&['medicine','person','other'].includes(text(term.category)),422,'Enter a valid reviewed name and category.');requireCare(Array.isArray(term.aliases)&&strings(term.aliases).length<=10,422,'Use up to 10 aliases per name.');for(const spelling of [text(term.canonical),...strings(term.aliases)]){const normalized=normalize(spelling);requireCare(normalized&&normalized.length<=120&&!spellings.has(normalized),422,'Reviewed spellings must be nonempty and unique.');spellings.add(normalized);}}
      state.vocabulary={version:state.vocabulary.version+1,terms:terms as unknown as CareState['vocabulary']['terms'],reviewed_by_user_id:email,reviewed_at:iso()};await persistCare(db,context);return reply(state.vocabulary);
    }
    if(action==='profile'&&request.method==='PUT'){
      assertOwner(context);const data=await requestBody(request);requireCare(Object.keys(data).every(key=>['preferred_name','language','timezone','daily_check_in_enabled','daily_check_in_local_time','calling_route'].includes(key)),422,'Unsupported care preference.');
      if(data.timezone){try{new Intl.DateTimeFormat('en',{timeZone:text(data.timezone)}).format();}catch{throw new CareError(422,'Choose a valid timezone.');}}
      requireCare(!data.preferred_name||text(data.preferred_name).length<=120,422,'Keep the preferred name short.');requireCare(data.daily_check_in_enabled===true||data.daily_check_in_enabled===false,422,'Choose a check-in preference.');requireCare(!data.daily_check_in_local_time||/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text(data.daily_check_in_local_time)),422,'Choose a valid check-in time.');
      Object.assign(state.patient,data);await persistCare(db,context);return reply(state.patient);
    }
    if(action==='queries'&&request.method==='POST'){
      const data=await requestBody(request),view=visible(context,email),kind=text(data.kind);let items:Row[]=[];
      if(kind==='latest_reading'){assertPermission(context,'read:measurements');items=view.measurements.filter(record=>!record.superseded_at).sort((a,b)=>text(b.created_at||b.confirmed_at||b.recorded_at).localeCompare(text(a.created_at||a.confirmed_at||a.recorded_at))||text(b.id).localeCompare(text(a.id))).slice(0,1).map(record=>queryItem(record,'measurement'));}
      else if(kind==='open_support')items=view.support_requests.filter(record=>!['resolved','closed'].includes(text(record.status))).sort((a,b)=>text(b.created_at||b.confirmed_at).localeCompare(text(a.created_at||a.confirmed_at))).map(record=>queryItem(record,'support_request'));
      else if(kind==='medication_reports'){assertPermission(context,'read:medications');requireCare(/^\d{4}-\d\d-\d\d$/.test(text(data.local_date)),422,'Choose the scheduled dose date.');items=view.doses.filter(record=>day(text(record.scheduled_at),state.patient.timezone)===data.local_date).map(record=>queryItem(record,'dose'));}
      else throw new CareError(422,'Choose a supported care question.');
      return reply({kind,generated_at:iso(),timezone:state.patient.timezone,date_basis:kind==='medication_reports'?'scheduled_local_date':'recorded_at',local_date:kind==='medication_reports'?data.local_date:null,items:items.slice(0,50),truncated:items.length>50});
    }
    const source=/^query-sources\/(measurement|support_request|dose)\/([a-zA-Z0-9_-]{1,160})$/.exec(action);
    if(source&&request.method==='GET'){
      const collection={measurement:'measurements',support_request:'support_requests',dose:'doses'}[source[1]] as keyof Dashboard;
      const record=rows(visible(context,email)[collection]).find(row=>row.id===source[2]&&!row.deleted_at&&!row.superseded_at);requireCare(record,404,'This source is unavailable to your account.');return reply(queryItem(record,source[1]));
    }
    if(action==='proposals'&&request.method==='POST'){
      assertOwner(context);const data=await requestBody(request),proposal=prepareProposal(state,text(data.kind),object(data.payload),email);await persistCare(db,context);return reply(proposal,201);
    }
    const proposalRoute=/^app\/proposals\/([a-zA-Z0-9_-]{1,160})\/(revise|confirm)$/.exec(action);
    if(proposalRoute&&request.method==='POST'){
      assertOwner(context);const data=await requestBody(request),proposal=state.proposals.find(item=>item.id===proposalRoute[1]);requireCare(proposal,404,'This proposal is unavailable.');
      if(proposalRoute[2]==='revise'){
        requireCare(proposal.status==='pending',409,'Only a pending proposal can be revised.');const replacement=prepareProposal(state,proposal.kind,object(data.payload),email,proposal.source_recording_id);proposal.status='replaced';proposal.replaced_by_id=replacement.id;await persistCare(db,context);return reply(replacement,201);
      }
      requireCare(data.confirmed===true,400,'Confirm this reviewed proposal separately before saving.');const result=commitProposal(state,proposal,email);await persistCare(db,context);return reply(result);
    }
    const support=/^app\/support-requests\/([a-zA-Z0-9_-]{1,160})\/(acknowledge|resolve)$/.exec(action);
    if(support&&request.method==='POST'){
      const record=findRecord(context,support[1],'support_requests');requireCare(context.isOwner||record.recipient_user_id===email,403,'This request is not addressed to you.');assertPermission(context,support[2]==='acknowledge'?'ack:support':'resolve:support');
      requireCare(record.status!=='resolved',409,'This request was already resolved.');if(support[2]==='acknowledge'){record.status='acknowledged';record.acknowledged_at=iso();record.acknowledged_by_user_id=email;}else {const data=await requestBody(request);requireCare(text(data.outcome).trim()&&text(data.outcome).length<=2000,422,'Enter the human-reported outcome.');record.status='resolved';record.outcome=text(data.outcome).trim();record.resolved_at=iso();record.resolved_by_user_id=email;}
      record.version=Number(record.version??1)+1;invalidateSummaries(state);await persistCare(db,context);return reply({updated:true});
    }
    if(action==='medication-plans'&&request.method==='POST'){
      assertOwner(context);const data=await requestBody(request);requireCare(data.checked===true&&text(data.source).trim().length>0,422,'Review the medication source before saving the checked plan.');
      const medicines=rows(data.medicines),schedule=rows(data.schedule),zone=text(data.timezone);requireCare(medicines.length>0&&medicines.length<=30&&schedule.length>0&&schedule.length<=40,422,'Use a bounded checked medication plan.');try{new Intl.DateTimeFormat('en',{timeZone:zone}).format();}catch{throw new CareError(422,'Choose a valid plan timezone.');}
      const medicineIds=new Set<string>();for(const medicine of medicines){requireCare(identifiers.test(text(medicine.id))&&!medicineIds.has(text(medicine.id))&&text(medicine.name).trim()&&text(medicine.instructions).trim()&&text(medicine.reviewed_reference).trim()&&text(medicine.reference_source).trim(),422,'Check each medicine’s name, label details and source.');medicineIds.add(text(medicine.id));}
      const scheduled=new Set<string>();for(const entry of schedule){const key=`${entry.medicine_id}:${entry.local_time}`;requireCare(medicineIds.has(text(entry.medicine_id))&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text(entry.local_time))&&!scheduled.has(key),422,'Choose valid, unique scheduled times.');scheduled.add(key);}
      const version=Math.max(0,...state.medication_plans.map(plan=>Number(plan.version??0)))+1;for(const plan of state.medication_plans)plan.active=false;
      const plan={id:id(),version,active:true,timezone:zone,source:text(data.source),checked_at:iso(),medicines,schedule};state.medication_plans.unshift(plan);
      // Convert each local scheduled time without assuming an eight-hour offset.
      for(let offset=0;offset<7;offset++)for(const entry of schedule){
        const localDate=day(new Date(Date.now()+offset*86400000).toISOString(),zone),target=Date.parse(`${localDate}T${entry.local_time}:00Z`);let at=target;
        for(let pass=0;pass<3;pass++){const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(at)).replace(' ','T');at+=target-Date.parse(parts+'Z');}
        const medicine=medicines.find(item=>item.id===entry.medicine_id)!;state.doses.push({id:id(),patient_id:state.patient.id,medicine_id:medicine.id,medicine_name:medicine.name,instructions:medicine.instructions,plan_version:version,scheduled_at:new Date(at).toISOString(),report_state:'unconfirmed',version:1});
      }
      invalidateSummaries(state);await persistCare(db,context);return reply(plan,201);
    }
    if(action==='grants'&&request.method==='POST'){
      assertOwner(context);const data=await requestBody(request),recipientEmail=normalize(text(data.user_id)),scopes=strings(data.scopes);
      requireCare(allowedEmails(bindings).includes(recipientEmail)&&recipientEmail!==email,422,'Use the email of a teammate already invited to this private Site.');requireCare(scopes.length>0&&scopes.every(scope=>grantScopes.has(scope)),422,'Choose supported sharing permissions.');
      requireCare(!context.grants.some(grant=>grant.user_email===recipientEmail),409,'This teammate already has care-space access. Remove it before changing permissions.');
      const grantId=id(),savedScopes=Array.from(new Set(['read:dashboard',...scopes]));invalidateSummaries(state);
      const insert=db.prepare('INSERT INTO care_grants (id,owner_id,user_email,scopes_json,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM care_workspaces WHERE owner_id = ? AND version = ?)').bind(grantId,ownerId,recipientEmail,JSON.stringify(savedScopes),Date.now(),ownerId,ownerVersion);
      await persistCare(db,context,[insert]);return reply({id:grantId,user:{id:recipientEmail,name:recipientEmail,email:recipientEmail},relationship:'caregiver',scopes:savedScopes},201);
    }
    const grant=/^app\/grants\/([a-zA-Z0-9_-]{1,160})$/.exec(action);
    if(grant&&request.method==='DELETE'){
      assertOwner(context);invalidateSummaries(state);for(const note of state.notes)note.shared_with_user_ids=strings(note.shared_with_user_ids).filter(item=>item!==context.grants.find(grantRow=>grantRow.id===grant[1])?.user_email);
      const revoke=db.prepare('UPDATE care_grants SET revoked_at = ? WHERE id = ? AND owner_id = ? AND EXISTS (SELECT 1 FROM care_workspaces WHERE owner_id = ? AND version = ?)').bind(Date.now(),grant[1],ownerId,ownerId,ownerVersion);
      await persistCare(db,context,[revoke]);return reply({revoked:true});
    }
    const note=/^app\/notes\/([a-zA-Z0-9_-]{1,160})(?:\/(sharing))?$/.exec(action);
    if(note){
      assertOwner(context);const record=findRecord(context,note[1],'notes');
      if(note[2]==='sharing'&&request.method==='PUT'){
        const data=await requestBody(request),users=strings(data.user_ids);requireCare(Array.isArray(data.user_ids)&&new Set(users).size===users.length&&users.every(target=>context.grants.some(grantRow=>grantRow.user_email===target&&strings(JSON.parse(grantRow.scopes_json)).includes('read:notes'))),422,'Choose currently permitted note recipients.');record.shared_with_user_ids=users;record.version=Number(record.version??1)+1;invalidateSummaries(state);await persistCare(db,context);return reply(record);
      }
      if(!note[2]&&request.method==='DELETE'){record.deleted_at=iso();record.version=Number(record.version??1)+1;invalidateSummaries(state);await persistCare(db,context);return reply({deleted:true});}
    }
    if(action==='summaries'&&request.method==='POST'){
      assertOwner(context);const data=await requestBody(request),start=text(data.start_date),end=text(data.end_date),purpose=text(data.purpose),questions=strings(data.questions);
      requireCare(/^\d{4}-\d\d-\d\d$/.test(start)&&/^\d{4}-\d\d-\d\d$/.test(end)&&start<=end,422,'Choose a valid summary period.');requireCare(['doctor_visit','family_handoff','weekly_review'].includes(purpose)&&questions.length<=10&&questions.every(question=>question.length<=500),422,'Choose a supported purpose and up to ten short questions.');
      const sections:Row[]=[],sources:Row[]=[];
      const collections:Record<string,keyof Dashboard>={health_note:'notes',measurement:'measurements',medication_report:'doses',preventive_task:'preventive_tasks',support_request:'support_requests',followup:'followups'};
      for(const [kind,collection] of Object.entries(collections)){
        const items=rows(state[collection]).filter(record=>!record.deleted_at&&!record.superseded_at).filter(record=>{
          if(['preventive_task','followup'].includes(kind))return true;
          if(kind==='medication_report'&&(!record.report_time||!text(record.report_state).startsWith('reported_')))return false;
          const timestamp=text(record.occurred_at||record.report_time||record.created_at||record.confirmed_at);return !!timestamp&&Number.isFinite(Date.parse(timestamp))&&day(timestamp,state.patient.timezone)>=start&&day(timestamp,state.patient.timezone)<=end;
        }).slice(0,100).map(record=>{sources.push({id:record.id,type:kind,version:record.version??1});return {text:concise(record,kind),source_id:record.id};});
        if(items.length)sections.push({title:`${kind.replaceAll('_',' ')}${['preventive_task','followup'].includes(kind)?' · current context':''}`,items});
      }
      const summary={id:id(),patient_id:state.patient.id,patient_name:state.patient.name,start_date:start,end_date:end,purpose,template_version:1,created_at:iso(),status:'draft',reviewed:false,reviewed_at:null,source_access_current:true,sections,sources,questions:questions.map(question=>({text:question,author_display_name:actor.displayName||email,authored_at:iso()})),omitted_source_ids:[]};
      state.summaries.unshift(summary);state.summaries=state.summaries.slice(0,50);await persistCare(db,context);return reply(summary,201);
    }
    const summaryRoute=/^app\/summaries\/([a-zA-Z0-9_-]{1,160})(?:\/(share|revoke|print))?$/.exec(action);
    if(summaryRoute){
      assertOwner(context);const summary=findRecord(context,summaryRoute[1],'summaries');summaryCurrent(context,summary);
      if(!summaryRoute[2]&&request.method==='PUT'){
        const data=await requestBody(request),sections=rows(data.sections),omitted=strings(data.omitted_source_ids),originalSources=rows(summary.sources),questions=strings(data.questions);
        requireCare(data.reviewed===true&&sections.length<=20&&questions.length<=10&&questions.every(question=>question.length<=500),422,'Review this summary and keep up to ten short questions.');
        requireCare(omitted.every(sourceId=>originalSources.some(source=>source.id===sourceId)),422,'Omit only sources in this summary.');
        for(const section of sections)for(const item of rows(section.items))requireCare(text(item.text).length>0&&text(item.text).length<=5000&&originalSources.some(source=>source.id===item.source_id)&&!omitted.includes(text(item.source_id)),422,'Each included statement needs an existing source.');
        const authored=questions.map(question=>({text:question,author_display_name:actor.displayName||email,authored_at:iso()}));
        Object.assign(summary,{sections:[...sections,...(authored.length?[{title:'Questions for discussion',kind:'authored_questions',items:authored}]:[])],sources:originalSources.filter(source=>!omitted.includes(text(source.id))),omitted_source_ids:omitted,questions:authored,reviewed:true,status:'reviewed',reviewed_at:iso(),url:null,share_active:false});
        const revoke=db.prepare('UPDATE care_summary_links SET revoked_at = ? WHERE owner_id = ? AND summary_id = ? AND EXISTS (SELECT 1 FROM care_workspaces WHERE owner_id = ? AND version = ?)').bind(Date.now(),ownerId,summary.id,ownerId,ownerVersion);await persistCare(db,context,[revoke]);return reply(summary);
      }
      if(summaryRoute[2]==='print'&&request.method==='GET'){requireCare(summary.status==='reviewed'&&summary.reviewed_at,409,'Save a current review before printing.');return reply(summary);}
      if(summaryRoute[2]==='share'&&request.method==='POST'){
        await requestBody(request);requireCare(summary.status==='reviewed'&&summary.reviewed_at,409,'Save a current review before sharing.');
        const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join(''),expires=Date.now()+3600000;
        summary.url=`/shared/summaries/${token}`;summary.expires_at=new Date(expires).toISOString();summary.shared_at=iso();summary.share_active=true;
        const insert=db.prepare('INSERT INTO care_summary_links (token_hash,owner_id,summary_id,expires_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM care_workspaces WHERE owner_id = ? AND version = ?)').bind(await hash(token),ownerId,summary.id,expires,ownerId,ownerVersion);await persistCare(db,context,[insert]);return reply({url:summary.url,expires_at:summary.expires_at,shared_at:summary.shared_at,share_active:true});
      }
      if(summaryRoute[2]==='revoke'&&request.method==='POST'){
        summary.url=null;summary.share_active=false;summary.expires_at=null;const revoke=db.prepare('UPDATE care_summary_links SET revoked_at = ? WHERE owner_id = ? AND summary_id = ? AND EXISTS (SELECT 1 FROM care_workspaces WHERE owner_id = ? AND version = ?)').bind(Date.now(),ownerId,summary.id,ownerId,ownerVersion);await persistCare(db,context,[revoke]);return reply({revoked:true});
      }
    }
    const revokePhone=/^app\/devices\/([a-zA-Z0-9_-]{1,160})\/revoke$/.exec(action);
    if(revokePhone&&request.method==='POST'){
      assertOwner(context);const result=await db.prepare("UPDATE voice_rooms SET state = 'revoked',updated_at = ? WHERE id = ? AND owner_id = ?").bind(Date.now(),revokePhone[1],ownerId).run();requireCare(result.meta.changes===1,404,'This phone connection is unavailable.');await db.prepare("UPDATE voice_recordings SET state='interrupted',error_code='phone_disconnected',updated_at=? WHERE room_id=? AND owner_id=? AND state='receiving'").bind(Date.now(),revokePhone[1],ownerId).run();return reply({disconnected:true});
    }
    if(action==='voice-interpretation'&&request.method==='POST'){
      assertOwner(context);const data=await requestBody(request);const result=await interpretRecording(db,currentContext,actor,bindings,text(data.recording_id),fetchImpl);return reply(result);
    }
    throw new CareError(404,'This care action was not found.');
  }catch(error){if(error instanceof CareError)return reply({detail:error.message},error.status);return reply({detail:'Care storage is temporarily unavailable. This change has not been confirmed.'},503);}
}

export type { Context as CareContext };

// Called only after the voice API verifies an approved ESP32 room and its cookie.
// The room is restricted to its owner's existing care space; no confirmation is
// dispatched here. The ordinary interpretation path persists proposals only.
export async function interpretRelayRecording(bindings:VoiceBindings,ownerId:string,recordingId:string,fetchImpl:typeof fetch=fetch){
  requireCare(bindings.DB,503,'Care storage is temporarily unavailable.');
  const db=bindings.DB,workspace=await db.prepare('SELECT * FROM care_workspaces WHERE owner_id = ?').bind(ownerId).first<Workspace>();
  requireCare(workspace&&allowedEmails(bindings).includes(normalize(workspace.owner_email)),403,'The care-space owner no longer has access.');
  const actor={userId:ownerId,email:workspace.owner_email},context=(await contexts(db,actor,bindings)).find(item=>item.isOwner)!;
  const active=async()=>{
    const room=await db.prepare("SELECT v.id FROM voice_rooms v JOIN voice_recordings r ON r.room_id = v.id WHERE r.id = ? AND v.owner_id = ? AND v.client_type = 'esp32' AND v.state = 'paired' AND v.expires_at > ?").bind(recordingId,ownerId,Date.now()).first();
    requireCare(room,403,'This ESP32 connection is no longer approved.');
  };
  await active();
  const result=await interpretRecording(db,context,actor,bindings,recordingId,fetchImpl,active);
  const recording=await db.prepare('SELECT transcript FROM voice_recordings WHERE id = ? AND owner_id = ?').bind(recordingId,ownerId).first<{transcript:string}>();
  return {transcript:recording?.transcript??'',spokenText:result.spoken_text,functionName:result.function_name,proposalId:result.proposal?.id??null,proposalStatus:result.proposal?.status??null};
}
