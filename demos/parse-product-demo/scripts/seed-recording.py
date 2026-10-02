"""Create only fictional accounts in the isolated product-recording database."""
import os
import sys
from pathlib import Path
REPO=Path(os.environ.get('PARSE_REPO_DIR', Path(__file__).resolve().parents[3])).resolve()
sys.path.insert(0,str(REPO/'backend'))
from app.database import Database
from app.models import User,Patient,AccessGrant
from app.security import hash_password
from sqlalchemy import select
path=Path(__file__).resolve().parents[1]/'runtime/recording.db'
path.parent.mkdir(parents=True,exist_ok=True)
db=Database(f'sqlite:///{path}')
db.create_all()
with db.SessionLocal() as s:
    if s.scalar(select(User)):
        print('Recording accounts already exist.')
        raise SystemExit(0)
    owner=User(id='demo-owner',name='Alex Tan',email='owner@parse.invalid',role='owner',password_hash=hash_password('fictional-demo-only'))
    caregiver=User(id='demo-caregiver',name='Jamie Lim',email='caregiver@parse.invalid',role='caregiver',password_hash=hash_password('fictional-demo-only'))
    patient=Patient(id='demo-mei',name='Mei Tan',preferred_name='Mei',timezone='Asia/Singapore',language='en')
    s.add_all([owner,caregiver,patient]);s.flush()
    s.add_all([AccessGrant(user_id=owner.id,patient_id=patient.id,relationship='owner',scopes=['*']),AccessGrant(user_id=caregiver.id,patient_id=patient.id,relationship='caregiver',scopes=['read:dashboard','read:medications','read:measurements','read:preventive','ack:support','resolve:support','write:care'])]);s.commit()
print('Created isolated fictional recording accounts. Existing Parse data is untouched.')
