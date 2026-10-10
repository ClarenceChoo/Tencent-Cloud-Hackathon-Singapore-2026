"use client";

import {useEffect,useRef,useState} from 'react';
import {FirmwareInstallSession,loadFirmware,type FlashProgress} from './wifi-firmware';
import type {WifiSerialAccess} from './wifi-usb';

export default function WifiFirmwareInstaller({supported,blocked,onBusyChange,onBeforeConnect}:{supported:boolean;blocked:boolean;onBusyChange:(busy:boolean)=>void;onBeforeConnect:()=>Promise<void>}){
  const session=useRef<FirmwareInstallSession|null>(null),mounted=useRef(true),busyRef=useRef(false);
  const [confirmed,setConfirmed]=useState(false),[savedBackup,setSavedBackup]=useState(false),[backupUrl,setBackupUrl]=useState('');
  const [busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState<FlashProgress|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;void session.current?.close();};},[]);
  useEffect(()=>()=>{if(backupUrl)URL.revokeObjectURL(backupUrl);},[backupUrl]);
  useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(busyRef.current){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
  function working(value:boolean){busyRef.current=value;onBusyChange(value||!!session.current);if(mounted.current)setBusy(value);}
  function status(value:FlashProgress){if(mounted.current)setProgress(value);}
  async function prepare(){
    if(!confirmed||blocked||busyRef.current)return;
    const serial=(navigator as Navigator&{serial?:WifiSerialAccess}).serial;if(!serial)return;
    setError('');setDone(false);setSavedBackup(false);setBackupUrl('');working(true);
    try{
      // Request the explicitly selected port during the user's click gesture.
      const port=await serial.requestPort();
      await onBeforeConnect();await session.current?.close();session.current=null;
      status({phase:'checking',percent:0,message:'Downloading and checking the firmware…'});
      const firmware=await loadFirmware();
      const next=await FirmwareInstallSession.prepare(port,firmware,status);
      if(!mounted.current){await next.close();return;}
      session.current=next;setBackupUrl(URL.createObjectURL(new Blob([new Uint8Array(next.backup)],{type:'application/octet-stream'})));
      status({phase:'backup',percent:100,message:'Board checked. Save the backup, then install the firmware.'});
    }catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'USB setup failed. Reconnect the board and try again.');}
    finally{working(false);}
  }
  async function install(){
    if(!session.current||!savedBackup||busyRef.current)return;
    setError('');working(true);
    try{await session.current.install(savedBackup,status);if(mounted.current)setDone(true);}
    catch(cause){if(mounted.current)setError(`${cause instanceof Error?cause.message:'Installation was interrupted.'} Keep the backup. Reconnect USB and retry the installation; the board may need BOOT held while pressing RESET.`);}
    finally{session.current=null;working(false);}
  }
  async function cancel(){await session.current?.close();session.current=null;setBackupUrl('');setProgress(null);working(false);}
  return <div className="wifi-installer">
    <p>Install Parse Wi-Fi on your original <strong>ESP32-S3 N16R8 microphone board</strong>. This replaces its current program. The installer checks the chip, saves a backup, and verifies the written firmware.</p>
    <label className="wifi-check"><input type="checkbox" checked={confirmed} disabled={busy||!!backupUrl} onChange={event=>setConfirmed(event.target.checked)}/> This is the original N16R8 board with microphone pins 4, 5 and 6.</label>
    <button type="button" className="button button-secondary" disabled={!supported||!confirmed||busy||blocked} onClick={()=>void prepare()}>{busy?'Working…':backupUrl?'Choose board again':'Choose board & prepare backup'}</button>
    {!supported&&<p className="wifi-hint">The installer needs Chrome or Edge on a computer.</p>}
    {progress&&<div className="wifi-install-progress" role="status"><p>{progress.message}</p>{busy&&<progress max="100" value={progress.percent} aria-label="Firmware installation progress"/>}</div>}
    {backupUrl&&!done&&<div className="wifi-backup"><a className="button button-secondary" href={backupUrl} download="parse-esp32-before-wifi-0x0.bin">Download board backup</a><p className="wifi-hint">This backup stays on your computer and may contain previous device settings. It is not uploaded to Parse.</p><label className="wifi-check"><input type="checkbox" checked={savedBackup} disabled={busy} onChange={event=>setSavedBackup(event.target.checked)}/> I saved the backup and am ready to replace this board’s program.</label><button className="button button-primary" disabled={!savedBackup||busy||!session.current} onClick={()=>void install()}>Install Parse Wi-Fi</button> <button className="text-link" disabled={busy} onClick={()=>void cancel()}>Cancel installation</button></div>}
    {done&&<p className="wifi-saved">Installation complete. Use “Choose ESP32 USB port” below, then save your hotspot details.</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <p className="wifi-hint">Keep USB connected until installation finishes. Close any serial monitor first. If connection fails, hold BOOT, tap RESET, release BOOT, then choose the port again.</p>
  </div>;
}
