export type Room = {id:string;state:"waiting"|"pending"|"paired";clientType?:"phone"|"esp32"|"esp32_wifi";code:string|null;createdAt:number;expiresAt:number;updatedAt:number};
export type Recording = {id:string;roomId:string;clientType?:"phone"|"esp32"|"esp32_wifi";state:"receiving"|"processing"|"ready"|"interrupted";chunks:number;duration:number;createdAt:number;updatedAt:number;transcript:string|null;errorCode:string|null;audioUrl:string|null};
export type VoiceStatus = {transcriptionConfigured:boolean;maxSeconds:number};
export class ApiError extends Error {constructor(message:string,readonly status:number){super(message);}}
export async function voiceApi<T>(path:string, data?:unknown, signal?:AbortSignal):Promise<T>{
  const response=await fetch(`/api/voice/${path}`,{method:data===undefined?"GET":"POST",credentials:"same-origin",cache:"no-store",headers:data===undefined?{}:{"Content-Type":"application/json","X-Parse-Voice":"1"},body:data===undefined?undefined:JSON.stringify(data),signal:signal??AbortSignal.timeout(60_000)});
  const value=await response.json() as {error?:string};if(!response.ok)throw new ApiError(value.error||"The connection is temporarily unavailable.",response.status);return value as T;
}
export function errorText(error:unknown){return error instanceof ApiError?error.message:"The connection was interrupted. Keep this page open and try again.";}
export function wavBlob(samples:Int16Array){
  const bytes=new Uint8Array(44+samples.length*2),view=new DataView(bytes.buffer);
  for(const [at,tag] of [[0,"RIFF"],[8,"WAVE"],[12,"fmt "],[36,"data"]] as const)for(let i=0;i<tag.length;i++)bytes[at+i]=tag.charCodeAt(i);
  view.setUint32(4,bytes.length-8,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,samples[i],true);
  return new Blob([bytes],{type:"audio/wav"});
}
export async function uploadChunk(id:string,sequence:number,blob:Blob){
  for(let attempt=0;attempt<2;attempt++){
    try{const response=await fetch(`/api/voice/phone/recordings/${id}/chunks/${sequence}`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"audio/wav","X-Parse-Voice":"1"},body:blob,signal:AbortSignal.timeout(12_000)});if(!response.ok){const value=await response.json() as {error?:string};throw new ApiError(value.error||"The audio could not be sent.",response.status);}return;}
    catch(error){if(attempt||error instanceof ApiError&&error.status<500)throw error;}
  }
}

export class PhoneRecorder {
  private source:MediaStreamAudioSourceNode|null=null;
  private worklet:AudioWorkletNode|null=null;
  private silent:GainNode|null=null;
  private flushDone:(()=>void)|null=null;
  private ended=false;
  private stopPromise:Promise<void>|null=null;
  private constructor(private context:AudioContext,private stream:MediaStream){}
  static async open(){
    if(!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode)throw new Error("Open this page in Safari on iPhone or Chrome on Android to use its microphone.");
    const context=new AudioContext();
    try{await context.resume();const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});const recorder=new PhoneRecorder(context,stream);try{await context.audioWorklet.addModule("/pcm-worklet.js");}catch(error){recorder.abort();throw error;}return recorder;}
    catch(error){void context.close().catch(()=>{});throw error;}
  }
  start(onChunk:(samples:Int16Array)=>void,onProgress:(seconds:number,level:number)=>void,onLimit:()=>void,onError:()=>void){
    this.worklet=new AudioWorkletNode(this.context,"parse-pcm",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
    this.worklet.port.onmessage=event=>{const message=event.data;if(message.type==="chunk")onChunk(new Int16Array(message.buffer));else if(message.type==="progress")onProgress(message.seconds,message.level);else if(message.type==="flushed")this.flushDone?.();else if(message.type==="limit")onLimit();};
    this.worklet.onprocessorerror=onError;
    this.source=this.context.createMediaStreamSource(this.stream);this.silent=this.context.createGain();this.silent.gain.value=0;this.source.connect(this.worklet);this.worklet.connect(this.silent);this.silent.connect(this.context.destination);
    this.stream.getAudioTracks().forEach(track=>track.onended=()=>{if(!this.ended)onError();});
  }
  stop(){
    if(this.stopPromise)return this.stopPromise;
    this.ended=true;this.source?.disconnect();this.stream.getTracks().forEach(track=>track.stop());
    this.stopPromise=(async()=>{if(this.worklet){await new Promise<void>(resolve=>{const timer=window.setTimeout(resolve,600);this.flushDone=()=>{window.clearTimeout(timer);resolve();};this.worklet!.port.postMessage({type:"flush"});});this.worklet.disconnect();this.worklet.port.close();}this.silent?.disconnect();await this.context.close();})();return this.stopPromise;
  }
  abort(){void this.stop();}
}

export class LiveReceiver {
  private context=new AudioContext();
  private cursor=new Map<string,number>();
  private sources=new Set<AudioBufferSourceNode>();
  private nextTime=0;
  private stopped=false;
  private started=Date.now();
  private signal=new AbortController();
  private chain:Promise<void>=Promise.resolve();
  async enable(){await this.context.resume();}
  receive(records:Recording[]){
    this.chain=this.chain.then(async()=>{
      for(const record of [...records].sort((a,b)=>a.createdAt-b.createdAt)){
        if(this.stopped)return;
        if(record.createdAt<this.started-2000&&!this.cursor.has(record.id)&&record.state!=="receiving")continue;
        if(record.state==="interrupted"){this.stop();throw new Error("The phone stopped sending audio.");}
        const after=this.cursor.get(record.id)??-1;
        if(record.chunks<=after+1)continue;
        const value=await voiceApi<{chunks:{sequence:number;url:string}[]}>(`recordings/${record.id}/chunks?after=${after}`,undefined,this.signal.signal);
        for(const chunk of value.chunks){
          const response=await fetch(chunk.url,{credentials:"same-origin",cache:"no-store",signal:this.signal.signal});if(!response.ok)throw new Error("Live audio was interrupted.");
          const decoded=await this.context.decodeAudioData(await response.arrayBuffer());if(this.stopped)return;
          const source=this.context.createBufferSource();source.buffer=decoded;source.connect(this.context.destination);source.onended=()=>this.sources.delete(source);this.sources.add(source);
          const at=Math.max(this.context.currentTime+.08,this.nextTime);source.start(at);this.nextTime=at+decoded.duration;this.cursor.set(record.id,chunk.sequence);
        }
      }
    });return this.chain;
  }
  stop(){if(this.stopped)return;this.stopped=true;this.signal.abort();for(const source of this.sources){try{source.stop();}catch{}}this.sources.clear();void this.context.close();}
}
