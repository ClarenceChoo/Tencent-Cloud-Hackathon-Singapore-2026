"use client";

import { Smartphone, Shield, Wifi } from "lucide-react";
import type { Dashboard } from "./api";

export default function DeviceSetup({data,canManage,onRevoke}: {data:Dashboard;canManage:boolean;onClaim:(code:string,kind?:'phone'|'pendant')=>Promise<void>;onRevoke:(id:string)=>void}) {
  const active=data.devices.filter(device=>!device.revoked_at);
  return <section className="card pairing-card" aria-label="Phone setup">
    <div className="section-head"><div><div className="eyebrow">Your Parse companion</div><h2>Phone connection</h2></div><Smartphone size={24}/></div>
    <p className="section-intro">Open Phone &amp; voice to create a QR, approve any phone and listen while it records. The phone does not need a ChatGPT account.</p>
    <button className="button button-deep" onClick={()=>window.dispatchEvent(new Event('parse-open-voice'))}>Open Phone &amp; voice</button>
    <div className="paired-devices">{active.map(device=><article className="paired-device" key={device.id}><div className="paired-device-title"><h3>Browser phone</h3><span className="pairing-state"><Wifi size={15}/>{device.status==='connected'?'Approved pairing':'Waiting for approval'}</span></div><p className="source-note">Keep the phone page open for recording. Pairing alone does not establish that the microphone is ready.</p>{canManage&&<button className="button" onClick={()=>onRevoke(String(device.id))}>Disconnect phone</button>}</article>)}</div>
    {!active.length&&<p className="source-note">No phone is paired to this dashboard.</p>}
    <div className="card-footnote"><Shield size={16}/><span>Tap Start recording on your phone to send a note of up to 20 seconds.</span></div>
  </section>;
}
