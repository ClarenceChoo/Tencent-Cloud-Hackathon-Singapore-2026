"use client";
import {useEffect,useRef,useState} from 'react';
import {readMicrophoneWave,spectrum} from './microphone-analysis';

export default function MicrophoneVisual({audioUrl}:{audioUrl:string|null}){
  const spectrogram=useRef<HTMLCanvasElement>(null),waveform=useRef<HTMLCanvasElement>(null);
  const [stats,setStats]=useState<ReturnType<typeof readMicrophoneWave>|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    setStats(null);setError('');if(!audioUrl)return;
    const controller=new AbortController();
    void (async()=>{try{
      const response=await fetch(audioUrl,{credentials:'same-origin',cache:'no-store',signal:controller.signal});if(!response.ok)throw new Error('The microphone audio is unavailable.');
      const data=readMicrophoneWave(await response.arrayBuffer());if(controller.signal.aborted)return;setStats(data);
      const canvas=spectrogram.current,trace=waveform.current;if(!canvas||!trace)return;
      const context=canvas.getContext('2d'),line=trace.getContext('2d');if(!context||!line)return;
      const width=canvas.width,height=canvas.height,left=48,top=12,plotW=width-left-16,plotH=height-top-30;
      context.fillStyle='#102536';context.fillRect(0,0,width,height);
      const columns=300;
      for(let x=0;x<columns;x++){
        const bins=spectrum(data.samples,Math.round(x*Math.max(0,data.samples.length-512)/(columns-1)));
        for(let y=1;y<bins.length;y++){
          const value=Math.max(0,Math.min(1,(bins[y]+95)/75));
          context.fillStyle=`hsl(${222-value*176} ${35+value*55}% ${10+value*57}%)`;
          context.fillRect(left+x*plotW/columns,top+plotH-y*plotH/256,Math.ceil(plotW/columns)+1,Math.ceil(plotH/256)+1);
        }
      }
      context.fillStyle='#d5e6f1';context.font='13px system-ui';
      for(const khz of [0,2,4,6,8])context.fillText(`${khz}k`,8,top+plotH-khz*plotH/8+4);
      for(let i=0;i<=6;i++)context.fillText(`${(data.seconds*i/6).toFixed(1)}s`,left+i*(plotW-22)/6,height-7);
      line.fillStyle='#102536';line.fillRect(0,0,trace.width,trace.height);line.strokeStyle='#254557';line.beginPath();line.moveTo(left,trace.height/2);line.lineTo(width-16,trace.height/2);line.stroke();
      const peak=Math.max(0.0001,...Array.from(data.samples.subarray(0,512)).map(Math.abs));
      let max=peak;for(const value of data.samples)max=Math.max(max,Math.abs(value));
      line.strokeStyle='#63d7ce';line.beginPath();
      for(let x=0;x<plotW;x++){const begin=Math.floor(x*data.samples.length/plotW),end=Math.max(begin+1,Math.floor((x+1)*data.samples.length/plotW));let lo=0,hi=0;for(let i=begin;i<end;i++){lo=Math.min(lo,data.samples[i]);hi=Math.max(hi,data.samples[i]);}line.moveTo(left+x,trace.height/2-lo/max*43);line.lineTo(left+x,trace.height/2-hi/max*43);}line.stroke();
    }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'Could not display microphone audio.');}})();
    return()=>controller.abort();
  },[audioUrl]);
  return <div className="esp-signal">
    <div className="esp-section-title"><h3>Microphone signal</h3><span>Latest recorded clip</span></div>
    {!audioUrl&&<div className="esp-signal-empty">Record a clip to see what the INMP441 microphone hears.</div>}
    <div hidden={!audioUrl}><canvas ref={spectrogram} width={960} height={240} role="img" aria-label="Spectrogram of the recorded microphone audio, from zero to eight kilohertz"/><div className="esp-spectrum-key"><span>Frequency over time · 512-sample FFT</span><span>Quiet <i/> Loud</span></div><canvas ref={waveform} width={960} height={110} role="img" aria-label="Microphone waveform with amplitude scaled for visibility"/></div>
    {stats&&<><div className="esp-metrics"><span><b>{stats.seconds.toFixed(1)} s</b>Duration</span><span><b>{stats.rmsDb.toFixed(1)} dBFS</b>Average level</span><span><b>{stats.peakDb.toFixed(1)} dBFS</b>Peak</span><span><b>{stats.clipped}</b>Clipped samples</span></div><p className="esp-caption">The waveform is scaled for visibility. Levels use the original microphone signal. The spectrogram appears after the clip transfers.</p></>}
    {audioUrl&&!stats&&!error&&<p role="status">Loading microphone signal…</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </div>;
}
