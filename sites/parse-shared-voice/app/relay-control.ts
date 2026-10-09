import {currentRecordingResult, type InterpretationResult} from './care/care-interpretation';
import type {CareProposal} from './care/care-state';

type RelayRoom = {id:string;owner_id:string;client_type:string;state:string};
type Command = {id:string;room_id:string;kind:string;state:string;claim_id:string|null;created_at:number;expires_at:number;updated_at:number};
export class RelayControlError extends Error {constructor(readonly status:number,message:string){super(message);}}
function check(ok:unknown,status:number,message:string):asserts ok {if(!ok)throw new RelayControlError(status,message);}
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const visible=(row:Command|null)=>row?{id:row.id,kind:row.kind,state:row.state,createdAt:row.created_at,expiresAt:row.expires_at}:null;
const phases=['idle','connecting','countdown','recording','transfer','uploading','interpreting','speech','complete','error'];
function safeStatus(input:Record<string,unknown>){
  const result:Record<string,unknown>={busy:input.busy===true,hardwareReady:input.hardwareReady===true,canRetry:input.canRetry===true};
  result.phase=phases.includes(String(input.phase))?input.phase:'idle';
  for(const key of ['message','error','transport'])if(typeof input[key]==='string')result[key]=input[key].slice(0,240);
  for(const key of ['transferPercent','recordingStarted'])if(typeof input[key]==='number'&&Number.isFinite(input[key]))result[key]=Math.max(0,input[key]);
  return result;
}

// The dashboard queues a short-lived request. Only the cookie-authenticated
// laptop may claim it; claiming never happens as a side effect of a status read.
export async function relayControl(request:Request,row:RelayRoom,db:D1Database,phoneApi:boolean,action:string,now:number){
  check(row.client_type==='esp32'&&row.state==='paired',409,'Approve an ESP32 connection first.');
  await db.prepare("UPDATE voice_relay_commands SET state='expired',updated_at=? WHERE room_id=? AND state IN ('queued','claimed') AND expires_at<=?").bind(now,row.id,now).run();
  async function active(){return db.prepare("SELECT * FROM voice_relay_commands WHERE room_id=? AND state IN ('queued','claimed') ORDER BY created_at DESC LIMIT 1").bind(row.id).first<Command>();}
  async function status(){const value=await db.prepare('SELECT last_seen,status_json FROM voice_relay_status WHERE room_id=?').bind(row.id).first<{last_seen:number;status_json:string}>();return {lastSeen:value?.last_seen??null,online:!!value&&now-value.last_seen<15000,status:value?JSON.parse(value.status_json):{busy:false,hardwareReady:false,canRetry:false,phase:'idle'}};}
  if(!phoneApi&&action==='relay'&&request.method==='GET'){
    const latest=await db.prepare("SELECT r.*,j.result_json FROM voice_recordings r LEFT JOIN care_voice_jobs j ON j.recording_id=r.id AND j.owner_id=r.owner_id AND j.state='ready' WHERE r.room_id=? AND r.owner_id=? AND r.created_at>? ORDER BY r.created_at DESC LIMIT 1").bind(row.id,row.owner_id,now-86400000).first<{id:string;state:string;created_at:number;transcript:string|null;audio_key:string|null;reply_audio_key:string|null;result_json:string|null}>();
    let result:InterpretationResult|null=latest?.result_json?JSON.parse(latest.result_json):null;
    if(result?.proposal&&latest){
      const workspace=await db.prepare("SELECT json_extract(state_json,'$.proposals') AS proposals FROM care_workspaces WHERE owner_id=?").bind(row.owner_id).first<{proposals:string}>();
      result=currentRecordingResult(result,workspace?JSON.parse(workspace.proposals) as CareProposal[]:[],latest.id);
    }
    return json({...await status(),command:visible(await active()),latest:latest?{id:latest.id,state:latest.state,createdAt:latest.created_at,transcript:latest.transcript,audioUrl:latest.audio_key?`/api/voice/recordings/${latest.id}/audio`:null,replyAudioUrl:latest.reply_audio_key?`/api/voice/recordings/${latest.id}/reply`:null,reply:result?{spokenText:result.spoken_text,functionName:result.function_name,intent:result.intent??null,proposalKind:result.proposal?.kind??null,proposalStatus:result.proposal?.status??null,hasProposal:!!result.proposal}:null}:null});
  }
  check(request.method==='POST',405,'Use the correct request method.');
  check(Number(request.headers.get('Content-Length')||0)<=4096,413,'The request is too large.');
  const text=await request.text();check(text.length<=4096,413,'The request is too large.');
  let data:Record<string,unknown>;try{data=JSON.parse(text);}catch{throw new RelayControlError(400,'Use a valid relay request.');}
  check(data&&typeof data==='object'&&!Array.isArray(data),400,'Use a valid relay request.');
  if(!phoneApi&&action==='capture'){
    const id=String(data.commandId??''),kind=data.kind??'capture';check(ID.test(id)&&(kind==='capture'||kind==='retry'),400,'Use a valid recording request.');
    const previous=await db.prepare('SELECT * FROM voice_relay_commands WHERE id=?').bind(id).first<Command>();
    if(previous){check(previous.room_id===row.id&&previous.kind===kind,409,'This recording request is already in use.');return json({command:visible(previous),reused:true});}
    const current=await status();check(current.online,409,'The laptop relay is offline. Start it on the laptop, then try again.');
    check(!current.status.busy,409,'Wait for the current recording to finish.');
    check(kind==='retry'?current.status.canRetry:current.status.hardwareReady,409,kind==='retry'?'There is no unfinished clip to send.':'Reconnect the configured ESP32 to the laptop.');
    const count=await db.prepare('SELECT COUNT(*) AS count FROM voice_relay_commands WHERE room_id=? AND created_at>?').bind(row.id,now-86400000).first<{count:number}>();check((count?.count??0)<200,429,'The recording request limit has been reached for today.');
    const insert=await db.prepare("INSERT INTO voice_relay_commands(id,room_id,kind,state,created_at,expires_at,updated_at) SELECT ?,?,?,'queued',?,?,? WHERE NOT EXISTS(SELECT 1 FROM voice_relay_commands WHERE room_id=? AND state IN ('queued','claimed'))").bind(id,row.id,kind,now,now+20000,now,row.id).run();
    check(insert.meta.changes===1,409,'A recording request is already in progress.');
    return json({command:visible(await active())},202);
  }
  check(phoneApi&&action==='relay',404,'This relay action was not found.');
  if(data.status&&typeof data.status==='object'&&!Array.isArray(data.status))await db.prepare('INSERT INTO voice_relay_status(room_id,last_seen,status_json) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET last_seen=excluded.last_seen,status_json=excluded.status_json').bind(row.id,now,JSON.stringify(safeStatus(data.status as Record<string,unknown>))).run();
  if(data.action==='claim'||data.action==='complete'||data.action==='failed'){
    check(ID.test(String(data.commandId))&&ID.test(String(data.claimId)),400,'Use a valid relay receipt.');
    if(data.action==='claim')await db.prepare("UPDATE voice_relay_commands SET state='claimed',claim_id=?,expires_at=?,updated_at=? WHERE id=? AND room_id=? AND state='queued' AND expires_at>?").bind(data.claimId,now+600000,now,data.commandId,row.id,now).run();
    const command=await db.prepare('SELECT * FROM voice_relay_commands WHERE id=? AND room_id=?').bind(data.commandId,row.id).first<Command>();
    check(command&&command.claim_id===data.claimId,409,'This request has already been claimed or expired.');
    if(data.action==='claim'){check(command.state==='claimed'&&command.expires_at>now,409,'This request has already ended.');return json({command:visible(command),claimed:true});}
    check(command.state==='claimed'||command.state===data.action,409,'This request has already ended.');
    await db.prepare("UPDATE voice_relay_commands SET state=?,updated_at=? WHERE id=? AND room_id=? AND claim_id=? AND state='claimed'").bind(data.action,now,command.id,row.id,data.claimId).run();
    return json({accepted:true});
  }
  check(data.action===undefined||data.action==='poll',400,'Use a supported relay action.');
  return json({command:visible(await active())});
}
