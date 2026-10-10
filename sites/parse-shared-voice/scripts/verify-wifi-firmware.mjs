import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHash,webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const built=await build({entryPoints:[fileURLToPath(new URL('../app/care/wifi-firmware.ts',import.meta.url))],bundle:true,write:false,format:'esm',target:'es2022'});
const firmware=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const checks=[];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const md5=bytes=>createHash('md5').update(bytes).digest('hex');
const sizes=[64,128,256],addresses=[0,0x8000,0x10000],names=['bootloader','partition-table','parse-wifi'];
const bytes=sizes.map((size,index)=>Uint8Array.from({length:size},(_,i)=>(i*13+index*71)&255));
const manifest={version:'parse-wifi-1',chip:'ESP32-S3',flashSize:16777216,backupSize:2162688,parts:bytes.map((data,index)=>({name:names[index],path:`/firmware/parse-wifi-1/${names[index]}.bin`,address:addresses[index],size:data.length,sha256:digest(data),md5:md5(data)}))};
const pkg={manifest,files:bytes.map((data,index)=>({...manifest.parts[index],data:data.slice()}))};
function partitionBackup(){
 const backup=new Uint8Array(manifest.backupSize).fill(255),view=new DataView(backup.buffer);
 const entries=[{type:1,subtype:2,offset:0x9000,size:0x6000},{type:1,subtype:1,offset:0xf000,size:0x1000},{type:0,subtype:0,offset:0x10000,size:0x1f0000}];
 entries.forEach((entry,index)=>{const at=0x8000+index*32;view.setUint16(at,0x50aa,true);backup[at+2]=entry.type;backup[at+3]=entry.subtype;view.setUint32(at+4,entry.offset,true);view.setUint32(at+8,entry.size,true);view.setUint32(at+28,0,true);});
 return backup;
}
class FakeRig{
 constructor({chip='ESP32-S3',stub=true,flashId=0x180000,security=0,crypt=0,backup=partitionBackup(),backupLength=backup.length}={}){
  this.writes=[];this.reads=[];this.disconnects=0;this.afterCalls=[];this.backup=backup;this.backupLength=backupLength;
  this.loader={chip:{CHIP_NAME:chip},IS_STUB:stub,main:async()=>{this.mainCalls=(this.mainCalls||0)+1;},readFlashId:async()=>{this.flashIdCalls=(this.flashIdCalls||0)+1;return flashId;},readReg:async address=>address===0x60007038?security:crypt,
   readFlash:async(address,size,progress)=>{this.reads.push({address,size});progress(new Uint8Array(0),size,size);return this.backup.slice(0,this.backupLength);},
   writeFlash:async options=>{this.writes.push(options);const image=options.fileArray[0];this.callbackHashes??=[];this.callbackHashes.push(options.calculateMD5Hash(image.data));options.reportProgress(0,image.data.length,image.data.length);},
   after:async mode=>this.afterCalls.push(mode)};
  this.transport={disconnect:async()=>{this.disconnects++;}};
 }
 factory=async()=>({loader:this.loader,transport:this.transport});
}
const progress=[];
async function prepared(rig=new FakeRig(),bundle=pkg){return firmware.FirmwareInstallSession.prepare({},bundle,value=>progress.push(value),rig.factory);}

// Manifest layout and SHA-256 validation happen before opening a serial transport.
{
 let factoryCalls=0;const rig=new FakeRig();
 const badManifest={...manifest,parts:[...manifest.parts.map(part=>({...part}))]};badManifest.parts[1].address=0x9000;
 await assert.rejects(firmware.FirmwareInstallSession.prepare({},{...pkg,manifest:badManifest},()=>{},async()=>{factoryCalls++;return rig.factory();}),/invalid flash layout/);
 const corrupt={...pkg,files:pkg.files.map(file=>({...file,data:file.data.slice()}))};corrupt.files[1].data[0]^=0xff;
 await assert.rejects(firmware.FirmwareInstallSession.prepare({},corrupt,()=>{},async()=>{factoryCalls++;return rig.factory();}),/integrity check/);
 let requested=[];
 const validAssets=async url=>{requested.push(url);if(url.endsWith('manifest.json'))return new Response(JSON.stringify(manifest));const part=manifest.parts.find(item=>item.path===url);return new Response(bytes[manifest.parts.indexOf(part)]);};
 const loaded=await firmware.loadFirmware(validAssets);assert.equal(loaded.files.length,3);assert.deepEqual(requested,['/firmware/parse-wifi-1/manifest.json',...manifest.parts.map(part=>part.path)]);
 const badAssets=async url=>url.endsWith('manifest.json')?new Response(JSON.stringify(manifest)):new Response(new Uint8Array([1,2,3,4]));
 await assert.rejects(firmware.loadFirmware(badAssets),/integrity check/);
 assert.equal(factoryCalls,0);assert.equal(rig.writes.length,0);assert.equal(rig.disconnects,0);
 checks.push('manifest layout and downloaded SHA-256 corruption are rejected before loader or board interaction');
}

// Device and security gates precede backup reads and every write.
for(const [options,pattern] of [
 [{chip:'ESP32'},/original ESP32-S3/],
 [{stub:false},/original ESP32-S3/],
 [{flashId:0x160000},/16 MB flash/],
 [{security:1<<20},/security settings/],
 [{crypt:1<<18},/security settings/],
]){
 const rig=new FakeRig(options);await assert.rejects(prepared(rig),pattern);assert.equal(rig.reads.length,0);assert.equal(rig.writes.length,0);assert.equal(rig.disconnects,1);
}
checks.push('wrong chip, missing stub, wrong flash size, secure boot, and flash encryption are denied before backup or writes');

// It takes one exact-size local backup and checks the existing partition table.
{
 const rig=new FakeRig();const session=await prepared(rig);
 assert.deepEqual(rig.reads,[{address:0,size:manifest.backupSize}]);assert.equal(session.backup.length,manifest.backupSize);
 await assert.rejects(session.install(false,()=>{}),/Save the backup/);assert.equal(rig.writes.length,0);
 await session.close();assert.equal(rig.disconnects,1);
 const short=new FakeRig({backupLength:manifest.backupSize-1});await assert.rejects(prepared(short),/backup was incomplete/);assert.equal(short.writes.length,0);assert.equal(short.disconnects,1);
 const wrongLayout=partitionBackup();wrongLayout[0x8000]=0;const mismatch=new FakeRig({backup:wrongLayout});await assert.rejects(prepared(mismatch),/different flash layout/);assert.equal(mismatch.writes.length,0);
 checks.push('a full backup is read before installation, explicit backup acknowledgement gates writes, and incompatible layouts are rejected');
}

// Install preserves flash geometry and verifies each image with the MD5 supplied to esptool.
{
 const rig=new FakeRig(),session=await prepared(rig);await session.install(true,value=>progress.push(value));
 assert.equal(rig.writes.length,3);assert.deepEqual(rig.writes.map(write=>write.fileArray[0].address),addresses);
 for(let i=0;i<rig.writes.length;i++){
  const options=rig.writes[i];assert.equal(options.flashMode,'keep');assert.equal(options.flashFreq,'keep');assert.equal(options.flashSize,'keep');assert.equal(options.eraseAll,false);assert.equal(options.compress,true);
  assert.equal(rig.callbackHashes[i],pkg.files[i].md5);assert.equal(options.calculateMD5Hash(pkg.files[i].data),pkg.files[i].md5);
 }
 assert.deepEqual(rig.afterCalls,['hard_reset']);assert.equal(rig.disconnects,1);assert.equal(progress.at(-1).phase,'done');
 checks.push('flash writes keep mode, frequency, and size, never erase all, verify MD5, reset, and release the transport');
}

// A flash write failure still closes the USB transport, and an already closed session cannot write.
{
 const rig=new FakeRig(),session=await prepared(rig);rig.loader.writeFlash=async()=>{throw new Error('simulated unplug');};
 await assert.rejects(session.install(true,()=>{}),/simulated unplug/);assert.equal(rig.disconnects,1);await session.close();assert.equal(rig.disconnects,1);
 await assert.rejects(session.install(true,()=>{}),/Reconnect the ESP32/);assert.equal(rig.writes.length,0);
 checks.push('failed flash and cancellation cleanup release the transport and prevent a later write');
}

console.log(`PASS ${checks.length} firmware installer checks\n- ${checks.join('\n- ')}`);
