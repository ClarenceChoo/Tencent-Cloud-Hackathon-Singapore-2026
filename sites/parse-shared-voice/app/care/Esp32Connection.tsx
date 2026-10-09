"use client";

import {useCallback,useEffect,useRef,useState} from 'react';
import {Mic,Radio,Volume2} from 'lucide-react';
import {errorText,voiceApi,type Room} from '../voice-client';
import MicrophoneVisual from './MicrophoneVisual';
import {voiceActionLabel} from './voice-result';
import './esp32Workspace.css';

type RelayState={online:boolean;lastSeen:number|null;status:{busy:boolean;hardwareReady:boolean;canRetry:boolean;phase:string;message?:string;error?:string;transport?:string;transferPercent?:number};command:{id:string;kind:string;state:string;expiresAt:number}|null;latest:{id:string;state:string;createdAt:number;transcript:string|null;audioUrl:string|null;replyAudioUrl:string|null;reply:{spokenText:string;functionName:string;intent?:'clarify'|'chat'|'proposal'|'correct'|'confirm'|'explain'|'support_status'|'followup_status';proposalKind?:string|null;proposalStatus?:string|null;hasProposal:boolean}|null}|null};
export default function Esp32Connection({phoneOrigin,onReview,reviewBusy}:{phoneOrigin:string;onReview:(id:string)=>void;reviewBusy:string|null}){
  const [room,setRoom]=useState<Room|null>(null),[relay,setRelay]=useState<RelayState|null>(null),[link,setLink]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[pollError,setPollError]=useState('');
  const inFlight=useRef(false),generation=useRef(0),pendingRequest=useRef<{commandId:string;kind:string}|null>(null);
  const refresh=useCallback(async()=>{
    if(inFlight.current)return;inFlight.current=true;const current=generation.current;
    try{
      const value=await voiceApi<{rooms:Room[]}>('rooms');const next=value.rooms.find(item=>item.clientType==='esp32')??null;
      const status=next?.state==='paired'?await voiceApi<RelayState>(`rooms/${next.id}/relay`):null;
      if(current===generation.current){setRoom(next);setRelay(status);setPollError('');}
    }catch(cause){if(current===generation.current){setPollError(errorText(cause));setRelay(value=>value?{...value,online:false}:null);}}
    finally{inFlight.current=false;}
  },[]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},2000);return()=>{generation.current++;clearInterval(timer);};},[refresh]);
  async function action(work:()=>Promise<void>){if(busy)return;setBusy(true);setError('');generation.current++;try{await work();}catch(cause){setError(errorText(cause));}finally{setBusy(false);void refresh();}}
  function connect(){void action(async()=>{const value=await voiceApi<{room:Room;phonePath:string}>('rooms',{clientType:'esp32'});setRoom(value.room);setRelay(null);setLink(new URL(value.phonePath,phoneOrigin||location.origin).href);});}
  function approve(){if(room?.code)void action(async()=>{await voiceApi(`rooms/${room.id}/approve`,{code:room.code});setLink('');});}
  function disconnect(){if(room)void action(async()=>{await voiceApi(`rooms/${room.id}/revoke`,{});setRoom(null);setRelay(null);setLink('');pendingRequest.current=null;});}
  function record(kind='capture'){
    if(!room)return;
    void action(async()=>{
      const request=pendingRequest.current?.kind===kind?pendingRequest.current:{commandId:crypto.randomUUID(),kind};pendingRequest.current=request;
      const value=await voiceApi<{command:NonNullable<RelayState['command']>}>(`rooms/${room.id}/capture`,request);
      pendingRequest.current=null;setRelay(old=>old?{...old,command:value.command}:old);
      if(['expired','failed','complete'].includes(value.command.state))setError('The previous request has ended. Choose Record & send again for a new clip.');
    });
  }
  const online=!!relay?.online,working=!!relay?.status.busy||!!relay?.command,latest=relay?.latest;
  const ready=room?.state==='paired'&&online&&relay?.status.hardwareReady&&!working&&!busy;
  const statusText=room?.state!=='paired'?'Setup needed':!online?'Laptop relay offline':!relay?.status.hardwareReady?'ESP32 not connected':working?'Recording workflow active':'Ready to record';
  return <section className="card esp-workspace">
    <div className="esp-heading"><div className="esp-device-icon"><Radio size={24}/></div><div><h2>ESP32 voice studio</h2><p>Record, inspect the microphone signal, and review Parse’s response here.</p></div><span className={`esp-status ${ready?'is-ready':''}`} role="status"><i/>{statusText}</span></div>
    {room?.state==='paired'?<>
      <div className="esp-record-strip"><button className="button button-primary esp-record" disabled={!ready} onClick={()=>record()}><Mic size={19}/>{working?'Working…':'Record & send'}</button><div><strong>6-second recording</strong><span>Speak after the 3-second countdown. Stops automatically.</span></div>{relay?.status.canRetry&&online&&!working&&<button className="button button-secondary" disabled={busy} onClick={()=>record('retry')}>Retry sending this clip</button>}</div>
      <div className="esp-progress" aria-live="polite">{!online?'Keep the laptop relay running and the ESP32 connected. This page will reconnect automatically.':!relay?.status.hardwareReady?'Connect the ESP32 to the configured USB port on the laptop.':relay?.command?.state==='queued'?'Recording requested. Waiting for the laptop…':relay?.status.message||'Ready when you are.'}</div>
      {relay?.status.error&&<p className="inline-error" role="alert">{relay.status.error}</p>}
      <div className="esp-flow" aria-label="Recording steps">{['Record','Transfer','Transcribe','Review'].map((step,index)=><span key={step}><b>{index+1}</b>{step}</span>)}</div>
      <MicrophoneVisual audioUrl={latest?.audioUrl??null}/>
      {latest&&<div className="esp-results" key={latest.id}><div><div className="esp-section-title"><h3>Your recording</h3><span>{new Date(latest.createdAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span></div>{latest.audioUrl&&<audio controls preload="none" src={latest.audioUrl} aria-label="Play the ESP32 microphone recording"/>}<p className="esp-transcript">{latest.transcript||(['receiving','processing'].includes(latest.state)?'Receiving and transcribing this clip…':'The transcript is not available yet. You can still inspect and listen to the recording.')}</p></div><div><div className="esp-section-title"><h3>Parse’s response</h3><Volume2 size={17}/></div>{latest.reply&&<p className="voice-result-action">{voiceActionLabel(latest.reply.intent,latest.reply.proposalKind,latest.reply.proposalStatus??null)}</p>}<p>{latest.reply?.spokenText||'Parse’s response will appear here.'}</p>{latest.replyAudioUrl&&<audio controls preload="none" src={latest.replyAudioUrl} aria-label="Play Parse’s spoken reply"/>}{latest.transcript&&<button className="button button-secondary" disabled={!!reviewBusy} onClick={()=>onReview(latest.id)}>{reviewBusy===latest.id?'Preparing…':latest.reply?.proposalStatus==='pending'&&latest.reply.hasProposal?'Review care update':'Review transcript with Parse'}</button>}{latest.reply?.proposalStatus==='pending'&&latest.reply.hasProposal&&<small>Review the proposal while it is current, then confirm it on the dashboard to save.</small>}{latest.reply?.intent==='clarify'&&<small>Record your answer in another short clip on this connection.</small>}</div></div>}
      <details className="esp-setup"><summary>Laptop connection</summary><p>The relay connects your ESP32 to this page over {relay?.status.transport||'Bluetooth'}. Leave it running on the laptop; the local diagnostics page can stay closed.</p><p>{relay?.lastSeen?`Last contact: ${new Date(relay.lastSeen).toLocaleTimeString()}. `:''}Pairing expires {new Date(room.expiresAt).toLocaleString()}.</p><button className="text-link" disabled={busy} onClick={disconnect}>Disconnect ESP32</button></details>
    </>:<div className="esp-pairing">
      {room?.state==='pending'?<><p>Compare this code with the laptop relay, then approve the connection.</p><div className="voice-code">{room.code}</div><button className="button button-primary" disabled={busy} onClick={approve}>Codes match — connect ESP32</button> <button className="text-link" disabled={busy} onClick={disconnect}>Cancel</button></>:
      link?<><p>Open the laptop relay once to pair it, then return here. All recording controls will be on this page.</p><a className="button button-primary" href={`http://127.0.0.1:8768/#pair=${encodeURIComponent(link)}`} target="_blank" rel="noreferrer">Connect this laptop</a> <button className="text-link" onClick={()=>void navigator.clipboard.writeText(link).catch(()=>setError('Use Connect this laptop to open the relay.'))}>Copy pairing link</button></>:
      <><p>Connect your laptop once to enable the ESP32 microphone. Keep its relay running in the background.</p><button className="button button-primary" disabled={busy} onClick={connect}>{busy?'Preparing…':'Connect ESP32'}</button></>}
      <MicrophoneVisual audioUrl={null}/>
    </div>}
    {(error||pollError)&&<p className="inline-error" role="alert">{error||pollError}</p>}
  </section>;
}
