import os,sys,socket,subprocess,signal,time
from pathlib import Path
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[1]
REPO=Path(os.environ.get('PARSE_REPO_DIR', Path(__file__).resolve().parents[3])).resolve()
for port in (8002,5174):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',port))
env={**os.environ,'CARELOOP_DATABASE_URL':f'sqlite:///{ROOT}/runtime/recording.db','CARELOOP_ALLOWED_ORIGINS':'http://127.0.0.1:5174','CARELOOP_COOKIE_SECURE':'false','CARELOOP_PROVIDER':'unconfigured','CARELOOP_SCHEDULER_ENABLED':'false','CARELOOP_TESTING':'false','CARELOOP_ADMIN_ENABLED':'false','CARELOOP_DEVELOPMENT_SEED':'false','CARELOOP_API_TARGET':'http://127.0.0.1:8002','VITE_DEMO_MODE':'true'}
(ROOT/'runtime').mkdir(parents=True,exist_ok=True)
children=[];logs=[]
def stop(*_): raise KeyboardInterrupt
signal.signal(signal.SIGTERM,stop)
try:
    for name,cmd,cwd in [('api',[str(REPO/'backend/.venv/bin/python'),'-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8002','--no-access-log'],REPO/'backend'),('web',['npm','run','dev','--','--port','5174','--strictPort'],REPO/'frontend')]:
        log=open(ROOT/f'runtime/{name}.log','w');logs.append(log)
        children.append(subprocess.Popen(cmd,cwd=cwd,env=env,stdout=log,stderr=log,start_new_session=True))
    for _ in range(60):
        try:
            urlopen('http://127.0.0.1:8002/healthz',timeout=1)
            urlopen('http://127.0.0.1:5174',timeout=1)
            break
        except OSError: time.sleep(.5)
    print('Isolated recording workspace ready: http://127.0.0.1:5174',flush=True)
    while all(p.poll() is None for p in children): time.sleep(.5)
except KeyboardInterrupt: pass
finally:
    for p in children:
        if p.poll() is None: os.killpg(p.pid,signal.SIGTERM)
    for log in logs: log.close()
