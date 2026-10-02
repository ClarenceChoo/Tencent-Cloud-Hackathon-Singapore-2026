import os
"""Isolated, explicitly simulated pendant data for the Parse concept film."""
from pathlib import Path
import sys, io, wave, hashlib, json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parents[1]
REPO=Path(os.environ.get('PARSE_REPO_DIR', Path(__file__).resolve().parents[3])).resolve()
sys.path.insert(0,str(REPO/'backend'))
RUNTIME=ROOT/'runtime/story'
RUNTIME.mkdir(parents=True,exist_ok=True)
DEVICE_TOKEN='fictional-parse-pendant-film-token'
NOTE='My knee hurts after my morning walk.'

def wav(n):
    b=io.BytesIO()
    with wave.open(b,'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000)
        w.writeframes((n.to_bytes(2,'little',signed=True))*8000)
    return b.getvalue()

def fixtures():
    local=datetime.now(ZoneInfo('Asia/Singapore'))
    content={
      'note':{'intent':'proposal','kind':'health_note','payload':{'wording':NOTE,'symptom':'Knee discomfort','occurrence_text':'after my morning walk','timezone':'Asia/Singapore','share_with_user_ids':['demo-caregiver']},'spoken_text':''},
      'support':{'intent':'proposal','kind':'support_request','payload':{'request_text':'Could you call me this afternoon?','recipient_user_id':'demo-caregiver','urgency':'routine'},'spoken_text':''}
    }
    result={}
    for i,(name,value) in enumerate(content.items(),1):
        audio=wav(i);(RUNTIME/f'{name}.wav').write_bytes(audio)
        result[hashlib.sha256(audio).hexdigest()]='FIXTURE:'+json.dumps(value)
    yes=wav(3);(RUNTIME/'yes.wav').write_bytes(yes)
    result[hashlib.sha256(yes).hexdigest()]='Yes, save that.'
    (RUNTIME/'reply.wav').write_bytes(wav(0))
    return result

def seed():
    from app.database import Database
    from app import models as m
    from app.security import hash_password,sha256
    from app.schemas import MedicationPlanCreate
    from app.services import create_plan,create_proposal,commit_proposal
    db=Database(f'sqlite:///{RUNTIME}/story.db');db.create_all()
    with db.SessionLocal() as s:
        if s.get(m.User,'demo-owner'):return
        now=datetime.now(timezone.utc)
        owner=m.User(id='demo-owner',name='Mei Tan',email='owner@parse.invalid',role='owner',password_hash=hash_password('fictional-demo-only'))
        caregiver=m.User(id='demo-caregiver',name='Jamie Lim',email='caregiver@parse.invalid',role='caregiver',password_hash=hash_password('fictional-demo-only'))
        patient=m.Patient(id='demo-mei',name='Mei Tan',preferred_name='Mei',timezone='Asia/Singapore',language='en')
        s.add_all([owner,caregiver,patient]);s.flush()
        s.add_all([m.AccessGrant(user_id=owner.id,patient_id=patient.id,relationship='owner',scopes=['*']),m.AccessGrant(user_id=caregiver.id,patient_id=patient.id,relationship='caregiver',scopes=['read:dashboard','read:medications','read:measurements','read:preventive','ack:support','resolve:support','write:care'])])
        s.add(m.Device(id='film-pendant',credential_hash=sha256(DEVICE_TOKEN),patient_id=patient.id,claimed_at=now,firmware_version='simulated-film',capabilities=['audio'],battery_mv=3980))
        s.flush()
        create_plan(s,patient.id,owner,MedicationPlanCreate(timezone='Asia/Singapore',source='Fictional checked label for product film',checked=True,medicines=[{'id':'morning','name':'Morning medication','instructions':'Follow the checked morning medication label.','reviewed_reference':'Follow the recorded label instructions.','reference_source':'Fictional demonstration label'},{'id':'evening','name':'Evening medication','instructions':'Follow the checked evening medication label.','reviewed_reference':'Follow the recorded label instructions.','reference_source':'Fictional demonstration label'}],schedule=[{'medicine_id':'morning','local_time':'08:00'},{'medicine_id':'evening','local_time':'20:00'}]))
        p=create_proposal(s,patient.id,'preventive_task',{'task_type':'follow-up','description':'Medication review at the clinic','source':'Fictional follow-up plan','due_date':str((now+timedelta(days=3)).date()),'timezone':'Asia/Singapore','state':'planned'},user_id=owner.id)
        commit_proposal(s,p.id,patient.id);s.commit()
    print('Isolated story accounts and pendant fixture ready.')

if __name__=='__main__':
    seed();fixtures()
