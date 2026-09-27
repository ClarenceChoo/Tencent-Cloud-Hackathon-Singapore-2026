import os
"""Synthetic history for the product film, never applied to the main demo database."""
from pathlib import Path
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
import sys
REPO=Path(os.environ.get('PARSE_REPO_DIR', Path(__file__).resolve().parents[3])).resolve()
sys.path.insert(0,str(REPO/'backend'))
from app.database import Database
from app import models as m
from app.schemas import MedicationPlanCreate
from app.services import create_plan,create_proposal,commit_proposal
from sqlalchemy import select
root=Path(__file__).resolve().parents[1]
db=Database(f'sqlite:///{root}/runtime/recording.db')
local=datetime.now(ZoneInfo('Asia/Singapore'))
def at(h,minute):return local.replace(hour=h,minute=minute,second=0,microsecond=0).astimezone(timezone.utc)
with db.SessionLocal() as s:
    if s.scalar(select(m.MedicationPlanVersion)):
        print('Care story already seeded.');raise SystemExit(0)
    owner=s.get(m.User,'demo-owner')
    plan=create_plan(s,'demo-mei',owner,MedicationPlanCreate(timezone='Asia/Singapore',source='Fictional prescription for product demonstration',checked=True,medicines=[{'id':'morning','name':'Morning medication','instructions':'Take according to the checked morning label.','reviewed_reference':'Follow the recorded label instructions.','reference_source':'Fictional demonstration label'},{'id':'evening','name':'Evening medication','instructions':'Take according to the checked evening label.','reviewed_reference':'Follow the recorded label instructions.','reference_source':'Fictional demonstration label'}],schedule=[{'medicine_id':'morning','local_time':'08:00'},{'medicine_id':'evening','local_time':'20:00'}]))
    s.flush()
    def confirm(kind,payload):
        p=create_proposal(s,'demo-mei',kind,payload,user_id=owner.id)
        return commit_proposal(s,p.id,'demo-mei')
    yesterday=at(8,0)-timedelta(days=1)
    dose=m.DoseInstance(id='demo-morning-yesterday',patient_id='demo-mei',plan_id=plan.id,plan_version=plan.version,medicine_id='morning',medicine_name='Morning medication',scheduled_at=yesterday)
    current=m.DoseInstance(id='demo-morning-today',patient_id='demo-mei',plan_id=plan.id,plan_version=plan.version,medicine_id='morning',medicine_name='Morning medication',scheduled_at=at(8,0))
    s.add_all([dose,current]);s.flush()
    confirm('medication_report',{'dose_instance_id':dose.id,'report_state':'reported_taken','taken_time_text':'After breakfast'})
    dose.report_time=at(8,5)-timedelta(days=1)
    confirm('measurement',{'measurement_type':'blood_pressure','systolic':126,'diastolic':76,'unit':'mmHg','occurred_at':at(8,20).isoformat(),'timezone':'Asia/Singapore','source_description':'Home blood pressure monitor','reporting_actor':'patient'})
    p=confirm('support_request',{'request_text':'Help collect my prescription refill','recipient_user_id':'demo-caregiver','urgency':'routine','barrier_text':'I would like help with the trip to the pharmacy.'})
    s.get(m.SupportRequest,p.record_id).created_at=at(9,10)
    confirm('health_note',{'wording':'Knee discomfort after my morning walk','occurred_at':at(10,24).isoformat(),'timezone':'Asia/Singapore'})
    confirm('preventive_task',{'task_type':'follow-up','description':'Medication review at the clinic','source':'Fictional follow-up care plan','due_date':str((local+timedelta(days=3)).date()),'timezone':'Asia/Singapore','state':'due'})
    confirm('preventive_task',{'task_type':'screening','description':'Discuss the next eye check','source':'Fictional preventive care plan','due_date':str((local+timedelta(days=14)).date()),'timezone':'Asia/Singapore','state':'planned'})
    s.commit()
print('Seeded fictional medication, reading, note, support and care-plan examples.')
