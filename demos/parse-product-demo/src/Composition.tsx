import {TransitionSeries,linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {Intro} from './scenes/Intro';
import {Timeline} from './scenes/Timeline';
import {Medication} from './scenes/Medication';
import {Notes} from './scenes/Notes';
import {CarePlan} from './scenes/CarePlan';
import {Support} from './scenes/Support';
import {Summary} from './scenes/Summary';
import {Mobile} from './scenes/Mobile';
import {Outro} from './scenes/Outro';
export const scenes=[{id:'Intro',component:Intro,frames:120},{id:'Timeline',component:Timeline,frames:300},{id:'Medication',component:Medication,frames:420},{id:'Notes',component:Notes,frames:570},{id:'CarePlan',component:CarePlan,frames:330},{id:'Support',component:Support,frames:360},{id:'Summary',component:Summary,frames:450},{id:'Mobile',component:Mobile,frames:240},{id:'Outro',component:Outro,frames:120}];
export const durationInFrames=scenes.reduce((sum,scene)=>sum+scene.frames,0)-(scenes.length-1)*12;
export const ProductDemo:React.FC=()=> <TransitionSeries>{scenes.flatMap((scene,i)=>[
 ...(i?[<TransitionSeries.Transition key={`transition-${scene.id}`} presentation={fade()} timing={linearTiming({durationInFrames:12})}/>]:[]),
 <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.frames}><scene.component/></TransitionSeries.Sequence>
])}</TransitionSeries>;
