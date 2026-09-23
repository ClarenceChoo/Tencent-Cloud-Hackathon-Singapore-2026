/* Actual dashboard + local transport; synthetic audio fixtures, no hardware/live ASR. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const directory=path.resolve(process.env.CARELOOP_PAIRING_FIXTURE_DIR||'runtime/pairing-check');
const origin=process.env.CARELOOP_TEST_ORIGIN||'http://127.0.0.1:5174';
const backend=process.env.CARELOOP_TEST_BACKEND||'http://127.0.0.1:8002';
const python=path.join(root,'backend/.venv/bin/python');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function main(){
  for(const url of [origin,backend]) assert.equal(new URL(url).hostname,'127.0.0.1');
  assert(directory.startsWith(path.join(root,'runtime')+path.sep));
  const fixture=JSON.parse(fs.readFileSync(path.join(directory,'browser.json')));
  const setup=fs.readFileSync(path.join(directory,'device/owner-setup.txt'),'utf8');
  const code=setup.match(/One-use pairing code: (\S+)/)[1];
  const token=fs.readFileSync(path.join(directory,'device/device-nvs.csv'),'utf8').match(/^token,data,string,(.+)$/m)[1];
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  const contexts=[];const evidence=[];let socket;
  const pass=name=>{evidence.push({name,passed:true});console.log('PASS '+name)};
  async function login(email,password){
    const context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000}});contexts.push(context);
    const page=await context.newPage();page.setDefaultTimeout(15000);await page.goto('/');
    await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:/^Continue/}).click();
    await page.getByRole('heading',{name:/care timeline/i}).waitFor();
    const session=await (await context.request.get('/v1/auth/session')).json();
    const dash=async()=>{const response=await context.request.get(`/v1/app/patients/${session.patients[0].id}/dashboard`);assert(response.ok());return response.json()};
    return {context,page,session,dash};
  }
  async function upload(name,contextId,key=randomUUID()){
    const response=await fetch(backend+'/v1/device/turns',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'audio/wav','Idempotency-Key':key,...(contextId?{'X-Context-Id':contextId}:{})},body:fs.readFileSync(path.join(directory,name+'.wav'))});
    assert.equal(response.status,202);const accepted=await response.json();
    for(let i=0;i<100;i++){
      const result=await (await fetch(backend+'/v1/device/turns/'+accepted.turn_id,{headers:{Authorization:'Bearer '+token}})).json();
      if(result.event){assert.notEqual(result.event.payload.status,'failed');return {payload:result.event.payload,id:accepted.turn_id,key}}
      await sleep(100);
    }
    throw new Error('Timed out waiting for fixture result');
  }
  try{
    const owner=await login('owner@careloop.invalid','fictional-demo-only');
    const caregiver=await login('caregiver@careloop.invalid','fictional-caregiver-only');
    const nav=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();
    await nav(owner.page,'Settings');
    await owner.page.getByLabel('One-use device code').fill('WRONG-CODE');
    await owner.page.getByRole('button',{name:'Pair cardholder',exact:true}).click();
    await owner.page.getByRole('alert').filter({hasText:'Claim code is invalid'}).waitFor();
    assert.equal(await owner.page.getByLabel('One-use device code').inputValue(),'WRONG-CODE');
    await owner.page.getByLabel('One-use device code').fill(code.toLowerCase());
    await owner.page.getByRole('button',{name:'Pair cardholder',exact:true}).click();
    await owner.page.getByText('Paired · waiting for connection',{exact:true}).waitFor();
    assert.equal((await owner.dash()).devices[0].status,'awaiting_connection');
    pass('Owner pairs a device; failed code is retained and paired does not imply online');
    const heartbeat=`import asyncio,csv,sys\nfrom websockets.asyncio.client import connect\nfrom websockets.exceptions import ConnectionClosed\nasync def main():\n token=next(r['value'] for r in csv.DictReader(open(sys.argv[1])) if r['key']=='token')\n try:\n  async with connect(sys.argv[2],additional_headers={'Authorization':'Bearer '+token},proxy=None) as ws:\n   while True:\n    await ws.send('{"type":"heartbeat","firmware_version":"software-test-fixture"}')\n    await ws.recv()\n    await asyncio.sleep(1)\n except ConnectionClosed:\n  pass\nasyncio.run(main())`;
    socket=spawn(python,['-c',heartbeat,path.join(directory,'device/device-nvs.csv'),backend.replace('http:','ws:')+'/v1/device/events'],{stdio:'ignore'});
    await owner.page.locator('.pairing-state').getByText('Online',{exact:true}).waitFor();
    pass('Authenticated socket heartbeats appear as Online in the dashboard automatically');
    const report=JSON.parse(execFileSync(python,[path.join(root,'tools/check_hardware_ready.py'),'--base-url',backend,'--allow-insecure-loopback'],{env:{...process.env,CARELOOP_DEVICE_TOKEN:token},encoding:'utf8'}));
    assert(report.transport_ready);assert(!report.physical_hardware_verified);assert.equal(report.voice_service,'simulated');
    fs.writeFileSync(path.join(directory,'connection-report.json'),JSON.stringify(report,null,2));
    pass('Deployment preflight verifies transport and clearly labels fixture speech');
    const note=await upload('note');assert.equal(note.payload.status,'awaiting_confirmation');
    assert.equal((await owner.dash()).notes.length,0);assert.equal((await caregiver.dash()).notes.length,0);
    const confirmation=await upload('confirm',note.payload.context_id);assert.equal(confirmation.payload.status,'committed');
    const retry=await upload('confirm',note.payload.context_id,confirmation.key);assert.equal(retry.id,confirmation.id);
    await caregiver.page.getByText(fixture.wording,{exact:true}).first().waitFor();
    assert.equal((await caregiver.dash()).notes.length,1);
    pass('Fixture audio needs confirmation; exactly one shared note appears in the open caregiver timeline');
    await caregiver.page.screenshot({path:path.join(directory,'caregiver-timeline.png'),fullPage:true});
    await nav(caregiver.page,'Settings');
    assert.equal(await caregiver.page.getByLabel('One-use device code').count(),0);
    assert.equal(await caregiver.page.getByRole('button',{name:'Revoke device access'}).count(),0);
    pass('Caregiver can observe connection status but cannot pair or revoke devices');
    for(const width of [320,390,768,1440]){
      await owner.page.setViewportSize({width,height:1000});
      await owner.page.waitForTimeout(150);
      assert(await owner.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Horizontal overflow at '+width);
      if(width===390||width===1440)await owner.page.screenshot({path:path.join(directory,'pairing-'+width+'.png'),fullPage:true});
    }
    pass('Pairing screen fits 320, 390, 768 and 1440 px viewports');
    socket.kill('SIGTERM');socket=null;
    await owner.page.locator('.pairing-state').getByText('Offline',{exact:true}).waitFor();
    await owner.page.getByRole('button',{name:'Revoke device access',exact:true}).click();
    await owner.page.getByRole('dialog').getByRole('button',{name:'Revoke access',exact:true}).click();
    await owner.page.getByText('Access revoked',{exact:true}).waitFor();
    assert.equal((await fetch(backend+'/v1/device/info',{headers:{Authorization:'Bearer '+token}})).status,403);
    pass('Disconnect becomes Offline; confirmed revocation blocks the device credential');
    fs.writeFileSync(path.join(directory,'browser-evidence.json'),JSON.stringify({at:new Date().toISOString(),liveSpeech:false,physicalHardware:false,evidence},null,2));
  } finally{socket?.kill('SIGTERM');await browser.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
