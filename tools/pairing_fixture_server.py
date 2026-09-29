#!/usr/bin/env python3
"""Disposable loopback pairing/voice-fixture server. Never a production entry point."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True, help='A NEW directory under runtime')
    parser.add_argument('--port', type=int, default=8002)
    parser.add_argument('--web-port', type=int, default=5174)
    args=parser.parse_args()
    directory=args.data_dir.resolve()
    if not directory.is_relative_to(ROOT / 'runtime'):
        raise SystemExit('Use a fresh directory under this repository’s ignored runtime folder.')
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.environ.update(CARELOOP_PROVIDER='fixture', CARELOOP_TESTING='true', CARELOOP_FIXTURE_REPLY_WAV=str(directory/'reply.wav'))
    from app.config import Settings
    from app.main import create_app
    from app.models import User, Patient, AccessGrant
    from app.security import hash_password
    from app.provisioning import prepare_device, private_file
    import uvicorn
    settings=Settings(database_url='sqlite:///'+str(directory/'fixture.db'), cookie_secure=False,
                      testing=True, development_seed=False, scheduler_enabled=False,
                      allowed_origins=['http://127.0.0.1:%d'%args.web_port], public_base_url='https://parse.example')
    app=create_app(settings); app.state.db.create_all()
    with app.state.db.SessionLocal() as db:
        owner=User(name='Fictional Alex Tan',email='owner@careloop.invalid',role='owner',password_hash=hash_password('fictional-demo-only'))
        caregiver=User(name='Fictional Jamie Lim',email='caregiver@careloop.invalid',role='caregiver',password_hash=hash_password('fictional-caregiver-only'))
        patient=Patient(name='Fictional Mei Tan',preferred_name='Mei',timezone='Asia/Singapore',language='en')
        db.add_all([owner,caregiver,patient]);db.flush()
        db.add_all([AccessGrant(user_id=owner.id,patient_id=patient.id,relationship='owner',scopes=['*']),AccessGrant(user_id=caregiver.id,patient_id=patient.id,relationship='caregiver',scopes=['read:dashboard'])]);db.commit()
        device_id=prepare_device(db,str(directory/'device'),'https://parse.example')
        caregiver_id=caregiver.id
    wording='Fictional bench note: my knee felt sore after this morning’s walk.'
    for index,name in enumerate(['note','confirm','reply']):
        buffer=io.BytesIO()
        with wave.open(buffer,'wb') as out:
            out.setnchannels(1);out.setsampwidth(2);out.setframerate(16000)
            out.writeframes(index.to_bytes(2,'little')*6400)
        audio=buffer.getvalue();(directory/(name+'.wav')).write_bytes(audio)
        transcript=('FIXTURE:'+json.dumps({'intent':'proposal','kind':'health_note','payload':{'wording':wording,'share_with_user_ids':[caregiver_id]},'spoken_text':''})) if name=='note' else 'yes save that'
        app.state.fixture_transcripts[hashlib.sha256(audio).hexdigest()]=transcript
    private_file(directory/'browser.json',json.dumps({'device_id':device_id,'wording':wording}))
    print('Fictional pairing server ready. Private files are in the supplied runtime directory.',flush=True)
    uvicorn.run(app,host='127.0.0.1',port=args.port,log_level='warning',access_log=False)


if __name__=='__main__':
    main()
