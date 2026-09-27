import {useEffect,useState} from 'react';
import {Dashboard,label} from './api';

type Props={data:Dashboard;canManage:boolean;onSelect:(deviceId:string|null,generation:number,poweredOff:boolean)=>Promise<void>};
export default function CompanionSelection({data,canManage,onSelect}:Props) {
  const route=data.active_companion;
  const [selected,setSelected]=useState(route?.device_id||'');
  const [poweredOff,setPoweredOff]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{setSelected(route?.device_id||'');setPoweredOff(false)},[route?.device_id,route?.generation]);
  const current=data.devices.find(d=>d.id===route?.device_id);
  const available=data.devices.filter(d=>!d.revoked_at);
  const phoneMustPause=current?.device_type==='phone';
  const needsPowerOff=!!current&&current.device_type!=='phone'||!current&&data.devices.some(d=>d.device_type!=='phone'&&d.id!==selected);
  const name=(device:Dashboard['devices'][number])=>device.device_type==='phone'?`Phone · ${label(device,'display_name','platform')||'Parse app'}`:`Cardholder · ${String(device.id).slice(-6)}`;
  async function save(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setError('');
    try{await onSelect(selected||null,route?.generation||0,poweredOff)}
    catch(err){setError(err instanceof Error?err.message:'Could not change the reminder companion. Refresh and try again.')}
    finally{setBusy(false)}
  }
  return <section className="card" aria-label="Reminder companion">
    <div className="section-head"><div><div className="eyebrow">One place for reminders</div><h2>Reminder companion</h2></div></div>
    <p className="section-intro">{current?`Selected: ${name(current)}${current.revoked_at?' · access revoked':''}.`:'Reminders are paused. Choose a paired companion to receive them.'} Pairing a new device does not change this selection.</p>
    {phoneMustPause&&<p className="source-note">To switch, open Parse on the selected phone and choose <b>Pause reminders</b> in Settings. The phone must stop speech and clear its local alerts first, including after its access is revoked.</p>}
    {canManage?<form onSubmit={save} className="claim-form">
      <label htmlFor="reminder-companion">Send reminders to</label>
      <select id="reminder-companion" value={selected} disabled={busy||phoneMustPause} onChange={e=>{setSelected(e.target.value);setPoweredOff(false);setError('')}}>
        <option value="">Pause reminders</option>
        {!!current?.revoked_at&&<option value={String(current.id)}>{name(current)} · revoked</option>}
        {available.map(d=><option key={String(d.id)} value={String(d.id)}>{name(d)}</option>)}
      </select>
      {needsPowerOff&&<label className="source-note"><input type="checkbox" checked={poweredOff} disabled={busy} onChange={e=>setPoweredOff(e.target.checked)}/> I have powered off the previous and other cardholders. Downloaded speech cannot be stopped remotely.</label>}
      <button className="button button-deep" disabled={busy||phoneMustPause||selected===(route?.device_id||'')||needsPowerOff&&!poweredOff}>{busy?'Updating…':'Save reminder companion'}</button>
      {error&&<p role="alert" className="inline-error">{error}</p>}
    </form>:<p className="source-note">The care-space owner selects where reminders are delivered.</p>}
    <p className="source-note">Delivery history stays with each dose. A reminder that may already have played will not automatically repeat after switching.</p>
  </section>;
}
