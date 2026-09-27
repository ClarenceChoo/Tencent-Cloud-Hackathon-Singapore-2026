const {chromium}=require(process.env.PLAYWRIGHT_MODULE || require.resolve('playwright', {paths: [require('node:path').resolve(__dirname, '../../../tools'), __dirname]}));
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const ROOT=path.resolve(__dirname,'..'),origin='http://127.0.0.1:5174',runtime=path.join(ROOT,'runtime/story');
const hold=ms=>new Promise(r=>setTimeout(r,ms));
const NOTE='My knee hurts after my morning walk.';
const TOKEN='fictional-parse-pendant-film-token';
const manifest=[];
async function turn(api,name,context){
 const r=await api.post('/v1/device/turns',{headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':'audio/wav','Idempotency-Key':crypto.randomUUID(),...(context?{'X-Context-Id':context}:{})},data:fs.readFileSync(path.join(runtime,`${name}.wav`))});
 if(!r.ok())throw Error(await r.text());
 const accepted=await r.json();
 for(let i=0;i<80;i++){
  const response=await api.get(`/v1/device/turns/${accepted.turn_id}`,{headers:{Authorization:`Bearer ${TOKEN}`}});const body=await response.json();
  if(['awaiting_confirmation','committed','failed'].includes(body.status)){
   if(body.status==='failed')throw Error('Simulated device processing failed');
   return body.event.payload;
  }
  await hold(150);
 }
 throw Error('Device response timed out');
}
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const contexts=[];
 async function setup(id,role,mobile=false){
  const size=mobile?{width:390,height:844}:{width:1280,height:640};
  const context=await browser.newContext({viewport:size,deviceScaleFactor:1,timezoneId:'Asia/Singapore',baseURL:origin,recordVideo:{dir:path.join(runtime,'takes'),size}});contexts.push(context);
  const login=await context.request.post('/v1/auth/login',{headers:{Origin:origin},data:{email:`${role}@parse.invalid`,password:'fictional-demo-only'}});if(!login.ok())throw Error(await login.text());
  const created=performance.now(),page=await context.newPage();page.setDefaultTimeout(15000);
  await page.goto('/');await page.getByRole('region',{name:'Care timeline'}).waitFor();
  await page.addStyleTag({content:'*{cursor:none!important}.film-cursor{position:fixed;left:-50px;top:-50px;width:18px;height:18px;border:2px solid #a44735;border-radius:50%;background:#a447352b;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%)}'});
  await page.evaluate(()=>{let c=document.createElement('i');c.className='film-cursor';document.body.append(c);document.addEventListener('mousemove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px'})});
  async function click(loc){await loc.scrollIntoViewIfNeeded();const b=await loc.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:10});await hold(150);await loc.click();await hold(500)}
  async function nav(name){await click(page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}));await page.evaluate(()=>window.scrollTo(0,0));}
  let start=0;const events=[];
  return {page,context,click,nav,start(){start=performance.now()},mark(text){events.push({at:(performance.now()-start)/1000,text})},async done(){const duration=(performance.now()-start)/1000;await page.screenshot({path:path.join(runtime,`${id}-end.png`)});await context.close();manifest.push({id,mobile,raw:path.relative(ROOT,await page.video().path()),start:(start-created)/1000,duration,events});fs.writeFileSync(path.join(runtime,'takes.json'),JSON.stringify(manifest,null,2));console.log(`Recorded ${id}: ${duration.toFixed(1)}s`);}};
 }
 try{
  const mobile=await setup('phone-arrival','owner',true),care=await setup('caregiver-arrival','caregiver');
  await mobile.click(mobile.page.getByRole('group',{name:'Filter timeline'}).getByRole('button',{name:'Notes',exact:true}));
  await care.click(care.page.getByRole('group',{name:'Filter timeline'}).getByRole('button',{name:'Notes',exact:true}));
  mobile.start();care.start();mobile.mark('Mei’s phone is already open.');care.mark('Jamie’s caregiver account is already open.');await hold(1800);
  const proposal=await turn(care.context.request,'note');
  fs.writeFileSync(path.join(runtime,'device-proof.json'),JSON.stringify({proposal},null,2));
  await hold(1700);const confirmation=await turn(care.context.request,'yes',proposal.context_id);
  if(confirmation.status!=='committed')throw Error('Note was not confirmed');
  const row=care.page.locator('.timeline-item').filter({hasText:NOTE});await row.waitFor();
  await mobile.page.locator('.timeline-item').filter({hasText:NOTE}).waitFor();
  mobile.mark('Her confirmed note appears automatically.');care.mark('The shared note arrives without refreshing the page.');await hold(2300);
  await care.click(row.getByRole('button',{name:'View',exact:true}));care.mark('Her own words and when it happened stay together.');await hold(3000);
  await mobile.done();await care.done();
  const support=await setup('caregiver-support','caregiver');await support.nav('Support');support.start();support.mark('Mei can ask Jamie for practical help.');await hold(1200);
  const supportProposal=await turn(support.context.request,'support');await hold(700);const supportConfirm=await turn(support.context.request,'yes',supportProposal.context_id);
  const supportRow=support.page.locator('.support-item').filter({hasText:'Could you call me this afternoon?'});await supportRow.waitFor();await hold(1700);
  await support.click(supportRow.getByRole('button',{name:'Acknowledge',exact:true}));support.mark('Jamie acknowledges the request. Mei knows it has been seen.');await hold(1700);
  await support.click(supportRow.getByPlaceholder('Outcome to record'));await supportRow.getByPlaceholder('Outcome to record').pressSequentially('Called Mei. Agreed to discuss her knee at the next clinic visit.',{delay:23});await hold(1000);
  await support.click(supportRow.getByRole('button',{name:'Record resolution',exact:true}));support.mark('After the call, Jamie records what they agreed.');await hold(2500);await support.done();
  fs.writeFileSync(path.join(runtime,'device-proof.json'),JSON.stringify({proposal,confirmation,supportProposal,supportConfirm,verified:'Authenticated simulated WAV turns passed through the real device API. Both phone and caregiver page updated without reload.'},null,2));
 }catch(e){for(const c of contexts){for(const p of c.pages()){await p.screenshot({path:path.join(runtime,'record-failure.png')}).catch(()=>{});console.error((await p.locator('body').innerText()).slice(-2000));}}throw e;}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
