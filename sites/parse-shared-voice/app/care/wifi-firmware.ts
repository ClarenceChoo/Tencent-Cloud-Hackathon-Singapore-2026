import type {WifiSerialPort} from './wifi-usb';

export type FirmwarePart={name:string;path:string;address:number;size:number;sha256:string;md5:string};
export type FirmwareManifest={version:string;chip:'ESP32-S3';flashSize:16777216;backupSize:number;parts:FirmwarePart[]};
export type FirmwarePackage={manifest:FirmwareManifest;files:Array<FirmwarePart&{data:Uint8Array}>};
export type FlashProgress={phase:'checking'|'backup'|'writing'|'done';percent:number;message:string};
export interface FlashTransport {disconnect():Promise<void>}
export interface FlashLoader {
  chip:{CHIP_NAME:string};IS_STUB:boolean;
  main():Promise<unknown>;readFlashId():Promise<number>;readReg(address:number):Promise<number>;
  readFlash(address:number,size:number,progress:(packet:Uint8Array,read:number,total:number)=>void):Promise<Uint8Array>;
  writeFlash(options:{fileArray:Array<{data:Uint8Array;address:number}>;flashMode:'keep';flashFreq:'keep';flashSize:'keep';eraseAll:false;compress:true;calculateMD5Hash:(data:Uint8Array)=>string;reportProgress:(index:number,written:number,total:number)=>void}):Promise<void>;
  after(mode:'hard_reset'):Promise<void>;
}
export type FlashFactory=(port:WifiSerialPort)=>Promise<{loader:FlashLoader;transport:FlashTransport}>;
const fail=(message:string):never=>{throw new Error(message);};

export function firmwareManifest(value:unknown):FirmwareManifest {
  const v=value as FirmwareManifest;
  if(!v||v.version!=='parse-wifi-1'||v.chip!=='ESP32-S3'||v.flashSize!==16777216||v.backupSize!==2162688||!Array.isArray(v.parts)||v.parts.length!==3)fail('The firmware package does not match this board.');
  const expected=[{address:0,max:32768},{address:32768,max:4096},{address:65536,max:2097152}];
  for(let index=0;index<expected.length;index++){
    const p=v.parts[index],e=expected[index];
    if(!p||p.address!==e.address||!Number.isInteger(p.size)||p.size<4||p.size>e.max||p.size%4!==0||typeof p.name!=='string'||p.name.length>40||!/^\/firmware\/parse-wifi-1\/[a-z0-9-]+\.bin$/.test(p.path)||!/^([a-f0-9]{64})$/.test(p.sha256)||!/^([a-f0-9]{32})$/.test(p.md5))fail('The firmware package has an invalid flash layout.');
  }
  return v;
}
export function compatiblePartitions(backup:Uint8Array):boolean {
  if(backup.length<0x9000)return false;
  const table=backup.subarray(0x8000,0x9000);
  if(table.every(byte=>byte===255))return true;
  const view=new DataView(table.buffer,table.byteOffset,table.byteLength),entries=[];
  for(let at=0;at<0xc00;at+=32){
    const magic=view.getUint16(at,true);if(magic===0xffff||magic===0xebeb)break;
    if(magic!==0x50aa)return false;
    entries.push({type:table[at+2],subtype:table[at+3],offset:view.getUint32(at+4,true),size:view.getUint32(at+8,true),flags:view.getUint32(at+28,true)});
  }
  return entries.length===3&&entries.some(e=>e.type===1&&e.subtype===2&&e.offset===0x9000&&e.size===0x6000&&!e.flags)&&entries.some(e=>e.type===1&&e.subtype===1&&e.offset===0xf000&&e.size===0x1000&&!e.flags)&&entries.some(e=>e.type===0&&e.subtype===0&&e.offset===0x10000&&e.size>=0x100000&&e.size<=0x200000&&!e.flags);
}
export async function sha256(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('');}
export async function loadFirmware(fetcher:typeof fetch=fetch):Promise<FirmwarePackage>{
  const response=await fetcher('/firmware/parse-wifi-1/manifest.json',{cache:'no-store',redirect:'error'});
  if(!response.ok)fail('The firmware download is unavailable. Reload this page and try again.');
  const manifest=firmwareManifest(await response.json()),files:FirmwarePackage['files']=[];
  for(const part of manifest.parts){
    const asset=await fetcher(part.path,{cache:'no-store',redirect:'error'});
    if(!asset.ok)fail('The firmware download was interrupted. Try again before connecting USB.');
    const data=new Uint8Array(await asset.arrayBuffer());
    if(data.length!==part.size||await sha256(data)!==part.sha256)fail('The firmware download failed its integrity check. Nothing has been installed.');
    files.push({...part,data});
  }
  return {manifest,files};
}
export const browserFlashFactory:FlashFactory=async port=>{
  const modulePath='/firmware/esptool-0.6.1.js';
  const module=await import(/* @vite-ignore */ modulePath);
  const transport=new module.Transport(port,false);
  const loader=new module.ESPLoader({transport,baudrate:460800,debugLogging:false,enableTracing:false,terminal:{clean(){},write(){},writeLine(){}}});
  return {transport,loader};
};

export class FirmwareInstallSession {
  private closed=false;private installed=false;private writing=false;
  private constructor(private loader:FlashLoader,private transport:FlashTransport,private firmware:FirmwarePackage,readonly backup:Uint8Array){}
  static async prepare(port:WifiSerialPort,firmware:FirmwarePackage,onProgress:(value:FlashProgress)=>void,factory:FlashFactory=browserFlashFactory):Promise<FirmwareInstallSession>{
    firmwareManifest(firmware.manifest);
    if(firmware.files.length!==3)fail('The firmware download is incomplete.');
    for(let i=0;i<3;i++){const file=firmware.files[i],part=firmware.manifest.parts[i];if(file.address!==part.address||file.size!==part.size||file.md5!==part.md5||file.data.length!==part.size||await sha256(file.data)!==part.sha256)fail('The firmware download failed its integrity check.');}
    const {loader,transport}=await factory(port);
    try{
      onProgress({phase:'checking',percent:0,message:'Checking the selected ESP32…'});
      await loader.main();
      if(loader.chip.CHIP_NAME!=='ESP32-S3'||!loader.IS_STUB)fail('Select the original ESP32-S3 board. This board is not supported.');
      if(((await loader.readFlashId()>>>16)&255)!==24)fail('This firmware needs the original board with 16 MB flash. Nothing has been written.');
      // ESP32-S3 eFuse addresses from Espressif esptool targets/esp32s3.py.
      // Read only. Reject secure/encrypted boards; never modify their eFuses.
      const security=await loader.readReg(0x60007038),crypt=await loader.readReg(0x60007034);
      if((security&(1<<20))||(crypt&(7<<18)))fail('This board has security settings that require its existing firmware workflow. Nothing has been written.');
      const backup=await loader.readFlash(0,firmware.manifest.backupSize,(_packet,read,total)=>onProgress({phase:'backup',percent:Math.round(read/total*100),message:'Reading a local backup before installation…'}));
      if(backup.length!==firmware.manifest.backupSize)fail('The backup was incomplete. Nothing has been written.');
      if(!compatiblePartitions(backup))fail('This board has a different flash layout. Keep its existing firmware workflow; nothing has been written.');
      return new FirmwareInstallSession(loader,transport,firmware,backup);
    }catch(error){await transport.disconnect().catch(()=>{});throw error;}
  }
  async install(backupConfirmed:boolean,onProgress:(value:FlashProgress)=>void):Promise<void>{
    if(!backupConfirmed)fail('Save the backup before installing.');
    if(this.closed||this.installed||this.writing)fail('Reconnect the ESP32 to start another installation.');
    this.writing=true;
    try{
      for(let i=0;i<this.firmware.files.length;i++){
        const file=this.firmware.files[i];
        await this.loader.writeFlash({fileArray:[{data:file.data,address:file.address}],flashMode:'keep',flashFreq:'keep',flashSize:'keep',eraseAll:false,compress:true,calculateMD5Hash:()=>file.md5,reportProgress:(_index,written,total)=>onProgress({phase:'writing',percent:Math.round((i+written/Math.max(total,1))/3*100),message:`Installing ${file.name} and verifying it…`})});
      }
      this.installed=true;
      await this.loader.after('hard_reset');
      onProgress({phase:'done',percent:100,message:'Firmware installed and verified. Reconnect USB below to save your hotspot.'});
    }finally{this.writing=false;await this.close();}
  }
  async close():Promise<void>{if(this.closed||this.writing)return;this.closed=true;await this.transport.disconnect().catch(()=>{});}
}
