import {AbsoluteFill,interpolate,useCurrentFrame,Easing} from 'remotion';
import {theme,sans,serif} from '../theme';
export const Intro:React.FC=()=>{
 const frame=useCurrentFrame();
 return <AbsoluteFill style={{background:theme.paper,color:theme.ink,fontFamily:sans,padding:130}}>
   <div style={{position:'absolute',top:80,left:130,fontSize:21,letterSpacing:3,textTransform:'uppercase',color:theme.muted}}>A closer look</div>
   <div style={{position:'absolute',left:130,top:250,opacity:interpolate(frame,[0,20],[0,1],{extrapolateRight:'clamp'}),translate:`0 ${interpolate(frame,[0,30],[28,0],{extrapolateRight:'clamp',easing:Easing.out(Easing.cubic)})}px`}}>
     <div style={{fontFamily:serif,fontSize:198,letterSpacing:-10,color:theme.accent,lineHeight:1}}>Parse</div>
     <div style={{fontFamily:serif,fontSize:65,lineHeight:1.2,letterSpacing:-1.7,marginTop:35}}>Your everyday<br/>care record.</div>
   </div>
   <div style={{position:'absolute',left:1160,top:270,width:580}}>{['Medication','Care notes','Follow-ups'].map((text,i)=><div key={text} style={{position:'relative',borderBottom:`1px solid ${theme.line}`,padding:'38px 0 38px 60px',fontFamily:serif,fontSize:42,opacity:interpolate(frame,[12+i*7,30+i*7],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}}><span style={{position:'absolute',left:0,top:56,width:14,height:14,borderRadius:'50%',background:theme.accent}}/>{text}</div>)}</div>
   <div style={{position:'absolute',left:130,right:130,bottom:90,borderTop:`1px solid ${theme.line}`,paddingTop:25,display:'flex',justifyContent:'space-between',fontSize:21,color:theme.muted}}><span>A product walkthrough</span><span>Software demo · Fictional data</span></div>
 </AbsoluteFill>
};
