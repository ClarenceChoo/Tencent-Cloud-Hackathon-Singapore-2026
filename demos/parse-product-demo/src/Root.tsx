import './index.css';
import {Composition,Folder} from 'remotion';
import {ProductDemo,durationInFrames,scenes} from './Composition';
import {CompanionStory,storyDuration,storyScenes} from './story/Composition';
export const RemotionRoot:React.FC=()=> <>
 <Composition id="ParseCompanionStory" component={CompanionStory} durationInFrames={storyDuration} fps={30} width={1920} height={1080}/>
 <Folder name="CompanionStoryScenes">{storyScenes.map(scene=><Composition key={scene.id} id={scene.id} component={scene.component} durationInFrames={scene.frames} fps={30} width={1920} height={1080}/>)}</Folder>
 <Composition id="ParseProductDemo" component={ProductDemo} durationInFrames={durationInFrames} fps={30} width={1920} height={1080}/>
 <Folder name="Scenes">{scenes.map(scene=><Composition key={scene.id} id={scene.id} component={scene.component} durationInFrames={scene.frames} fps={30} width={1920} height={1080}/>)}</Folder>
</>;
