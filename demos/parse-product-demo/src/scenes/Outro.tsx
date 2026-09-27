import {AbsoluteFill,interpolate,useCurrentFrame} from 'remotion';
import {theme,sans,serif} from '../theme';
export const Outro:React.FC=()=>{const frame=useCurrentFrame();return <AbsoluteFill style={{background:theme.accent,color:theme.paper,fontFamily:sans,justifyContent:'center',alignItems:'center'}}>
  <div style={{opacity:interpolate(frame,[0,20],[0,1],{extrapolateRight:'clamp'}),fontFamily:serif,fontSize:170,letterSpacing:-8}}>Parse</div>
  <div style={{fontFamily:serif,fontSize:58,marginTop:30,letterSpacing:-1}}>Care stays connected.</div>
  <div style={{display:'flex',gap:30,marginTop:60,fontSize:25,color:'#f4ded2'}}><span>Notes</span><span>·</span><span>Routines</span><span>·</span><span>Follow-ups</span></div>
  <div style={{position:'absolute',bottom:95,fontSize:21,color:'#f4ded2'}}>Software demo · Fictional data · Hardware integration comes next</div>
</AbsoluteFill>};
