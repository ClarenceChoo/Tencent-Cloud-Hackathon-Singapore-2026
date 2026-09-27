import {useCurrentFrame} from 'remotion';
import {Base,Photo,Foot,Heading,rise} from './Shared';
export const StoryHero=()=>{const f=useCurrentFrame();return <Base><Photo src="mei-pendant.png" dark/><div style={{position:'absolute',left:100,top:235,width:720,color:'#fff9ef',...rise(f)}}><div style={{fontFamily:'Georgia',fontSize:138,letterSpacing:-7,marginBottom:50}}>Parse</div><Heading size={71}>{'A small companion.\nA shared care record.'}</Heading><div style={{fontSize:27,marginTop:40,color:'#e9ddce'}}>A day with Mei and her care circle.</div></div><Foot light/></Base>};
