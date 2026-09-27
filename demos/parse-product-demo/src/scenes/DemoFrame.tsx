import {AbsoluteFill,OffthreadVideo,staticFile,useCurrentFrame,interpolate} from 'remotion';
import {theme,sans} from '../theme';
import clips from '../clips.json';
export const DemoFrame:React.FC<{id:string;number:number}>=({id,number})=>{
 const frame=useCurrentFrame();const clip=clips.find(x=>x.id===id)!;
 const caption=[...clip.events].reverse().find(x=>frame>=Math.floor(x.at*30))?.text || clip.events[0]?.text;
 return <AbsoluteFill style={{background:theme.paper,fontFamily:sans,color:theme.ink}}>
  <div style={{position:'absolute',left:96,top:28,right:96,display:'flex',alignItems:'center',gap:25}}><span style={{fontSize:23,color:theme.accent,fontVariantNumeric:'tabular-nums'}}>{String(number).padStart(2,'0')} / 07</span><span style={{fontSize:37,fontWeight:500,letterSpacing:-1}}>{clip.title}</span><span style={{marginLeft:'auto',fontSize:19,color:theme.muted}}>Software demo · Fictional data</span></div>
  <div style={{position:'absolute',left:96,top:116,width:1728,height:864,overflow:'hidden',border:`1px solid ${theme.line}`,borderRadius:10,boxShadow:'0 10px 26px #34272009'}}>
    <OffthreadVideo muted src={staticFile(`demos/${id}.mp4`)} style={{width:'100%',height:'100%',objectFit:'cover'}}/>
  </div>
  <div style={{position:'absolute',left:103,right:103,top:1003,display:'flex',alignItems:'center',gap:18,fontSize:29,lineHeight:1.2,letterSpacing:-.2}}><span style={{width:4,height:31,background:theme.accent,flexShrink:0}}/>{caption}</div>
  <div style={{position:'absolute',left:0,bottom:0,height:4,background:theme.accent,width:`${interpolate(frame,[0,clip.duration*30],[0,100],{extrapolateRight:'clamp'})}%`}}/>
 </AbsoluteFill>;
};
