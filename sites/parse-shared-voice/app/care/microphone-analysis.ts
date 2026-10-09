export function spectrum(samples:Float32Array,start:number,size=512){
  const real=new Float64Array(size),imag=new Float64Array(size);
  for(let i=0;i<size;i++)real[i]=(samples[start+i]??0)*(.5-.5*Math.cos(2*Math.PI*i/(size-1)));
  for(let i=1,j=0;i<size;i++){let bit=size>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)[real[i],real[j]]=[real[j],real[i]];}
  for(let length=2;length<=size;length*=2){const angle=-2*Math.PI/length;
    for(let base=0;base<size;base+=length)for(let k=0;k<length/2;k++){
      const c=Math.cos(angle*k),s=Math.sin(angle*k),a=base+k,b=a+length/2;
      const r=c*real[b]-s*imag[b],im=s*real[b]+c*imag[b];
      real[b]=real[a]-r;imag[b]=imag[a]-im;real[a]+=r;imag[a]+=im;
    }
  }
  return Float32Array.from({length:size/2},(_,i)=>20*Math.log10(Math.max(1e-8,Math.hypot(real[i],imag[i])*4/size)));
}
export function readMicrophoneWave(buffer:ArrayBuffer){
  const view=new DataView(buffer),tag=(at:number)=>String.fromCharCode(...new Uint8Array(buffer,at,4));
  if(buffer.byteLength<46||tag(0)!=='RIFF'||tag(8)!=='WAVE'||tag(12)!=='fmt '||view.getUint32(16,true)!==16||view.getUint16(20,true)!==1||view.getUint16(22,true)!==1||view.getUint32(24,true)!==16000||view.getUint16(34,true)!==16||tag(36)!=='data'||view.getUint32(40,true)!==buffer.byteLength-44)throw new Error('This recording cannot be displayed as microphone PCM.');
  const samples=new Float32Array((buffer.byteLength-44)/2);let mean=0,peak=0,clipped=0;
  for(let i=0;i<samples.length;i++){const value=view.getInt16(44+i*2,true);samples[i]=value/32768;mean+=samples[i];peak=Math.max(peak,Math.abs(samples[i]));if(Math.abs(value)>=32767)clipped++;}
  mean/=samples.length;let power=0;for(let i=0;i<samples.length;i++){samples[i]-=mean;power+=samples[i]**2;}
  const db=(value:number)=>20*Math.log10(Math.max(value,1e-8));
  return {samples,seconds:samples.length/16000,rmsDb:db(Math.sqrt(power/samples.length)),peakDb:db(peak),clipped};
}
