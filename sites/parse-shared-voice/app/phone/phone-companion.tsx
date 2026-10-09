"use client";
import {useEffect,useRef,useState} from "react";
import Link from "next/link";
import Image from "next/image";
import {Mic,Square,Check,LoaderCircle,Laptop} from "lucide-react";
import {Button} from "@/components/ui/button";
import {PhoneRecorder,ApiError,errorText,voiceApi,uploadChunk,wavBlob,type Room,type Recording} from "../voice-client";
type Session={recorder:PhoneRecorder;id:string;sequence:number;tail:Promise<void>;error:unknown;stopping:boolean};

export default function PhoneCompanion({roomId}:{roomId:string}){
  const [token,setToken]=useState(""),[room,setRoom]=useState<Room|null>(null),[thisPhone,setThisPhone]=useState(false),[error,setError]=useState(""),[roomLoading,setRoomLoading]=useState(!!roomId);
  const [busy,setBusy]=useState(false),[state,setState]=useState<"idle"|"recording"|"sending"|"ready">("idle"),[seconds,setSeconds]=useState(0),[level,setLevel]=useState(0);
  const session=useRef<Session|null>(null),opening=useRef<PhoneRecorder|null>(null),alive=useRef(true);
  useEffect(()=>{
    let disposed=false;
    queueMicrotask(()=>{if(disposed)return;
    const pair=new URLSearchParams(window.location.hash.slice(1)).get("pair")??"";
    if(/^[a-f0-9]{64}$/.test(pair))setToken(pair);window.history.replaceState(null,"",window.location.pathname+window.location.search);
    });return()=>{disposed=true;};
  },[roomId]);
  useEffect(()=>{
    alive.current=true;if(!roomId)return;
    let fetching=false;
    const refresh=async()=>{if(fetching||document.hidden)return;fetching=true;try{const value=await voiceApi<{room:Room;thisPhone:boolean}>(`phone/rooms/${roomId}`);if(!alive.current)return;setRoom(value.room);setThisPhone(value.thisPhone);setRoomLoading(false);if(value.room.state!=="paired"&&session.current)void interrupt("Your phone was disconnected. Pair it again to record.");}
      catch(error){if(alive.current){setRoomLoading(false);setError(error instanceof ApiError&&error.status===403&&!session.current?"":errorText(error));if(error instanceof ApiError&&[403,404,410].includes(error.status)){setRoom(null);setThisPhone(false);void interrupt(errorText(error));}}}finally{fetching=false;}};
    void refresh();const timer=window.setInterval(()=>void refresh(),1000);
    const hide=()=>{if(document.hidden){opening.current?.abort();void interrupt("Recording stopped when you left this page. Keep your browser open while recording.");}else void refresh();};document.addEventListener("visibilitychange",hide);
    return()=>{alive.current=false;window.clearInterval(timer);document.removeEventListener("visibilitychange",hide);opening.current?.abort();const current=session.current;session.current=null;current?.recorder.abort();if(current)void voiceApi(`phone/recordings/${current.id}/discard`,{}).catch(()=>{});};
  },[roomId]);
  async function claim(){setBusy(true);setError("");try{const value=await voiceApi<{room:Room}>(`phone/rooms/${roomId}/claim`,{token});setRoom(value.room);setThisPhone(true);setToken("");}catch(error){setError(errorText(error));}finally{setBusy(false);}}
  async function interrupt(message:string){
    const current=session.current;if(!current||current.stopping)return;current.stopping=true;session.current=null;await current.recorder.stop();await current.tail;void voiceApi(`phone/recordings/${current.id}/discard`,{}).catch(()=>{});if(alive.current){setState("idle");setBusy(false);setError(message);setLevel(0);}
  }
  async function finish(){
    const current=session.current;if(!current||current.stopping)return;current.stopping=true;setState("sending");setBusy(true);setLevel(0);
    try{await current.recorder.stop();await current.tail;if(current.error)throw current.error;await voiceApi<{recording:Recording}>(`phone/recordings/${current.id}/finish`,{chunks:current.sequence});if(alive.current){setState("ready");setError("");}}
    catch(error){void voiceApi(`phone/recordings/${current.id}/discard`,{}).catch(()=>{});if(alive.current){setState("idle");setError(errorText(error));}}
    finally{if(session.current===current)session.current=null;if(alive.current)setBusy(false);}
  }
  async function start(){
    if(busy||session.current)return;setBusy(true);setError("");setSeconds(0);
    let recorder:PhoneRecorder|null=null;
    try{
      recorder=await PhoneRecorder.open();opening.current=recorder;if(!alive.current||document.hidden){recorder.abort();return;}
      const result=await voiceApi<{recording:Recording}>("phone/recordings",{roomId});if(!alive.current||document.hidden){recorder.abort();void voiceApi(`phone/recordings/${result.recording.id}/discard`,{}).catch(()=>{});return;}
      const current:Session={recorder,id:result.recording.id,sequence:0,tail:Promise.resolve(),error:null,stopping:false};session.current=current;opening.current=null;
      recorder.start(samples=>{const sequence=current.sequence++;current.tail=current.tail.then(async()=>{if(current.error)return;await uploadChunk(current.id,sequence,wavBlob(samples));}).catch(error=>{current.error=error;if(!current.stopping)void interrupt(errorText(error));});},(seconds,level)=>{setSeconds(seconds);setLevel(level);},()=>void finish(),()=>void interrupt("The microphone stopped. Start a fresh recording to try again."));
      setState("recording");setBusy(false);
    }catch(error){recorder?.abort();opening.current=null;if(alive.current){setBusy(false);setState("idle");setError(error instanceof DOMException&&error.name==="NotAllowedError"?"Allow microphone access in your browser, then tap Start recording again.":error instanceof ApiError?error.message:"The microphone could not start. Open this page in Safari on iPhone or Chrome on Android and allow microphone access.");}}
  }
  const connected=room?.state==="paired"&&thisPhone;
  return <main className="voice-shell voice-phone-shell"><header className="voice-header"><Link className="voice-brand" href="/" aria-label="Parse home"><Image unoptimized src="/brand/parse-aurora-logo-light.png" alt="Parse" width={158} height={54}/></Link></header>
    <div className="voice-phone-content"><p className="voice-eyebrow">YOUR PHONE COMPANION</p><h1>A little clarity,<br/>one voice note away.</h1><p className="voice-phone-intro">Speak here. Your laptop receives the audio while you speak.</p>
      <section className="voice-panel voice-phone-card">
        {!roomId?<><Laptop size={30}/><h2>Scan your team’s QR</h2><p>Ask an invited teammate to open the dashboard on their laptop and choose Pair phone. Scan its QR with your Camera. No ChatGPT account is needed on this phone.</p></>:roomLoading?<><LoaderCircle size={30}/><h2>Checking your connection…</h2></>:connected?<>
          <div className="voice-state"><Check size={16}/>Connected to the dashboard</div>
          <div className={state==="recording"?"voice-mic voice-mic-active":"voice-mic"} style={{"--mic-level":Math.min(level*5,1)} as React.CSSProperties}>{state==="sending"?<LoaderCircle size={40}/>:state==="ready"?<Check size={40}/>:<Mic size={40}/>}</div>
          <h2>{state==="recording"?"We’re listening.":state==="sending"?"Finishing your note…":state==="ready"?"Your note has arrived.":"Ready when you are."}</h2>
          <p>{state==="recording"?`${seconds.toFixed(1)} / 20 seconds · Sending live`:state==="sending"?"Your microphone is off. Waiting for the last audio to arrive.":state==="ready"?"The recording and transcript are available on the paired dashboard.":"Ask the laptop to turn on Listen live, then tap below. Keep this page open."}</p>
          {state==="idle"||state==="ready"?<><Button className="voice-button voice-record-button" disabled={busy} onClick={()=>void start()}><Mic size={20}/>{busy?"Opening microphone…":state==="ready"?"Record another note":"Start recording"}</Button></>:state==="recording"?<Button className="voice-button voice-record-button" onClick={()=>void finish()}><Square size={20}/>Stop recording</Button>:<Button disabled className="voice-button voice-record-button">Finishing…</Button>}
        </>:room?.state==="pending"&&thisPhone?<><Laptop size={30}/><h2>One quick check.</h2><p>Compare this code with the paired laptop, then ask your teammate to choose Codes match — connect phone on the laptop.</p><div className="voice-code">{room.code}</div><p className="voice-muted">Waiting for the laptop’s approval…</p></>:token&&!thisPhone?<><Laptop size={30}/><h2>Connect to the dashboard</h2><p>Your microphone stays off until the laptop approves this phone and you tap Start recording.</p><Button className="voice-button" disabled={busy} onClick={()=>void claim()}>{busy?"Connecting…":"Connect this phone"}</Button></>:<><Laptop size={30}/><h2>Scan your team’s QR</h2><p>Open Pair phone on an invited teammate’s laptop and scan the QR. A used or expired link needs a fresh QR.</p></>}
        {error&&<p className="voice-error" role="alert">{error}</p>}
      </section><p className="voice-phone-footnote"><Mic size={16}/>20-second notes · Live audio · Transcript after Stop</p>
    </div>
  </main>;
}
