import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const built=await build({entryPoints:[fileURLToPath(new URL('../app/care/wifi-usb.ts',import.meta.url))],bundle:true,write:false,format:'esm',target:'es2022'});
const wifi=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const roomId='12345678-1234-4234-8234-123456789abc',invite='a'.repeat(64),deviceCode='654321';
const checks=[];

class FakePort{
 constructor(handler){
  this.writes=[];this.closeCount=0;this.cancelCount=0;this.handler=handler;this.controller=null;
  this.readable=new ReadableStream({start:controller=>{this.controller=controller;},cancel:()=>{this.cancelCount++;}});
  this.writable=new WritableStream({write:chunk=>{const line=new TextDecoder().decode(chunk).trim();this.writes.push(line);this.handler?.(JSON.parse(line),this);}});
 }
 open(options){this.openOptions=options;return Promise.resolve();}
 close(){this.closeCount++;return Promise.resolve();}
 emitLine(line){try{this.controller.enqueue(new TextEncoder().encode(line+'\n'));}catch{}}
 disconnect(){try{this.controller.close();}catch{}}
}
const access=port=>({requestPort:async()=>port});
function fastTimeouts(){const original=globalThis.setTimeout;globalThis.setTimeout=(callback,ms,...args)=>original(callback,Math.min(ms,25),...args);return()=>{globalThis.setTimeout=original;};}

// Firmware identity must be established before wifi_setup sends the entered credentials.
{
 const restore=fastTimeouts(),port=new FakePort((request,p)=>p.emitLine(`PARSE_WIFI_STATUS ${JSON.stringify({protocol:1,firmware:'other-device',state:'idle',requestId:request.requestId})}`));
 try{await assert.rejects(wifi.WifiUsbSession.connect(access(port),()=>{},()=>{}),/did not identify itself as Parse Wi-Fi firmware/);}finally{restore();}
 assert.equal(port.writes.length,3);assert(port.writes.every(line=>JSON.parse(line).command==='wifi_status'));
 assert(!port.writes.some(line=>line.includes('wifi_setup')));assert.equal(port.closeCount,1);
 checks.push('unsupported firmware is rejected before hotspot credentials are sent');
}

// UTF-8 SSIDs are measured in bytes; iPhone hotspot passwords must fit WPA2's ASCII limits.
assert.match(wifi.hotspotError('炬'.repeat(11),'password123'),/32 bytes/);
assert.equal(wifi.hotspotError('炬'.repeat(10),'12345678'),null);
assert.match(wifi.hotspotError('iphone','short'),/8–63/);
assert.match(wifi.hotspotError('bad\nname','password123'),/hotspot name/);
assert.match(wifi.hotspotError('iphone','x'.repeat(64)),/8–63/);
assert.deepEqual(wifi.pairingDetails(`/phone?room=${roomId}#pair=${invite}`),{roomId,token:invite});
assert.throws(()=>wifi.pairingDetails('/phone?room=invalid#pair=bad'),/could not prepare/);
checks.push('hotspot validation uses UTF-8 SSID byte length and validates pairing details');

const ssid='Anson’s iPhone ☀️',password='correct horse 7';
let fetchCount=0,storageReads=0;
const previousFetch=globalThis.fetch,previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
globalThis.fetch=()=>{fetchCount++;throw new Error('unexpected network request');};
Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){storageReads++;throw new Error('unexpected browser storage access');}});
{
 const port=new FakePort((request,p)=>{
  const base={protocol:1,firmware:'parse-wifi-1',roomId,code:deviceCode};
  if(request.command==='wifi_status'){
   p.emitLine('ESP-ROM: boot noise');p.emitLine('PARSE_WIFI_STATUS {malformed');p.emitLine(`PARSE_WIFI_STATUS ${'x'.repeat(2100)}`);
   p.emitLine(`PARSE_WIFI_STATUS ${JSON.stringify({...base,state:'error',errorCode:'wrong_request',requestId:crypto.randomUUID()})}`);
   p.emitLine(`PARSE_WIFI_STATUS ${JSON.stringify({...base,state:'idle',requestId:request.requestId})}`);
  }else if(request.command==='wifi_setup'){
   p.emitLine(`SSID=${ssid} password=${password}`); // Console-like echoes are ignored by the protocol parser.
   p.emitLine(`PARSE_WIFI_STATUS ${JSON.stringify({...base,state:'wifi_saved',requestId:request.requestId})}`);
  }else if(request.command==='wifi_network'){
   p.emitLine(`PARSE_WIFI_STATUS ${JSON.stringify({...base,state:'wifi_saved',requestId:request.requestId})}`);
  }
 });
 const statuses=[];
 const session=await wifi.WifiUsbSession.connect(access(port),value=>statuses.push(value),()=>{});
 assert.deepEqual(port.openOptions,{baudRate:115200,bufferSize:4096});
 const initial=JSON.parse(port.writes[0]);
 const saved=await session.configure(ssid,password,{roomId,token:invite});
 assert.equal(saved.state,'wifi_saved');
 const setup=JSON.parse(port.writes[1]);assert.equal(setup.command,'wifi_setup');assert.equal(setup.ssid,ssid);assert.equal(setup.password,password);assert.equal(setup.room_id,roomId);assert.equal(setup.pairing_token,invite);assert.notEqual(setup.requestId,initial.requestId);
 assert(statuses.some(value=>value.state==='idle'&&value.requestId===initial.requestId));
 assert(statuses.some(value=>value.errorCode==='wrong_request'),'the board may report an asynchronous status with an older request id');
 assert.equal(saved.state,'wifi_saved','a mismatched request id cannot resolve the command; the matching acknowledgement does');
 assert(!statuses.some(value=>JSON.stringify(value).includes(password)),'console echo containing credentials is ignored');
 const changed=await session.configure('Anson’s new hotspot','another pass 9');assert.equal(changed.state,'wifi_saved');
 const update=JSON.parse(port.writes[2]);assert.equal(update.command,'wifi_network');assert.equal(update.ssid,'Anson’s new hotspot');assert.equal(update.password,'another pass 9');assert(!('pairing_token' in update)&&!('room_id' in update));
 await session.close();assert.equal(port.closeCount,1);assert.equal(port.cancelCount,1);
 assert.equal(fetchCount,0);assert.equal(storageReads,0);
 assert.equal(JSON.parse(port.writes[1]).password,password,'the chosen serial port receives credentials only inside its USB command');
 checks.push('request ids fence acknowledgements; malformed, oversized, and console echo lines are ignored');
 checks.push('new pairing sends the invite once; later hotspot changes use wifi_network without replacing device identity');
 checks.push('USB flow makes no network or localStorage call and closes the selected port cleanly');
}

// A disconnected USB stream must reject pending writes and close without sending another command.
{
 const restore=fastTimeouts();
 const port=new FakePort((request,p)=>{
  if(request.command==='wifi_status')p.emitLine(`PARSE_WIFI_STATUS ${JSON.stringify({protocol:1,firmware:'parse-wifi-1',state:'idle',requestId:request.requestId})}`);
 });
 try{
  const session=await wifi.WifiUsbSession.connect(access(port),()=>{},()=>{});
  port.handler=()=>{}; // NVS may have committed while its acknowledgement was lost.
  await assert.rejects(session.configure('Anson iPhone','secretpass'),/did not acknowledge/);
  assert.equal(port.writes.length,2,'a lost acknowledgement does not cause an automatic credentials retry');
  await session.close();assert.equal(port.closeCount,1);
  const disconnectedPort=new FakePort((request,p)=>{
   if(request.command==='wifi_status')p.emitLine(`PARSE_WIFI_STATUS ${JSON.stringify({protocol:1,firmware:'parse-wifi-1',state:'idle',requestId:request.requestId})}`);
  });
  const disconnected=await wifi.WifiUsbSession.connect(access(disconnectedPort),()=>{},()=>{});
  const pending=disconnected.configure('Anson iPhone','secretpass');
  await new Promise(resolve=>setTimeout(resolve,0));disconnectedPort.disconnect();
  await assert.rejects(pending,/USB disconnected/);
  await disconnected.close();assert.equal(disconnectedPort.closeCount,1);
  assert.equal(disconnectedPort.writes.length,2,'disconnect does not trigger a setup retry');
  checks.push('lost acknowledgement leaves one idempotent provisioning command for status/recovery');
  checks.push('USB disconnect rejects pending setup and both paths close cleanly without retries');
 }finally{restore();}
}

globalThis.fetch=previousFetch;
if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else delete globalThis.localStorage;
console.log(JSON.stringify({passed:true,checks},null,2));
