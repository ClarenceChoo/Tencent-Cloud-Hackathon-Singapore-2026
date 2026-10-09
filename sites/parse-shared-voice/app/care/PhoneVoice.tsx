"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import VoiceWorkspace from "../voice-workspace";
import { api, type Proposal, type VoiceInterpretation } from "./api";
import Esp32Connection from "./Esp32Connection";
import {isCurrentProposal,voiceActionLabel} from './voice-result';

export default function PhoneVoice({patientId,displayName,phoneOrigin,onReview}: {patientId:string;displayName:string;phoneOrigin:string;onReview:(proposal:Proposal)=>void}) {
  const [busy,setBusy]=useState<string|null>(null);
  const [result,setResult]=useState<VoiceInterpretation|null>(null);
  const [error,setError]=useState('');
  async function interpret(recordingId:string) {
    if(busy)return;
    setBusy(recordingId);setError('');setResult(null);
    try { const next=await api.interpretVoice(patientId,recordingId);setResult(next);if(isCurrentProposal(next.proposal))onReview(next.proposal); }
    catch(error){setError(error instanceof Error?error.message:'Could not prepare this update. Your recording remains available.');}
    finally{setBusy(null);}
  }
  return <div className="care-phone-view">
    <Esp32Connection phoneOrigin={phoneOrigin} onReview={id=>void interpret(id)} reviewBusy={busy}/>
    <section className="card care-voice-guide"><Sparkles size={23}/><div><h2>Understand Parse’s response</h2><p>Parse can prepare care updates for your review, answer questions from checked care information, or ask for a detail it needs. Care updates are saved only after you review and confirm them.</p>{result&&<div className="voice-result-summary" role="status"><strong>{voiceActionLabel(result.intent,result.proposal?.kind,result.proposal?.status??null)}</strong><p>{result.spoken_text}</p>{result.intent==='clarify'&&<small>Record your answer in another short clip on this connection.</small>}{isCurrentProposal(result.proposal)&&<button className="text-link" onClick={()=>onReview(result.proposal!)}>Review this care update</button>}</div>}{error&&<p className="inline-error" role="alert">{error}</p>}<details className="voice-say-guide"><summary>What you can say</summary><p>Try: “I felt dizzy this morning”; “I took the listed dose”; “My blood pressure was 120 over 80 this morning from my home cuff”; or “Has anyone acknowledged my request?”</p><p>Parse can’t create medication reminders or change medication plans here. Use the dashboard’s medication controls for those changes.</p></details></div></section>
    <VoiceWorkspace signedIn displayName={displayName} signInPath="/signin-with-chatgpt?return_to=%2F" phoneOrigin={phoneOrigin} embedded onInterpret={interpret} interpretationBusy={busy}/>
  </div>;
}
