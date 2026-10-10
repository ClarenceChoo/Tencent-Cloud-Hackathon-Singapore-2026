"use client";

import {useEffect, useRef, useState} from 'react';
import {Check, PlugZap, Smartphone, Wifi} from 'lucide-react';
import WifiFirmwareInstaller from './WifiFirmwareInstaller';
import {voiceApi, type Room} from '../voice-client';
import {hotspotError, pairingDetails, WifiUsbSession, type WifiDeviceStatus, type WifiSerialAccess} from './wifi-usb';

export default function WifiDeviceSetup({room,onChange,onApprove,onCancel,busy,onBusyChange}:{room:Room|null;onChange:()=>void;onApprove:()=>void;onCancel:()=>void;busy:boolean;onBusyChange:(busy:boolean)=>void}) {
  const usb=useRef<WifiUsbSession|null>(null),mounted=useRef(true);
  const [installing,setInstalling]=useState(false);
  const [supported,setSupported]=useState(false),[connected,setConnected]=useState(false),[working,setWorking]=useState(false);
  const [ssid,setSsid]=useState(''),[password,setPassword]=useState(''),[showPassword,setShowPassword]=useState(false);
  const [device,setDevice]=useState<WifiDeviceStatus|null>(null),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  useEffect(()=>{mounted.current=true;setSupported(!!(navigator as Navigator&{serial?:WifiSerialAccess}).serial);return()=>{mounted.current=false;void usb.current?.close();usb.current=null;};},[]);
  useEffect(()=>{onBusyChange(working||installing);return()=>onBusyChange(false);},[working,installing,onBusyChange]);
  async function releaseUsb(){await usb.current?.close();usb.current=null;setConnected(false);setDevice(null);}
  async function connect(){
    setError('');setWorking(true);
    try{
      const serial=(navigator as Navigator&{serial?:WifiSerialAccess}).serial;if(!serial)throw new Error('Use Chrome or Edge on your computer for the one-time USB setup.');
      await usb.current?.close();usb.current=null;
      const session=await WifiUsbSession.connect(serial,value=>{if(mounted.current)setDevice(value);},()=>{if(mounted.current)setConnected(false);});
      if(!mounted.current){await session.close();return;}usb.current=session;setConnected(true);
    }catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'The USB connection could not be opened.');}
    finally{if(mounted.current)setWorking(false);}
  }
  async function save(){
    const problem=hotspotError(ssid,password);if(problem){setError(problem);return;}
    if(!usb.current||!connected){setError('Connect the Parse board by USB first.');return;}
    setWorking(true);setError('');
    try{
      let pairing:ReturnType<typeof pairingDetails>|undefined;
      const sameRoom=!!room&&device?.roomId===room.id&&['pending','paired'].includes(room.state);
      if(!sameRoom){
        if(room)await voiceApi(`rooms/${room.id}/revoke`,{});
        const result=await voiceApi<{room:Room;phonePath:string}>('rooms',{clientType:'esp32_wifi'});
        pairing=pairingDetails(result.phonePath);onChange();
      }
      await usb.current.configure(ssid,password,pairing);
      if(mounted.current){setSaved(true);setPassword('');setShowPassword(false);}onChange();
    }catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'The setup could not be completed.');onChange();}
    finally{if(mounted.current)setWorking(false);}
  }
  const paired=room?.state==='paired',pending=room?.state==='pending';
  const matches=!!room?.code&&device?.roomId===room.id&&device?.code===room.code;
  return <div className="wifi-setup">
    <div className="wifi-intro"><Wifi size={21}/><div><h3>{paired?'Hotspot settings':'Connect through your iPhone hotspot'}</h3><p>Set up once over USB. After that, keep the ESP32 powered and use this dashboard from your phone or computer.</p></div></div>
    <ol className="wifi-steps">
      <li><span className="wifi-step-number">1</span><div><h4><Smartphone size={17}/> Turn on your iPhone hotspot</h4><p>In <strong>Settings → Personal Hotspot</strong>, enable <strong>Allow Others to Join</strong> and <strong>Maximise Compatibility</strong>. Keep that screen open while the ESP32 connects.</p><p className="wifi-hint">The hotspot name is your iPhone’s name in Settings → General → About → Name. The ESP32 needs 2.4 GHz Wi-Fi.</p></div></li>
      <li><span className="wifi-step-number">{connected?<Check size={16}/>:2}</span><div><h4><PlugZap size={17}/> Connect the original ESP32 by USB</h4><p>Use the microphone board with Parse Wi-Fi firmware installed. Choose its USB port below; the board stays idle during setup.</p>{supported?<button className="button button-secondary" disabled={working||busy||installing} onClick={()=>void connect()}>{working?'Connecting…':connected?'USB connected · choose again':'Choose ESP32 USB port'}</button>:<p className="wifi-browser-note">Open this Parse page in <strong>Chrome or Edge on a computer</strong> for the one-time USB setup. Afterwards, Safari on your iPhone works for recording and review.</p>}<details className="wifi-firmware-help"><summary>First time installing the firmware?</summary><WifiFirmwareInstaller supported={supported} blocked={busy||working} onBusyChange={setInstalling} onBeforeConnect={releaseUsb}/></details></div></li>
      <li><span className="wifi-step-number">{saved?<Check size={16}/>:3}</span><div><h4>Save the hotspot on your ESP32</h4><form onSubmit={event=>{event.preventDefault();void save();}}><div className="wifi-fields"><label>Hotspot name<input autoComplete="off" autoCapitalize="none" spellCheck={false} value={ssid} onChange={event=>setSsid(event.target.value)} placeholder="Your iPhone’s name" disabled={working||busy||installing}/></label><label>Hotspot password<span className="wifi-password"><input type={showPassword?'text':'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={password} onChange={event=>setPassword(event.target.value)} disabled={working||busy||installing}/><button type="button" className="text-link" onClick={()=>setShowPassword(value=>!value)} aria-label={showPassword?'Hide hotspot password':'Show hotspot password'}>{showPassword?'Hide':'Show'}</button></span></label></div><p className="wifi-hint">These details go directly over USB to your ESP32. They are not sent to Parse or saved in this browser.</p><button className="button button-primary" type="submit" disabled={!connected||working||busy||installing}>{working?'Saving…':paired?'Update hotspot':'Save hotspot & connect'}</button></form>{saved&&<p className="wifi-saved" role="status">Hotspot settings saved. Keep your iPhone hotspot on while the ESP32 connects.</p>}</div></li>
      {!paired&&<li><span className="wifi-step-number">4</span><div><h4>Approve your ESP32 in Parse</h4>{pending?<><p>Compare the dashboard code with the code read from your connected board.</p><div className="wifi-codes"><div><small>Parse dashboard</small><strong>{room.code}</strong></div><div><small>Connected ESP32</small><strong>{device?.roomId===room.id&&device.code?device.code:'Waiting…'}</strong></div></div><button className="button button-primary" disabled={!matches||working||busy||installing} onClick={onApprove}>Codes match — connect ESP32</button>{!matches&&<p className="wifi-hint">Keep USB connected to read the board’s code. If you reopened this page, choose its USB port again.</p>}</>:<p>{saved?'Waiting for the ESP32 to reach Parse through your hotspot…':'A code will appear here after the ESP32 connects to your hotspot.'}</p>}</div></li>}
    </ol>
    {device&&<p className="wifi-device-status" role="status"><span>ESP32</span> {device.message||device.state.replaceAll('_',' ')}</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <details className="wifi-troubleshooting"><summary>Having trouble connecting?</summary><p>Check the hotspot name and password, keep Maximise Compatibility enabled, and leave the iPhone hotspot screen open. If details changed, reconnect USB and save the new details. A power cycle will retry the saved network.</p><p>Once connected, the board can use a USB power adapter or suitable power bank. Keep it powered while recording; a clip that has not uploaded is held in memory.</p></details>
    {room&&!paired&&<button className="text-link" disabled={working||busy||installing} onClick={onCancel}>Cancel this pairing</button>}
  </div>;
}
