import {useState} from 'react';
import {Check, Wifi, Link2, MessageCircle, Shield} from 'lucide-react';
import {Dashboard,Row,label,niceDate} from './api';
import { uiPreview } from './uiPreview';

export default function DeviceSetup({data,canManage,onClaim,onRevoke}:{data:Dashboard;canManage:boolean;onClaim:(code:string,kind?:'phone'|'pendant')=>Promise<void>;onRevoke:(id:string)=>void}) {
  const [code,setCode]=useState('');
  const [kind,setKind]=useState<'phone'|'browser'|'pendant'>('pendant');
  const [pairing,setPairing]=useState(false);
  const [error,setError]=useState('');
  const [revokeId,setRevokeId]=useState('');
  const active=data.devices.filter(d=>!d.revoked_at);
  const phoneSetup=kind!=='pendant'||!canManage&&active.length>0&&active.every(d=>d.device_type==='phone');
  const matching=active.filter(d=>kind==='browser'?d.device_type==='phone'&&d.platform==='web':kind==='phone'?d.device_type==='phone'&&d.platform!=='web':d.device_type!=='phone');
  const online=matching.some(d=>d.status==='connected');
  const selected=matching.some(d=>d.selected);
  const setup=data.device_setup;
  const voice=setup?.voice_service;
  if (uiPreview) return <section className="card pairing-card" aria-label="Companion setup"><div className="section-head"><div><div className="eyebrow">UI demo · fictional sample data</div><h2>Companion setup</h2></div><Wifi size={21}/></div><p className="section-intro">Pairing and voice are unavailable in this public UI demo. Explore the companion preview without a code or microphone.</p><a className="button button-deep" href="/companion">Open companion preview</a></section>;
  async function pair(event:React.FormEvent) {
    event.preventDefault();if(pairing||!code.trim())return;
    setPairing(true);setError('');
    try {if(kind==='phone'||kind==='browser')await onClaim(code.trim().toUpperCase(),'phone');else await onClaim(code.trim().toUpperCase());setCode('');}
    catch(err){setError(err instanceof Error?err.message:'Could not pair this companion. Try again.');}
    finally{setPairing(false);}
  }
  return <section className="card pairing-card" aria-label="Companion setup">
    <div className="section-head"><div><div className="eyebrow">Your Parse companion</div><h2>Pair your companion</h2></div><Wifi size={21}/></div>
    <p className="section-intro">{kind==='browser'?'Open Parse in a phone browser, choose Connect this browser, and enter its private pairing code below. Keep that page open for in-page reminders.':phoneSetup?'Open the installed Parse app on the phone and enter its pairing code below. The app connects using Wi-Fi or mobile data.':'Connect the cardholder to home Wi-Fi or a phone hotspot. Your phone and care circle see the updates through Parse.'}</p>
    <a className="button button-deep" href="/companion">Open companion</a>
    <ol className="pairing-steps">
      <li className={matching.length?'is-done':''}><span>{matching.length?<Check size={17}/>:<Link2 size={17}/>}</span><div><b>1. Pair to this care space</b><p>{matching.length?`${kind==='browser'?'Browser':phoneSetup?'Phone':'Cardholder'} paired. It can still be offline.`:kind==='browser'?'Use the expiring code displayed in the Parse browser companion.':phoneSetup?'Use the expiring code displayed in the Parse phone app.':'Use the one-use code supplied with your cardholder.'}</p></div></li>
      <li className={(phoneSetup?selected:online)?'is-done':''}><span>{(phoneSetup?selected:online)?<Check size={17}/>:<Wifi size={17}/>}</span><div><b>{phoneSetup?'2. Choose the reminder companion':'2. Connect to Wi-Fi'}</b><p>{phoneSetup?'Use Reminder companion below to select this phone. Pairing alone does not change where reminders go.':online?'A live connection has been received.':'Power it on and complete its Wi-Fi setup. Wait for Online below.'}</p></div></li>
      <li><span><MessageCircle size={17}/></span><div><b>3. Try a conversation</b><p>{voice==='configured'?kind==='browser'?'In the companion page, tap to record, listen to the read-back, then confirm. Keep the page open for in-page reminders.':phoneSetup?'On the phone, allow the microphone when prompted and check the speaker. Hold to talk, listen to the read-back, then confirm. Check the timeline.':'Press to speak, listen to the read-back, then confirm. Check the timeline.':'Finish the voice-service setup before testing a spoken note.'}</p></div></li>
    </ol>
    {kind==='browser'&&<div className="pairing-service" aria-label="Browser readiness"><b>Browser readiness</b><p>{!matching.length?'Approve the browser code for the intended person first.':!online?'Approved, but a current browser connection has not been reported. Ask the patient to keep the companion page open and refresh.':!selected?'Connected. Select this browser under Reminder companion if it should receive reminders.':'Connected and selected for reminders while the companion page stays open and visible.'}</p><p>Speaker playback, microphone permission, and a first confirmed update are checked in that browser’s first-use guide. A paired device or an existing record does not prove those checks passed.</p><p>To verify caregiver visibility, the intended recipient must sign in with their own account and check a record explicitly shared with them.</p></div>}
    {canManage&&<form className="claim-form" onSubmit={pair}>
      <label htmlFor="pairing-kind">Companion type<select id="pairing-kind" value={kind} disabled={pairing} onChange={e=>{setKind(e.target.value as 'phone'|'browser'|'pendant');setCode('');setError('')}}><option value="pendant">Cardholder</option><option value="phone">Parse phone app</option><option value="browser">Parse browser</option></select></label>
      <label htmlFor="pairing-code">One-use device code</label>
      <div className="inline-field"><input id="pairing-code" value={code} onChange={e=>setCode(e.target.value)} placeholder="ABCD-1234" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} disabled={pairing}/><button className="button button-deep" disabled={pairing||!code.trim()}>{pairing?'Pairing…':kind==='browser'?'Approve browser':kind==='phone'?'Approve phone':'Pair cardholder'}</button></div>
      <p>This links the device to {data.patient.name}. {kind==='browser'?'Enter the code displayed at /companion in the phone browser. The browser uses its own pairing and cannot sign in to this dashboard.':kind==='phone'?'Enter the code displayed by the Parse phone app. The code expires after ten minutes.':'Use the code supplied with the cardholder. Its setup operator can renew expired codes.'}</p>
      {error&&<div className="inline-error" role="alert">{error}</div>}
    </form>}
    {!canManage&&<p className="source-note">The care-space owner manages device pairing and access.</p>}
    <div className="paired-devices" aria-live="polite">
      {data.devices.map(device=>{const presence=(device.phone_presence||{}) as Row;const status=label(device,'status');const statusName=status==='connected'?'Online':status==='revoked'?'Access revoked':status==='awaiting_connection'?'Paired · waiting for connection':'Offline';return <article className="paired-device" key={device.id}>
        <div className="paired-device-title"><h3>{device.device_type==='phone'?`${device.platform==='web'?'Parse browser':'Parse phone'} · ${label(device,'display_name')||label(device,'platform')}`:'Parse cardholder'}</h3><span className={`pairing-state ${status==='connected'?'is-online':''}`}>{statusName}</span></div>
        <p className="device-identifier">{device.id}</p>
        {!!device.selected&&<p className="source-note">Selected reminder companion</p>}
        {device.device_type==='phone'&&<dl className="pairing-facts"><div><dt>{device.platform==='web'?'Browser':'Phone app'}</dt><dd>{device.revoked_at?'Access revoked':presence.foreground_ready?'Foreground ready':presence.microphone_permission==='denied'?'Microphone blocked':presence.last_reported_lifecycle==='background'?'Last reported in background':'Not ready in foreground'}</dd></div><div><dt>{device.platform==='web'?'Reminders':'Background alerts'}</dt><dd>{device.platform==='web'?'Only while the companion page stays open and visible':presence.background_alerts_enabled?'Enabled · delivery subject to OS settings':presence.notification_permission==='denied'?'Permission denied':'Not currently scheduled'}</dd></div>{device.platform!=='web'&&<><div><dt>Schedule coverage</dt><dd>{niceDate(presence.scheduled_until,'No coverage reported')}</dd></div><div><dt>Care update alerts</dt><dd>{presence.push_registered===true?'Registered · delivery depends on phone settings':presence.push_registered===false?'Not registered':'No registration reported'}</dd></div></>}</dl>}

        <dl className="pairing-facts"><div><dt>Last connection</dt><dd>{niceDate(device.last_seen,'Not connected yet')}</dd></div><div><dt>Battery</dt><dd>{typeof device.battery_mv==='number'?`${(device.battery_mv/1000).toFixed(2)} V`:'Not reported'}</dd></div><div><dt>Firmware</dt><dd>{label(device,'firmware_version')||'Not reported'}</dd></div></dl>
        {status==='stale'&&<p className="source-note">Check power, Wi-Fi and the service address. This status updates automatically.</p>}
        {canManage&&!device.revoked_at&&<button className="text-link revoke-device" onClick={()=>setRevokeId(String(device.id))}>Revoke device access</button>}
      </article>;})}
    </div>
    <div className="pairing-service" aria-label="Connection requirements">
      <div><b>Service address</b><p>{setup?.service_address||'An HTTPS service address has not been configured yet.'}</p></div>
      <div><b>Voice service</b><p>{voice==='configured'?'Configured. A successful live conversation still needs to be checked.':voice==='simulated'?'Simulation mode. These are test responses, not live speech.':voice==='invalid_configuration'?'The voice-service configuration needs attention from the project team.':'Voice replies are not enabled on this server yet. Pairing and dashboard records still work.'}</p></div>
      {setup&&!setup.scheduler_enabled&&<p className="source-note">Scheduled reminders are disabled on this server.</p>}
    </div>
    {!phoneSetup&&<details className="pairing-help"><summary>How to connect the cardholder to Wi-Fi</summary><ol><li>Power on the cardholder. On first setup, join the <b>CareLoop-XXXX</b> Wi-Fi network using the setup password supplied with it.</li><li>Open <b>http://192.168.4.1/</b> while connected to that network.</li><li>Enter your 2.4 GHz WPA2 Wi-Fi or compatible hotspot details, and the service address above.</li><li>Reconnect your phone to its usual network and return to Parse. Look for <b>Online</b>.</li></ol><p>The pairing code and Wi-Fi setup password are different. Keep the pendant’s private device credential with its firmware setup files.</p><p>To change Wi-Fi later, hold the talk button while powering on for five seconds. Release it after two vibration pulses, then repeat setup with the same setup password.</p></details>}
    <div className="card-footnote"><Shield size={15}/><span>{phoneSetup?'The phone records only when you use its talk control. Pairing does not start recording.':'The microphone records only while the pendant’s button is pressed. Pairing does not start recording.'}</span></div>
    {revokeId&&<div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="revoke-title"><h2 id="revoke-title">Disconnect this companion?</h2><p>Its credential will stop working. Reconnecting it requires a new device setup; your saved care records will stay available.</p><div className="modal-actions"><button className="button" onClick={()=>setRevokeId('')}>Keep connected</button><button className="button button-danger" onClick={()=>{onRevoke(revokeId);setRevokeId('')}}>Revoke access</button></div></div></div>}
  </section>;
}
