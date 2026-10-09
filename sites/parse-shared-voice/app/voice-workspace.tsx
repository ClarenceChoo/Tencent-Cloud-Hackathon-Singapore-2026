"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import QRCode from "qrcode";
import { Mic, Smartphone, Headphones, AudioLines, Link2, Check, Square, LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { LiveReceiver, errorText, voiceApi, type Recording, type Room, type VoiceStatus } from "./voice-client";

export default function VoiceWorkspace({signedIn, displayName, signInPath, phoneOrigin="",embedded=false,onInterpret,interpretationBusy}: {signedIn:boolean;displayName:string;signInPath:string;phoneOrigin?:string;embedded?:boolean;onInterpret?:(recordingId:string)=>Promise<void>;interpretationBusy?:string|null}) {
  const [pairing,setPairing]=useState(false),[rooms,setRooms]=useState<Room[]>([]),[records,setRecords]=useState<Recording[]>([]),[status,setStatus]=useState<VoiceStatus|null>(null);
  const [invitation,setInvitation]=useState<{room:Room;url:string;qr:string}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[listening,setListening]=useState(false);
  const listener=useRef<LiveReceiver|null>(null),refreshBusy=useRef(false);
  const activeRoom=rooms.find(room=>room.id===invitation?.room.id)??rooms.find(room=>room.state==="paired")??rooms[0];
  const refresh=useCallback(async()=>{
    if(!signedIn||refreshBusy.current||document.hidden)return;
    refreshBusy.current=true;
    try{
      const [connections,inbox,configuration]=await Promise.all([voiceApi<{rooms:Room[]}>("rooms"),voiceApi<{recordings:Recording[]}>("recordings"),voiceApi<VoiceStatus>("status")]);
      setRooms(connections.rooms.filter(room=>room.clientType!=="esp32"));setRecords(inbox.recordings);setStatus(configuration);
      if(listener.current){if(!connections.rooms.some(room=>room.state==="paired")){listener.current.stop();listener.current=null;setListening(false);}else await listener.current.receive(inbox.recordings);}
      setError("");return {rooms:connections.rooms,recordings:inbox.recordings,transcriptionConfigured:configuration.transcriptionConfigured};
    }catch(error){if(listener.current){listener.current.stop();listener.current=null;setListening(false);}setError(errorText(error));throw error;}
    finally{refreshBusy.current=false;}
  },[signedIn]);
  useEffect(()=>{
    if(!signedIn)return;
    const update=()=>{void refresh().catch(()=>{});};update();const timer=window.setInterval(update,1000);document.addEventListener("visibilitychange",update);
    return()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",update);listener.current?.stop();};
  },[signedIn,refresh]);
  useEffect(()=>{
    if(!signedIn)return;
    type Tool={name:string;title:string;description:string;inputSchema:object;annotations:object;execute:(input:unknown)=>Promise<unknown>};
    const context=(document as Document&{modelContext?:{registerTool:(tool:Tool,options:{signal:AbortSignal})=>void|Promise<void>}}).modelContext;
    if(!context?.registerTool)return;const lifetime=new AbortController();
    try{void Promise.resolve(context.registerTool({name:"read_voice_workspace",title:"Read shared voice workspace",description:"Refresh the visible phone connection and recordings in this signed-in private Parse workspace. Does not start the microphone or approve a phone.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},async execute(input){if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length)throw new Error("Use an empty object.");const result=await refresh();if(!result)throw new Error("Open the visible workspace and try again.");return result;}},{signal:lifetime.signal})).catch(()=>{});}catch{}
    return()=>lifetime.abort();
  },[signedIn,refresh]);
  async function createPairing(){
    setBusy(true);setError("");
    try{const result=await voiceApi<{room:Room;phonePath:string}>("rooms",{});const url=new URL(result.phonePath,phoneOrigin||window.location.origin).href;const qr=await QRCode.toDataURL(url,{width:280,margin:3,color:{dark:"#1b2944",light:"#ffffff"},errorCorrectionLevel:"M"});setInvitation({room:result.room,url,qr});await refresh();}
    catch(error){setError(errorText(error));}finally{setBusy(false);}
  }
  async function approve(){if(!activeRoom?.code)return;setBusy(true);try{await voiceApi(`rooms/${activeRoom.id}/approve`,{code:activeRoom.code});await refresh();setPairing(false);}catch(error){setError(errorText(error));}finally{setBusy(false);}}
  async function disconnect(){if(!activeRoom)return;setBusy(true);try{await voiceApi(`rooms/${activeRoom.id}/revoke`,{});listener.current?.stop();listener.current=null;setListening(false);setInvitation(null);await refresh();}catch(error){setError(errorText(error));}finally{setBusy(false);}}
  async function toggleListening(){
    if(listener.current){listener.current.stop();listener.current=null;setListening(false);return;}
    const receiver=new LiveReceiver();listener.current=receiver;
    try{await receiver.enable();setListening(true);await refresh();}catch(error){receiver.stop();listener.current=null;setListening(false);setError(errorText(error));}
  }
  const Container=embedded?"section":"main";
  return <Container className={`voice-shell ${embedded ? "voice-embedded" : ""}`}>
    {!embedded&&<header className="voice-header"><Link href="/" className="voice-brand" aria-label="Parse home"><Image unoptimized src="/brand/parse-aurora-logo-light.png" alt="Parse" width={158} height={54} /></Link><span className="voice-account">{displayName || "Your private workspace"}</span></header>}
    <div className="voice-content">
      <div className="voice-heading"><div><p className="voice-eyebrow">YOUR SHARED VOICE WORKSPACE</p>{embedded?<h2>From your phone, to here.</h2>:<h1>From your phone, to here.</h1>}<p>Speak on any phone. Listen here as your words arrive.</p></div>{signedIn?<Button className="voice-button" onClick={()=>setPairing(true)}><Smartphone size={18}/>Pair phone</Button>:<Button asChild className="voice-button"><a href={signInPath} target="_top">Sign in with ChatGPT</a></Button>}</div>
      {error&&<p className="voice-error" role="alert">{error}</p>}
      <div className="voice-grid">
        <section className="voice-panel voice-inbox"><div className="voice-panel-heading"><h2><AudioLines size={20}/>Voice inbox</h2><span className="voice-muted">{records.length} recording{records.length===1?"":"s"}</span></div>
          {signedIn&&<div className="voice-live-control"><div><strong>{listening?"Listening for your phone":"Listen while you speak"}</strong><p>Turn on your laptop’s sound before starting on the phone. Headphones help avoid feedback.</p></div><Button variant={listening?"secondary":"outline"} className="voice-secondary" disabled={!rooms.some(room=>room.state==="paired")} onClick={()=>void toggleListening()}>{listening?<Square size={16}/>:<Headphones size={17}/>} {listening?"Stop listening":"Listen live"}</Button></div>}
          {!records.length?<div className="voice-empty"><div className="voice-empty-icon"><Mic size={30}/></div><h3>Your next conversation starts on your phone.</h3><p>Scan the QR, approve your phone, then tap its microphone. Your recording appears here while you speak.</p><span className="voice-empty-caption">{signedIn?"Nothing has been recorded.":"Sign in to open your private voice inbox."}</span></div>:<div className="voice-records">{records.map(record=><article key={record.id} className="voice-record"><div className="voice-record-top"><span className={record.state==="receiving"?"voice-state voice-state-live":"voice-state"}>{record.state==="receiving"?<><span className="voice-live-dot"/>Receiving live</>:record.state==="processing"?<><LoaderCircle size={14}/>Finishing</>:record.state==="ready"?<><Check size={14}/>{record.clientType==="esp32"?"ESP32 recording received":"Recording received"}</>:"Recording interrupted"}</span><time dateTime={new Date(record.createdAt).toISOString()}>{new Date(record.createdAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})} · {record.duration.toFixed(1)}s</time></div>
            {record.audioUrl&&<audio controls preload="none" src={record.audioUrl} aria-label="Play microphone recording"/>}
            {record.transcript?<p className="voice-transcript">“{record.transcript}”</p>:record.state==="receiving"?<p className="voice-muted">Audio is arriving from your phone. {listening?"Your laptop plays each part as it arrives.":"Turn on Listen live to hear it."}</p>:record.state==="processing"?<p className="voice-muted">Saving the completed recording{status?.transcriptionConfigured?" and transcribing it":""}…</p>:record.state==="interrupted"?<p className="voice-muted">The phone stopped sending. Start a fresh recording to try again.</p>:<p className="voice-muted">{record.errorCode==="transcription_unavailable"?"Your audio is saved. Transcription was unavailable for this recording.":"Your audio is saved. Voice transcription has not been connected to this site yet."}</p>}
          {record.state==="ready"&&record.transcript&&onInterpret&&<Button className="voice-button" disabled={!!interpretationBusy} onClick={()=>void onInterpret(record.id)}><Sparkles size={16}/>{interpretationBusy===record.id?"Preparing update…":"Review care update"}</Button>}</article>)}</div>}
        </section>
        <aside className="voice-side"><section className="voice-panel"><div className="voice-panel-heading"><h2><Link2 size={19}/>Phone connection</h2></div><div className="voice-phone-symbol"><Smartphone size={42}/></div><h3>{activeRoom?.state==="paired"?"Your phone is connected":activeRoom?.state==="pending"?"Your phone is waiting for approval":"Pair your phone"}</h3><p>{activeRoom?.state==="paired"?"Open Safari or Chrome on your phone and tap Start recording. Keep both pages open for live listening.":"Scan the pairing QR with your phone Camera and open it in Safari or Chrome."}</p>
          {activeRoom?.state==="pending"&&<Button className="voice-button" onClick={()=>setPairing(true)}>Compare and approve</Button>}
          {activeRoom?.state==="paired"?<Button className="voice-secondary" variant="outline" disabled={busy} onClick={()=>void disconnect()}>Disconnect phone</Button>:<><div className="voice-step"><span>1</span>Open the QR link in your browser.</div><div className="voice-step"><span>2</span>No sign-in needed on the phone.</div><div className="voice-step"><span>3</span>Compare the code and approve.</div></>}
        </section><section className="voice-panel voice-note"><Mic size={21}/><div><h3>Ready when you are</h3><p>Tap Start recording on your phone. Each note can be up to 20 seconds.</p></div></section></aside>
      </div>
      <footer className="voice-footer"><Headphones size={17}/>Live audio while you speak · Transcript after Stop</footer>
    </div>
    <Dialog open={pairing} onOpenChange={setPairing}><DialogContent className="voice-dialog"><DialogHeader><DialogTitle>Pair your phone</DialogTitle><DialogDescription>Scan on any phone. Only the dashboard needs ChatGPT sign-in.</DialogDescription></DialogHeader>
      {activeRoom?.state==="paired"?<><p>Your phone is connected. Tap Start recording on your phone, and Listen live on your laptop.</p><Button className="voice-button" onClick={()=>setPairing(false)}>Done</Button></>:activeRoom?.state==="pending"?<><p>Check that this code matches the one on your phone.</p><div className="voice-code" aria-label={`Pairing code ${activeRoom.code}`}>{activeRoom.code}</div><Button className="voice-button" disabled={busy} onClick={()=>void approve()}>{busy?"Connecting…":"Codes match — connect phone"}</Button><Button variant="ghost" className="voice-secondary" disabled={busy} onClick={()=>void disconnect()}>Cancel pairing</Button></>:invitation&&activeRoom?.id===invitation.room.id?<div className="voice-qr"><Image unoptimized src={invitation.qr} alt="Scan to pair this private Parse workspace" width={280} height={280}/><p>Scan with your phone Camera, then open in Safari or Chrome.</p><a href={invitation.url} target="_blank" rel="noreferrer">Open pairing link</a><small>This QR expires in 10 minutes and can be used once. The phone does not need a ChatGPT account.</small></div>:<><p>Recording starts only when you tap the microphone on your phone.</p><Button className="voice-button" disabled={busy} onClick={()=>void createPairing()}>{busy?<><LoaderCircle size={17}/>Creating QR…</>:"Create pairing QR"}</Button></>}
      {error&&<p className="voice-error" role="alert">{error}</p>}
    </DialogContent></Dialog>
  </Container>;
}
