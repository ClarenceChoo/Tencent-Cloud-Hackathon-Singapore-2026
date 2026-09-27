from pathlib import Path
import json,subprocess
ROOT=Path(__file__).resolve().parents[1]
(ROOT/'out').mkdir(parents=True,exist_ok=True)
(ROOT/'public/demos').mkdir(parents=True,exist_ok=True)
TARGETS={'timeline':10,'medication':14,'notes':19,'care-plan':11,'support':12,'summary':15,'mobile':8}
takes=json.loads((ROOT/'runtime/takes.json').read_text())
clips=[]
for id,duration in TARGETS.items():
    take=next(t for t in takes if t['id']==id)
    ratio=duration/take['duration']
    crop='crop=390:844:0:0' if id=='mobile' else 'crop=1280:640:0:0'
    dest=ROOT/f'public/demos/{id}.mp4'
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-ss',str(take['start']),'-i',str(ROOT/take['raw']),'-t',str(take['duration']),'-an','-vf',f'{crop},setpts={ratio}*(PTS-STARTPTS),fps=30,tpad=stop_mode=clone:stop_duration=1','-t',str(duration),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(dest)],check=True)
    clips.append({'id':id,'title':take['title'],'duration':duration,'events':[{'at':round(e['at']*ratio,3),'text':e['text']} for e in take['events']]})
    print(f'Prepared {id}: {duration}s',flush=True)
(ROOT/'src/clips.json').write_text(json.dumps(clips,indent=2)+'\n')
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-ss','1','-i',str(ROOT/'public/demos/timeline.mp4'),'-frames:v','1',str(ROOT/'out/timeline-capture.png')],check=True)
