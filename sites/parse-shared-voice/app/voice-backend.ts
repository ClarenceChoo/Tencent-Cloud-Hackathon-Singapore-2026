import {relayControl, RelayControlError} from "./relay-control";
export type VoiceBindings = { DB?: D1Database; BUCKET?: R2Bucket; OPENAI_API_KEY?: string; PUBLIC_SITE_ORIGIN?: string; PUBLIC_PHONE_ORIGIN?: string; DASHBOARD_ALLOWED_EMAILS?: string };
type Room = { id:string;owner_id:string;client_type:string;invitation_hash:string;phone_hash:string|null;device_hash:string|null;approval_code:string|null;state:string;created_at:number;expires_at:number;updated_at:number };
type Recording = { id:string;room_id:string;owner_id:string;client_type:string;state:string;next_sequence:number;frames:number;created_at:number;updated_at:number;audio_key:string|null;reply_audio_key:string|null;transcript:string|null;error_code:string|null };
export type RelayResult = {transcript:string;spokenText:string;functionName:string;proposalId:string|null;proposalStatus:string|null;error?:string};
export type RelayInterpreter = (ownerId:string,recordingId:string)=>Promise<RelayResult>;
type Chunk = {recording_id:string;sequence:number;object_key:string;digest:string;frames:number;created_at:number};
const DAY = 86_400_000;
const WIFI_PAIRING_DAYS = 30;
const PHONE_COOKIE = "parse_voice_phone";
const ID = /^[a-f0-9-]{36}$/;
const TOKEN = /^[a-f0-9]{64}$/;

class VoiceError extends Error { constructor(readonly status:number,message:string){super(message);} }
function ensure(condition:unknown,status:number,message:string):asserts condition {if(!condition)throw new VoiceError(status,message);}
const json = (value:unknown,status=200) => Response.json(value,{status,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
const bytesHex = (bytes:Uint8Array) => Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
const newToken = () => bytesHex(crypto.getRandomValues(new Uint8Array(32)));
async function digest(value:string|Uint8Array){return bytesHex(new Uint8Array(await crypto.subtle.digest("SHA-256",typeof value==="string"?new TextEncoder().encode(value):new Uint8Array(value))));}
async function body(request:Request){ensure(Number(request.headers.get("Content-Length")||0)<=4096,413,"The request is too large.");const text=await request.text();ensure(text.length<=4096,413,"The request is too large.");try{return JSON.parse(text);}catch{throw new VoiceError(400,"Use a valid request.");}}
function cookie(request:Request){const value=request.headers.get("Cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(PHONE_COOKIE+"="))?.slice(PHONE_COOKIE.length+1);return value&&TOKEN.test(value)?value:null;}
function bearer(request:Request){const match=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization")??"");return match?.[1]??null;}
function visibleRoom(room:Room){return {id:room.id,state:room.state,clientType:room.client_type,code:room.approval_code,createdAt:room.created_at,expiresAt:room.expires_at,updatedAt:room.updated_at};}
function visibleRecording(row:Recording){return {id:row.id,roomId:row.room_id,clientType:row.client_type,state:row.state,chunks:row.next_sequence,duration:row.frames/16000,createdAt:row.created_at,updatedAt:row.updated_at,transcript:row.transcript,errorCode:row.error_code,audioUrl:row.audio_key?`/api/voice/recordings/${row.id}/audio`:null};}

function pcm(wav:Uint8Array,limit=32044):Uint8Array{
  ensure(wav.length>=46&&wav.length<=limit,400,"Use a short mono PCM WAV audio chunk.");
  const view=new DataView(wav.buffer,wav.byteOffset,wav.byteLength),tag=(at:number)=>String.fromCharCode(...wav.slice(at,at+4));
  ensure(tag(0)==="RIFF"&&tag(8)==="WAVE"&&tag(12)==="fmt "&&view.getUint32(16,true)===16&&view.getUint16(20,true)===1&&view.getUint16(22,true)===1&&view.getUint32(24,true)===16000&&view.getUint32(28,true)===32000&&view.getUint16(32,true)===2&&view.getUint16(34,true)===16&&tag(36)==="data"&&view.getUint32(40,true)===wav.length-44&&view.getUint32(4,true)===wav.length-8&&(wav.length-44)%2===0,400,"Use 16 kHz mono PCM WAV audio.");
  return wav.subarray(44);
}
async function readBounded(response:Response,limit:number){
  const reader=response.body?.getReader();ensure(reader,503,"The spoken reply was empty.");const parts:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;ensure(size<=limit,413,"The spoken reply is too long.");parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return bytes;
}
async function synthesizeDashboardReply(db:D1Database,bucket:R2Bucket,bindings:VoiceBindings,recording:Recording,spokenText:string){
  const input=spokenText.trim().slice(0,600);if(!input||!bindings.OPENAI_API_KEY)return;
  const claimed=await db.prepare("INSERT INTO voice_tts_jobs(recording_id,owner_id,state,updated_at) VALUES(?,?,'processing',?) ON CONFLICT(recording_id) DO NOTHING").bind(recording.id,recording.owner_id,Date.now()).run();
  if(claimed.meta.changes!==1)return;
  try{
    const response=await fetch("https://api.openai.com/v1/audio/speech",{method:"POST",headers:{Authorization:`Bearer ${bindings.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:"gpt-4o-mini-tts",voice:"alloy",input,response_format:"pcm",speed:1}),redirect:"manual",signal:AbortSignal.timeout(45_000)});
    ensure(response.ok,503,"Spoken playback is unavailable.");
    const pcmBytes=await readBounded(response,960000);ensure(pcmBytes.length>0&&pcmBytes.length%2===0,503,"Spoken playback returned invalid PCM audio.");
    const wav=wave(pcmBytes,24000);
    const key=`voice/${recording.id}/dashboard-reply.wav`;await bucket.put(key,wav,{httpMetadata:{contentType:"audio/wav"}});
    await db.prepare("UPDATE voice_recordings SET reply_audio_key=? WHERE id=? AND owner_id=? AND state='ready' AND reply_audio_key IS NULL").bind(key,recording.id,recording.owner_id).run();
    const current=await db.prepare("SELECT reply_audio_key FROM voice_recordings WHERE id=? AND owner_id=?").bind(recording.id,recording.owner_id).first<{reply_audio_key:string|null}>();
    ensure(current?.reply_audio_key===key,409,"The spoken reply was already saved.");
    await db.prepare("UPDATE voice_tts_jobs SET state='ready',updated_at=? WHERE recording_id=? AND owner_id=? AND state='processing'").bind(Date.now(),recording.id,recording.owner_id).run();
  }catch{
    await db.prepare("UPDATE voice_tts_jobs SET state='failed',error_code='speech_unavailable',updated_at=? WHERE recording_id=? AND owner_id=? AND state='processing'").bind(Date.now(),recording.id,recording.owner_id).run();
  }
}
export function wave(pcmBytes:Uint8Array,sampleRate=16000):Uint8Array<ArrayBuffer>{
  const result=new Uint8Array(44+pcmBytes.length),view=new DataView(result.buffer);
  for(const [at,tag] of [[0,"RIFF"],[8,"WAVE"],[12,"fmt "],[36,"data"]] as const)for(let i=0;i<tag.length;i++)result[at+i]=tag.charCodeAt(i);
  view.setUint32(4,result.length-8,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,pcmBytes.length,true);result.set(pcmBytes,44);return result;
}

export async function serveVoice(request:Request,userId:string|null,bindings:VoiceBindings,interpretRelay?:RelayInterpreter):Promise<Response>{
  try{
    const url=new URL(request.url),route=url.pathname.replace(/^\/api\/voice\/?/,""),phoneApi=route.startsWith("phone/"),deviceApi=route.startsWith("device/"),publicApi=phoneApi||deviceApi,path=phoneApi?route.slice(6):deviceApi?route.slice(7):route,now=Date.now();
    if(publicApi){
      const allowed=(request.method==="GET"&&/^rooms\/[a-f0-9-]{36}$/.test(path))||(request.method==="POST"&&(/^rooms\/[a-f0-9-]{36}\/(?:claim|relay)$/.test(path)||path==="recordings"||/^recordings\/[a-f0-9-]{36}\/(?:chunks\/[0-9]{1,2}|finish|discard|reply)$/.test(path)));
      const deviceAllowed=deviceApi&&((request.method==="GET"&&/^rooms\/[a-f0-9-]{36}$/.test(path))||(request.method==="POST"&&(/^rooms\/[a-f0-9-]{36}\/(?:claim|relay)$/.test(path)||path==="recordings"||/^recordings\/[a-f0-9-]{36}\/(?:chunks\/[0-9]{1,2}|finish|discard)$/.test(path))));
      ensure(deviceApi?deviceAllowed:allowed,404,deviceApi?"This device action was not found.":"This phone action was not found.");
    }else ensure(userId,401,"Sign in to an invited dashboard account.");
    ensure(bindings.DB&&bindings.BUCKET,503,"Shared voice storage is temporarily unavailable. Your microphone has not been started.");
    const db=bindings.DB,bucket=bindings.BUCKET;
    if(!deviceApi&&request.method!=="GET"&&request.method!=="HEAD"){
      const origin=bindings.PUBLIC_SITE_ORIGIN||url.origin;
      const requestOrigin=request.headers.get("Origin"),allowedOrigin=requestOrigin===origin||(phoneApi&&!!bindings.PUBLIC_PHONE_ORIGIN&&requestOrigin===bindings.PUBLIC_PHONE_ORIGIN);
      ensure(allowedOrigin&&request.headers.get("X-Parse-Voice")==="1",403,"Open the Parse site to make this change.");
    }
    async function room(id:string){ensure(ID.test(id),404,"Phone connection not found.");const row=await (publicApi?db.prepare("SELECT * FROM voice_rooms WHERE id = ?").bind(id):db.prepare("SELECT * FROM voice_rooms WHERE id = ? AND owner_id = ?").bind(id,userId)).first<Room>();ensure(row,404,"Phone connection not found.");ensure(row.state!=="revoked"&&row.expires_at>now,410,"This connection has expired. Pair the phone again.");return row;}
    async function phone(row:Room,requireApproval=true){const token=cookie(request);ensure((requireApproval?row.state==="paired":["pending","paired"].includes(row.state))&&token&&await digest(token)===row.phone_hash,403,"Scan the pairing QR and approve this phone on the laptop before recording.");}
    async function device(row:Room,allowPending=false){const credential=bearer(request);ensure(row.client_type==="esp32_wifi"&&credential&&row.device_hash&&await digest(credential)===row.device_hash,403,"This device is not paired to the connection.");ensure(row.state==="paired"||(allowPending&&row.state==="pending"),403,"Approve this device on the Parse dashboard before recording.");}
    async function recording(id:string){ensure(ID.test(id),404,"Recording not found.");const row=await (publicApi?db.prepare("SELECT * FROM voice_recordings WHERE id = ?").bind(id):db.prepare("SELECT * FROM voice_recordings WHERE id = ? AND owner_id = ?").bind(id,userId)).first<Recording>();ensure(row,404,"Recording not found.");if(phoneApi)await phone(await room(row.room_id));if(deviceApi)await device(await room(row.room_id));ensure(row.created_at+DAY>now,410,"This recording has expired.");return row;}
    const recordingView=(row:Recording)=>publicApi?{...visibleRecording(row),transcript:null,audioUrl:null}:visibleRecording(row);

    if(path==="status"&&request.method==="GET")return json({transcriptionConfigured:!!bindings.OPENAI_API_KEY,maxSeconds:20});
    if(path==="rooms"&&request.method==="GET"){
      const rows=await db.prepare("SELECT * FROM voice_rooms WHERE owner_id = ? AND state != 'revoked' AND expires_at > ? ORDER BY created_at DESC LIMIT 5").bind(userId,now).all<Room>();return json({rooms:rows.results.map(visibleRoom)});
    }
    if(path==="rooms"&&request.method==="POST"){
      const data=await body(request),clientType=data.clientType??"phone";
      ensure(clientType==="phone"||clientType==="esp32"||clientType==="esp32_wifi",400,"Choose a phone or ESP32 connection.");
      const count=await db.prepare("SELECT COUNT(*) AS count FROM voice_rooms WHERE owner_id = ? AND created_at > ?").bind(userId,now-DAY).first<{count:number}>();ensure((count?.count||0)<30,429,"The pairing limit has been reached for today.");
      const token=newToken(),id=crypto.randomUUID();
      await db.prepare("INSERT INTO voice_rooms (id,owner_id,invitation_hash,client_type,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,'waiting',?,?,?)").bind(id,userId,await digest(token),clientType,now,now+600_000,now).run();
      return json({room:{id,state:"waiting",clientType,code:null,createdAt:now,expiresAt:now+600_000,updatedAt:now},phonePath:`/phone?room=${id}#pair=${token}`},201);
    }
    const relayMatch=/^rooms\/([a-f0-9-]{36})\/(relay|capture)$/.exec(path);
    if(relayMatch){const connection=await room(relayMatch[1]);if(phoneApi)await phone(connection);if(deviceApi)await device(connection);return await relayControl(request,connection,db,publicApi,relayMatch[2],now);}
    const roomMatch=/^rooms\/([a-f0-9-]{36})(?:\/(claim|approve|revoke))?$/.exec(path);
    if(roomMatch){
      const row=await room(roomMatch[1]);
      if(!roomMatch[2]&&request.method==="GET"){
        if(phoneApi)await phone(row,false);
        if(deviceApi)await device(row,true);
        const view=json({room:visibleRoom(row),...(phoneApi?{thisPhone:!!cookie(request)&&await digest(cookie(request)!)===row.phone_hash}:{})});return view;
      }
      ensure(request.method==="POST",405,"Use the correct request method.");
      if(roomMatch[2]==="claim"){
        if(deviceApi){
          ensure(row.client_type==="esp32_wifi",409,"This connection is not configured for direct ESP32 Wi-Fi.");
          const credential=bearer(request),data=await body(request);ensure(credential&&TOKEN.test(data?.token||""),409,"This pairing request is invalid or expired.");
          const deviceHash=await digest(credential),inviteHash=await digest(data.token);
          if(row.state==="waiting"){
            ensure(inviteHash===row.invitation_hash&&!row.device_hash,409,"This pairing request is invalid or has already been claimed.");
            const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1_000_000).padStart(6,"0");
            let changed;
            try { changed=await db.prepare("UPDATE voice_rooms SET device_hash = ?, approval_code = ?, state = 'pending', updated_at = ? WHERE id = ? AND client_type = 'esp32_wifi' AND state = 'waiting' AND device_hash IS NULL AND invitation_hash = ?").bind(deviceHash,code,now,row.id,inviteHash).run(); }
            catch { return json({error:"This device credential is already bound to another connection."},409); }
            ensure(changed.meta.changes===1,409,"This pairing request has already been claimed.");
            const claimed=await room(row.id);return json({room:visibleRoom(claimed)},201);
          }
          ensure(["pending","paired"].includes(row.state)&&row.device_hash===deviceHash&&inviteHash===row.invitation_hash,409,"This device cannot replace the paired credential.");
          return json({room:visibleRoom(row)});
        }
        const data=await body(request);ensure(row.state==="waiting"&&TOKEN.test(data?.token||"")&&await digest(data.token)===row.invitation_hash,409,"This pairing QR is expired or has already been used.");
        const phoneToken=newToken(),code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1_000_000).padStart(6,"0");
        const changed=await db.prepare("UPDATE voice_rooms SET phone_hash = ?, approval_code = ?, state = 'pending', updated_at = ? WHERE id = ? AND state = 'waiting'").bind(await digest(phoneToken),code,now,row.id).run();ensure(changed.meta.changes===1,409,"This pairing QR has already been used.");
        const response=json({room:{...visibleRoom(row),state:"pending",code,updatedAt:now}},201);response.headers.set("Set-Cookie",`${PHONE_COOKIE}=${phoneToken}; HttpOnly; SameSite=Strict; Path=/api/voice; Max-Age=86400${url.protocol==="https:"?"; Secure":""}`);return response;
      }
      if(roomMatch[2]==="approve"){
        const data=await body(request);ensure(row.state==="pending"&&data?.code===row.approval_code,409,"Compare the code on the phone before approving it.");
        const lifetime=row.client_type==="esp32_wifi"?WIFI_PAIRING_DAYS*DAY:DAY;
        const changed=await db.prepare("UPDATE voice_rooms SET state = 'paired', approval_code = NULL, expires_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND state = 'pending'").bind(now+lifetime,now,row.id,userId).run();ensure(changed.meta.changes===1,409,"The phone connection changed. Refresh it before approving.");return json({room:{...visibleRoom(row),state:"paired",code:null,expiresAt:now+lifetime,updatedAt:now}});
      }
      if(roomMatch[2]==="revoke"){
        await db.batch([db.prepare("UPDATE voice_rooms SET state = 'revoked', updated_at = ? WHERE id = ? AND owner_id = ?").bind(now,row.id,userId),db.prepare("UPDATE voice_recordings SET state = 'interrupted', error_code = 'phone_disconnected', updated_at = ? WHERE room_id = ? AND state = 'receiving'").bind(now,row.id)]);return json({disconnected:true});
      }
    }
    if(path==="recordings"&&request.method==="GET"){
      const rows=await db.prepare("SELECT * FROM voice_recordings WHERE owner_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20").bind(userId,now-DAY).all<Recording>();return json({recordings:rows.results.map(visibleRecording)});
    }
    if(path==="recordings"&&request.method==="POST"){
      const data=await body(request),row=await room(data?.roomId||"");if(phoneApi||!deviceApi)await phone(row);if(deviceApi)await device(row);
      const id=data.recordingId??crypto.randomUUID();ensure(ID.test(id),400,"Use a valid recording ID.");
      if(data.recordingId){
        ensure(row.client_type==="esp32"||row.client_type==="esp32_wifi",400,"Recording retries are available on the ESP32 relay.");
        const previous=await db.prepare("SELECT * FROM voice_recordings WHERE id = ?").bind(id).first<Recording>();
        if(previous){ensure(previous.room_id===row.id&&previous.owner_id===row.owner_id,409,"This recording ID is already in use.");return json({recording:recordingView(previous),reused:true},201);}
      }
      const ongoing=await db.prepare("SELECT id FROM voice_recordings WHERE room_id = ? AND state IN ('receiving','processing') AND updated_at > ? LIMIT 1").bind(row.id,now-120_000).first();ensure(!ongoing,409,"Finish the current recording before starting another.");
      const count=await db.prepare("SELECT COUNT(*) AS count FROM voice_recordings WHERE owner_id = ? AND created_at > ?").bind(row.owner_id,now-DAY).first<{count:number}>();ensure((count?.count||0)<100,429,"The recording limit has been reached for today.");
      const inserted=await db.prepare("INSERT INTO voice_recordings (id,room_id,owner_id,client_type,state,next_sequence,frames,created_at,updated_at) SELECT ?,?,?,?,'receiving',0,0,?,? WHERE NOT EXISTS (SELECT 1 FROM voice_recordings WHERE room_id = ? AND state IN ('receiving','processing') AND updated_at > ?)").bind(id,row.id,row.owner_id,row.client_type,now,now,row.id,now-120_000).run();ensure(inserted.meta.changes===1,409,"Finish the current recording before starting another.");return json({recording:{id,roomId:row.id,clientType:row.client_type,state:"receiving",chunks:0,duration:0,createdAt:now,updatedAt:now,transcript:null,errorCode:null,audioUrl:null}},201);
    }
    const recMatch=/^recordings\/([a-f0-9-]{36})(?:\/(chunks|finish|audio|discard|reply)(?:\/([0-9]{1,2}))?)?$/.exec(path);
    if(recMatch){
      const row=await recording(recMatch[1]);
      if(!recMatch[2]&&request.method==="GET")return json({recording:recordingView(row)});
      if(recMatch[2]==="chunks"&&request.method==="GET"){
        const after=Number(url.searchParams.get("after")??-1);ensure(Number.isInteger(after)&&after>=-1&&after<=20,400,"Use a valid audio position.");
        const chunks=await db.prepare("SELECT sequence,frames FROM voice_chunks WHERE recording_id = ? AND sequence > ? ORDER BY sequence LIMIT 20").bind(row.id,after).all<{sequence:number;frames:number}>();return json({state:row.state,chunks:chunks.results.map(chunk=>({sequence:chunk.sequence,duration:chunk.frames/16000,url:`/api/voice/recordings/${row.id}/audio/${chunk.sequence}`}))});
      }
      if(recMatch[2]==="reply"&&(request.method==="GET"||request.method==="HEAD")){
        ensure(row.reply_audio_key,404,"The spoken reply is not available yet.");const object=await bucket.get(row.reply_audio_key);ensure(object,410,"This spoken reply is no longer available.");
        return new Response(request.method==="HEAD"?null:object.body,{headers:{"Content-Type":"audio/wav","Content-Length":String(object.size),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
      }
      if(recMatch[2]==="audio"&&(request.method==="GET"||request.method==="HEAD")){
        let key=row.audio_key;
        if(recMatch[3]!==undefined){const chunk=await db.prepare("SELECT object_key FROM voice_chunks WHERE recording_id = ? AND sequence = ?").bind(row.id,Number(recMatch[3])).first<{object_key:string}>();key=chunk?.object_key??null;}
        ensure(key,404,"This audio has not arrived yet.");const object=await bucket.get(key);ensure(object,410,"This audio is no longer available.");
        return new Response(request.method==="HEAD"?null:object.body,{headers:{"Content-Type":"audio/wav","Content-Length":String(object.size),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Disposition":`inline; filename="parse-${row.id}.wav"`}});
      }
      ensure(request.method==="POST",405,"Use the correct request method.");const connection=await room(row.room_id);
      if(recMatch[2]==="chunks"&&recMatch[3]!==undefined||recMatch[2]==="finish"||recMatch[2]==="discard"){
        if(deviceApi)await device(connection);else await phone(connection);
      }else if(phoneApi)await phone(connection);else if(deviceApi)await device(connection);
      if(recMatch[2]==="reply"){
        ensure(connection.client_type==="esp32"&&row.state==="ready"&&row.transcript,409,"Finish this ESP32 recording before sending its reply.");
        const job=await db.prepare("SELECT state FROM care_voice_jobs WHERE recording_id=? AND owner_id=?").bind(row.id,row.owner_id).first<{state:string}>();ensure(job?.state==="ready",409,"Prepare the Parse response first.");
        ensure(request.headers.get("Content-Type")==="audio/wav"&&Number(request.headers.get("Content-Length")||0)<=640044,413,"Use a spoken reply of at most 20 seconds.");
        const reader=request.body?.getReader();ensure(reader,400,"Audio is missing.");const parts:Uint8Array[]=[];let size=0;
        try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;ensure(size<=640044,413,"The spoken reply is too long.");parts.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
        const wav=new Uint8Array(size);let offset=0;for(const part of parts){wav.set(part,offset);offset+=part.length;}pcm(wav,640044);
        const hash=await digest(wav),key=`voice/${row.id}/reply-${hash}.wav`;
        if(row.reply_audio_key){ensure(row.reply_audio_key===key,409,"A spoken reply is already saved for this recording.");return json({accepted:true,reused:true});}
        await bucket.put(key,wav,{httpMetadata:{contentType:"audio/wav"}});await phone(await room(connection.id));
        await db.prepare("UPDATE voice_recordings SET reply_audio_key=? WHERE id=? AND owner_id=? AND reply_audio_key IS NULL").bind(key,row.id,row.owner_id).run();
        const saved=await recording(row.id);ensure(saved.reply_audio_key===key,409,"A spoken reply is already saved for this recording.");return json({accepted:true});
      }
      if(recMatch[2]==="chunks"&&recMatch[3]!==undefined){
        const sequence=Number(recMatch[3]);ensure(sequence<20,400,"Recordings are limited to 20 seconds.");ensure(request.headers.get("Content-Type")==="audio/wav"&&Number(request.headers.get("Content-Length")||0)<=32044,400,"Use a short WAV audio chunk.");
        const reader=request.body?.getReader();ensure(reader,400,"Audio is missing.");const parts:Uint8Array[]=[],limit=32044;let size=0;
        try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;ensure(size<=limit,413,"The audio chunk is too large.");parts.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
        const wav=new Uint8Array(size);let offset=0;for(const part of parts){wav.set(part,offset);offset+=part.length;}const audio=pcm(wav),hash=await digest(wav);
        const existing=await db.prepare("SELECT digest FROM voice_chunks WHERE recording_id = ? AND sequence = ?").bind(row.id,sequence).first<{digest:string}>();
        if(existing){ensure(existing.digest===hash,409,"That audio position already contains a different recording.");return json({accepted:true,sequence,reused:true});}
        ensure(row.state==="receiving"&&row.next_sequence===sequence&&row.frames+audio.length/2<=320000&&row.created_at+120_000>now,409,"Audio arrived out of order or this recording has ended.");
        const key=`voice/${row.id}/${sequence}-${hash}.wav`;await bucket.put(key,wav,{httpMetadata:{contentType:"audio/wav"}});
        await db.batch([db.prepare("INSERT INTO voice_chunks (recording_id,sequence,object_key,digest,frames,created_at) SELECT ?,?,?,?,?,? FROM voice_recordings WHERE id = ? AND next_sequence = ? AND state = 'receiving' ON CONFLICT (recording_id,sequence) DO NOTHING").bind(row.id,sequence,key,hash,audio.length/2,now,row.id,sequence),db.prepare("UPDATE voice_recordings SET next_sequence = next_sequence + 1, frames = frames + ?, updated_at = ? WHERE id = ? AND state = 'receiving' AND next_sequence = ? AND EXISTS (SELECT 1 FROM voice_chunks WHERE recording_id = ? AND sequence = ? AND digest = ?)").bind(audio.length/2,now,row.id,sequence,row.id,sequence,hash)]);
        const accepted=await db.prepare("SELECT digest FROM voice_chunks WHERE recording_id = ? AND sequence = ?").bind(row.id,sequence).first<{digest:string}>();ensure(accepted?.digest===hash,409,"The audio position changed. Retry the same audio.");return json({accepted:true,sequence,reused:false});
      }
      if(recMatch[2]==="discard"){
        ensure(row.state==="receiving",409,"This recording has already ended.");await db.prepare("UPDATE voice_recordings SET state = 'interrupted',error_code = 'recording_stopped',updated_at = ? WHERE id = ? AND state = 'receiving'").bind(now,row.id).run();return json({stopped:true});
      }
      if(recMatch[2]==="finish"){
        const data=await body(request);ensure(Number.isInteger(data?.chunks)&&data.chunks===row.next_sequence,409,"Wait for all audio to arrive before finishing.");
        const finishResponse=async(finished:Recording,reused=false)=>{
          let relay:RelayResult|undefined;
          if(connection.client_type==="esp32"||connection.client_type==="esp32_wifi"){
            relay={transcript:finished.transcript??"",spokenText:"",functionName:"",proposalId:null,proposalStatus:null};
            try{
              ensure(finished.transcript&&interpretRelay,503,"The recording arrived. Review it on the Parse dashboard to continue.");
              relay=await interpretRelay(connection.owner_id,finished.id);
            }catch{relay={...relay,error:"The recording arrived. Open Parse to review or retry its care update."};}
            if(connection.client_type==="esp32_wifi"&&!relay.error&&relay.spokenText)await synthesizeDashboardReply(db,bucket,bindings,finished,relay.spokenText);
            // Approval can be revoked while the provider is working.
            if(phoneApi)await phone(await room(connection.id));if(deviceApi)await device(await room(connection.id));
          }
          return json({recording:recordingView(finished),transcriptionConfigured:!!bindings.OPENAI_API_KEY,reused,...(relay?{relay}:{})});
        };
        if(row.state==="ready")return await finishResponse(row,true);
        ensure(row.state==="receiving"&&row.frames>=4800&&row.frames<=320000,409,"Record between 0.3 and 20 seconds before finishing.");
        const changed=await db.prepare("UPDATE voice_recordings SET state = 'processing',updated_at = ? WHERE id = ? AND state = 'receiving'").bind(now,row.id).run();ensure(changed.meta.changes===1,409,"This recording is already finishing.");
        try{
          const chunks=await db.prepare("SELECT * FROM voice_chunks WHERE recording_id = ? ORDER BY sequence").bind(row.id).all<Chunk>();ensure(chunks.results.length===row.next_sequence,409,"Some audio is still missing.");
          const full=new Uint8Array(row.frames*2);let at=0;
          for(const chunk of chunks.results){const object=await bucket.get(chunk.object_key);ensure(object,503,"Some audio is temporarily unavailable. Try again later.");const part=pcm(new Uint8Array(await object.arrayBuffer()));full.set(part,at);at+=part.length;}
          ensure(at===full.length,409,"The recording length changed.");const wav=wave(full),key=`voice/${row.id}/complete.wav`;await bucket.put(key,wav,{httpMetadata:{contentType:"audio/wav"}});
          let transcript:string|null=null,errorCode:string|null=null;
          if(bindings.OPENAI_API_KEY){
            try{
              const form=new FormData();form.append("model","gpt-4o-mini-transcribe");form.append("response_format","json");form.append("file",new Blob([wav],{type:"audio/wav"}),"voice-note.wav");
              const response=await fetch("https://api.openai.com/v1/audio/transcriptions",{method:"POST",headers:{Authorization:`Bearer ${bindings.OPENAI_API_KEY}`},body:form,redirect:"manual",signal:AbortSignal.timeout(45_000)});
              ensure(response.ok,503,"Voice transcription is unavailable.");const value=await response.json() as {text?:unknown};ensure(typeof value.text==="string"&&value.text.trim().length>0&&value.text.length<=10000,503,"No clear speech was recognised.");transcript=value.text.trim();
            }catch{errorCode="transcription_unavailable";}
          }
          await db.prepare("UPDATE voice_recordings SET state = 'ready',audio_key = ?,transcript = ?,error_code = ?,updated_at = ? WHERE id = ? AND state = 'processing'").bind(key,transcript,errorCode,Date.now(),row.id).run();
          const finished=await recording(row.id);return await finishResponse(finished);
        }catch(error){await db.prepare("UPDATE voice_recordings SET state = 'interrupted',error_code = 'finish_unavailable',updated_at = ? WHERE id = ? AND state = 'processing'").bind(Date.now(),row.id).run();throw error;}
      }
    }
    throw new VoiceError(404,"This voice action was not found.");
  }catch(error){if(error instanceof VoiceError||error instanceof RelayControlError)return json({error:error.message},error.status);return json({error:"Shared voice is temporarily unavailable. Your recording has not been confirmed."},503);}
}
