import {useCurrentFrame} from 'remotion';
import {Base,Photo,Foot,Label,Heading,rise} from './Shared';
export const CaregiverScene=()=>{const f=useCurrentFrame();return <Base><Photo src="caregiver.png"/><div style={{position:'absolute',left:100,top:225,width:770,...rise(f)}}><Label>05 / Her care circle</Label><Heading size={87}>{'Jamie stays\nin the picture.'}</Heading><p style={{fontSize:30,lineHeight:1.5,width:630,marginTop:45}}>She sees the updates Mei chooses to share, wherever she is.</p></div><Foot/></Base>};
