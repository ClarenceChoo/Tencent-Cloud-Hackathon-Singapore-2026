import {AbsoluteFill,OffthreadVideo,staticFile,interpolate,useCurrentFrame} from 'remotion';
import {theme,sans,serif} from '../theme';
export const Mobile:React.FC=()=>{const frame=useCurrentFrame();return <AbsoluteFill style={{background:theme.paper,color:theme.ink,fontFamily:sans}}>
 <div style={{position:'absolute',left:130,top:90,fontSize:23,color:theme.accent}}>07 / 07</div>
 <div style={{position:'absolute',left:130,top:278,width:880,opacity:interpolate(frame,[0,16],[0,1],{extrapolateRight:'clamp'})}}><h1 style={{fontFamily:serif,fontWeight:400,fontSize:91,lineHeight:1.09,letterSpacing:-3,margin:0}}>Care,<br/>within reach.</h1><p style={{fontSize:33,lineHeight:1.5,color:theme.muted,maxWidth:670,marginTop:40}}>The same care record,<br/>ready on your phone.</p><div style={{borderTop:`1px solid ${theme.line}`,paddingTop:30,marginTop:48,width:620,fontSize:23,color:theme.accent}}>Review the day. Check the details.</div></div>
 <div style={{position:'absolute',right:240,top:86,width:416,height:900,border:`8px solid ${theme.ink}`,borderRadius:31,overflow:'hidden',boxShadow:'0 16px 45px #34272014'}}><OffthreadVideo muted src={staticFile('demos/mobile.mp4')} style={{width:'100%',height:'100%',objectFit:'cover'}}/></div>
 <div style={{position:'absolute',left:130,bottom:80,fontSize:20,color:theme.muted}}>Software demo · Fictional data</div>
</AbsoluteFill>};
