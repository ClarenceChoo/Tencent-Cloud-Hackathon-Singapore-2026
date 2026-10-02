import {OffthreadVideo,staticFile,useCurrentFrame} from 'remotion';
import {Base,theme} from './Shared';
import clips from './clips.json';
const titles:Record<string,string>={'caregiver-arrival':'The same note. Already in view.','caregiver-support':'Care continues with a person.','plan':'Keep the daily routine in view.','summary':'Bring the story to the next visit.'};
export const StoryDashboard:React.FC<{id:string}>=({id})=>{const f=useCurrentFrame();const clip=clips.find(c=>c.id===id)!;const text=[...clip.events].reverse().find(e=>f>=e.at*30)?.text;return <Base><div style={{position:'absolute',left:92,right:92,top:40,display:'flex',justifyContent:'space-between',alignItems:'baseline'}}><div style={{fontSize:40,letterSpacing:-1}}>{titles[id]}</div><div style={{fontSize:22,color:theme.accent}}>{id.startsWith('caregiver')?'Jamie’s caregiver view':'Mei’s care record'}</div></div><div style={{position:'absolute',left:92,top:122,width:1736,height:868,border:`1px solid ${theme.line}`,overflow:'hidden',borderRadius:12,boxShadow:'0 8px 24px #34272008'}}><OffthreadVideo muted src={staticFile(`story/${id}.mp4`)} style={{width:'100%',height:'100%',objectFit:'cover'}}/></div><div style={{position:'absolute',left:101,top:1009,fontSize:26,borderLeft:`4px solid ${theme.accent}`,paddingLeft:18}}>{text}</div><div style={{position:'absolute',right:96,bottom:8,fontSize:14,color:theme.muted}}>Working app · Fictional data · Simulated device input</div></Base>};
export const ArrivalScene=()=> <StoryDashboard id="caregiver-arrival"/>;
export const SupportScene=()=> <StoryDashboard id="caregiver-support"/>;
export const PlanScene=()=> <StoryDashboard id="plan"/>;
export const SummaryScene=()=> <StoryDashboard id="summary"/>;
