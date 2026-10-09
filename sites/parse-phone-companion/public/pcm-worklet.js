class ParsePCM extends AudioWorkletProcessor {
  constructor(){super();this.phase=0;this.sum=0;this.count=0;this.chunk=new Int16Array(16000);this.position=0;this.total=0;this.level=0;this.closed=false;this.port.onmessage=event=>{if(event.data.type==="flush"){this.flush();this.closed=true;this.port.postMessage({type:"flushed"});}};}
  flush(){if(this.position){const buffer=this.chunk.slice(0,this.position).buffer;this.port.postMessage({type:"chunk",buffer},[buffer]);this.position=0;}}
  process(inputs){
    if(this.closed)return true;const input=inputs[0]?.[0];if(!input)return true;
    for(const value of input){
      this.sum+=value;this.count++;this.phase+=16000;
      if(this.phase>=sampleRate){this.phase-=sampleRate;const sample=Math.max(-1,Math.min(1,this.sum/this.count));this.sum=0;this.count=0;this.chunk[this.position++]=Math.round(sample*(sample<0?32768:32767));this.total++;this.level=Math.max(this.level,Math.abs(sample));
        if(this.position===16000){this.flush();this.port.postMessage({type:"progress",seconds:this.total/16000,level:this.level});this.level=0;}
        else if(this.total%1600===0){this.port.postMessage({type:"progress",seconds:this.total/16000,level:this.level});this.level=0;}
        if(this.total===320000){this.closed=true;this.port.postMessage({type:"limit"});break;}
      }
    }return true;
  }
}
registerProcessor("parse-pcm",ParsePCM);
