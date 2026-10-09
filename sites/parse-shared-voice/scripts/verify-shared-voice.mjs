import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import vm from "node:vm";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {Miniflare} from "miniflare";

// Isolated local storage and synthetic tones; no microphone or real API key.
const root=new URL("../",import.meta.url);
const compiled=await build({entryPoints:[fileURLToPath(new URL("app/voice-backend.ts",root))],bundle:true,write:false,format:"esm",target:"es2022"});
const {serveVoice,wave}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('test')}}",compatibilityDate:"2026-05-15",d1Databases:["DB"],r2Buckets:["BUCKET"],host:"127.0.0.1",port:0});
const checks=[];
try{
  const DB=await mf.getD1Database("DB"),BUCKET=await mf.getR2Bucket("BUCKET"),bindings={DB,BUCKET};
  for(const name of (await readdir(new URL("drizzle/",root))).filter(name=>name.endsWith(".sql")).sort())for(const sql of (await readFile(new URL(`drizzle/${name}`,root),"utf8")).split("--> statement-breakpoint")){if(sql.trim())await DB.prepare(sql).run();}
  const origin="https://private-demo.example";
  async function request(path,{user="owner",data,cookie,bytes,originHeader=origin}={}){
    const headers=new Headers();let body;
    if(data!==undefined){body=JSON.stringify(data);headers.set("Content-Type","application/json");}
    if(bytes){body=bytes;headers.set("Content-Type","audio/wav");}
    if(body){headers.set("Origin",originHeader);headers.set("X-Parse-Voice","1");}if(cookie)headers.set("Cookie",cookie);
    return serveVoice(new Request(`${origin}/api/voice/${path}`,{method:body?"POST":"GET",headers,body}),user,bindings);
  }
  async function value(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  assert.equal((await request("rooms",{user:null})).status,401);
  assert.equal((await request("rooms",{data:{},originHeader:"https://outside.example"})).status,403);
  checks.push("Unauthenticated requests and cross-site writes are rejected.");
  const pairing=await value(await request("rooms",{data:{}}),201),room=pairing.room.id;
  const token=new URL(pairing.phonePath,origin).hash.slice(6);
  assert.equal((await request(`rooms/${room}/claim`,{data:{token:"a".repeat(64)}})).status,409);
  const claim=await request(`rooms/${room}/claim`,{data:{token}}),cookie=claim.headers.get("Set-Cookie").split(";")[0],claimed=await value(claim,201);
  assert.match(claim.headers.get("Set-Cookie"),/HttpOnly; SameSite=Strict/);assert.match(claim.headers.get("Set-Cookie"),/Secure/);
  assert.equal((await request(`rooms/${room}/claim`,{data:{token}})).status,409);
  assert.equal((await request("recordings",{data:{roomId:room},cookie})).status,403);
  assert.equal((await request(`rooms/${room}/approve`,{data:{code:"wrong"}})).status,409);
  await value(await request(`rooms/${room}/approve`,{data:{code:claimed.room.code}}));
  assert.equal((await request(`rooms/${room}`,{user:"someone-else"})).status,404);
  checks.push("Single-use QR claim, code approval, private cookie and owner checks pass.");
  const starts=await Promise.all([request("recordings",{data:{roomId:room},cookie}),request("recordings",{data:{roomId:room},cookie})]);assert.deepEqual(starts.map(response=>response.status).sort(),[201,409]);
  const recording=(await value(starts.find(response=>response.status===201),201)).recording.id;
  const audio=new Uint8Array(32000),view=new DataView(audio.buffer);for(let i=0;i<16000;i++)view.setInt16(i*2,Math.round(Math.sin(i*2*Math.PI*440/16000)*8000),true);const chunk=wave(audio);
  assert.equal((await request(`recordings/${recording}/chunks/1`,{bytes:chunk,cookie})).status,409);
  await value(await request(`recordings/${recording}/chunks/0`,{bytes:chunk,cookie}));
  // A separate laptop request reads sound while the phone recording is unfinished.
  const live=await value(await request(`recordings/${recording}/chunks?after=-1`));assert.equal(live.state,"receiving");assert.equal(live.chunks.length,1);
  const sound=await request(`recordings/${recording}/audio/0`);assert.deepEqual(new Uint8Array(await sound.arrayBuffer()),chunk);
  assert.equal((await request(`recordings/${recording}/audio/0`,{user:"someone-else"})).status,404);
  assert.equal((await request(`recordings/${recording}/audio/0`,{user:null})).status,401);
  checks.push("The laptop retrieves exact live audio before Stop; other accounts cannot read it.");
  const duplicate=await value(await request(`recordings/${recording}/chunks/0`,{bytes:chunk,cookie}));assert.equal(duplicate.reused,true);
  const different=chunk.slice();different[50]^=1;assert.equal((await request(`recordings/${recording}/chunks/0`,{bytes:different,cookie})).status,409);
  assert.equal((await value(await request(`recordings/${recording}`))).recording.duration,1);
  await value(await request(`recordings/${recording}/chunks/1`,{bytes:chunk,cookie}));
  assert.equal((await request(`recordings/${recording}/finish`,{data:{chunks:1},cookie})).status,409);
  const finished=await value(await request(`recordings/${recording}/finish`,{data:{chunks:2},cookie}));assert.equal(finished.recording.state,"ready");assert.equal(finished.recording.duration,2);assert.equal(finished.recording.transcript,null);assert.equal(finished.transcriptionConfigured,false);
  const full=await request(`recordings/${recording}/audio`),expected=new Uint8Array(64000);expected.set(audio);expected.set(audio,32000);assert.deepEqual(new Uint8Array(await full.arrayBuffer()),wave(expected));
  assert.equal((await value(await request(`recordings/${recording}/finish`,{data:{chunks:2},cookie}))).reused,true);
  checks.push("Ordered upload, exact duplicate retry and complete audio assembly pass; absent transcription is reported honestly.");
  const interrupted=(await value(await request("recordings",{data:{roomId:room},cookie}),201)).recording.id;
  await value(await request(`rooms/${room}/revoke`,{data:{}}));
  assert.equal((await request(`recordings/${interrupted}/chunks/0`,{bytes:chunk,cookie})).status,410);
  assert.equal((await value(await request(`recordings/${interrupted}`))).recording.state,"interrupted");
  checks.push("Disconnect immediately blocks more phone audio and marks unfinished recordings interrupted.");
  for(const sampleRate of [44100,48000]){
    const messages=[];let Processor;
    const context=vm.createContext({AudioWorkletProcessor:class {port={postMessage:message=>messages.push(message),onmessage:null};},sampleRate,Int16Array,Math,registerProcessor:(_,type)=>Processor=type});
    vm.runInContext(await readFile(new URL("public/pcm-worklet.js",root),"utf8"),context);const processor=new Processor();
    for(let second=0;second<20;second++)for(let at=0;at<sampleRate;at+=128){const input=new Float32Array(Math.min(128,sampleRate-at));input.fill(.25);processor.process([[input]]);}
    const chunks=messages.filter(message=>message.type==="chunk");assert.equal(chunks.length,20);assert.equal(chunks.reduce((sum,chunk)=>sum+chunk.buffer.byteLength/2,0),320000);assert.equal(messages.filter(message=>message.type==="limit").length,1);
    processor.port.onmessage({data:{type:"flush"}});assert.equal(messages.filter(message=>message.type==="flushed").length,1);
  }
  checks.push("The microphone processor emits 1-second PCM chunks at both common iPhone sample rates and stops at 20 seconds.");
  console.log(JSON.stringify({passed:true,checks},null,2));
}finally{await mf.dispose();}
