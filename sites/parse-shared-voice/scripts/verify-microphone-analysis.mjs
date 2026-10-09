import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
async function module(path){const result=await build({entryPoints:[fileURLToPath(new URL(path,import.meta.url))],bundle:true,write:false,format:'esm',target:'es2022'});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);}
const {spectrum,readMicrophoneWave}=await module('../app/care/microphone-analysis.ts'),{wave}=await module('../app/voice-backend.ts');
const pcm=new Uint8Array(32000),view=new DataView(pcm.buffer);
for(let i=0;i<16000;i++)view.setInt16(i*2,Math.round(8192*Math.sin(2*Math.PI*1000*i/16000)),true);
const data=readMicrophoneWave(wave(pcm).buffer),bins=spectrum(data.samples,0);
assert.equal(data.seconds,1);assert(Math.abs(data.rmsDb-(-15.05))<.1);assert.equal(data.clipped,0);
const maximum=bins.indexOf(Math.max(...bins));assert.equal(maximum*16000/512,1000);assert(Math.abs(bins[maximum]+12.04)<.1);
assert.equal(readMicrophoneWave(wave(new Uint8Array(32000)).buffer).rmsDb,-160);
assert.throws(()=>readMicrophoneWave(new ArrayBuffer(8)));
console.log('Microphone analysis: calibrated 1 kHz tone, RMS, silence and malformed audio passed.');
