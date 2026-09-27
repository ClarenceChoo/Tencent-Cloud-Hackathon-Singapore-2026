const {chromium}=require(process.env.PLAYWRIGHT_MODULE || require.resolve('playwright', {paths: [require('node:path').resolve(__dirname, '../../../tools'), __dirname]}));
const fs=require('node:fs');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const ROOT=path.resolve(__dirname,'..');
const origin='http://127.0.0.1:5174';
const takeDir=path.join(ROOT,'runtime/takes');fs.mkdirSync(takeDir,{recursive:true});
const manifestPath=path.join(ROOT,'runtime/takes.json');
let manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath)):[];
const only=process.argv[2];
const hold=(page,ms)=>page.waitForTimeout(ms);
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const future=new Date(`${today}T12:00:00+08:00`);future.setDate(future.getDate()+3);
const appointment=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(future);
(async()=>{
const browser=await chromium.launch({channel:'chrome',headless:true});
async function take(id,title,prepare,action,mobile=false){
 if(only&&only!==id)return;
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:640},deviceScaleFactor:mobile?2:1.5,timezoneId:'Asia/Singapore',baseURL:origin,recordVideo:{dir:takeDir,size:mobile?{width:390,height:844}:{width:1280,height:640}}});
 const login=await context.request.post('/v1/auth/login',{headers:{Origin:origin},data:{email:'owner@parse.invalid',password:'fictional-demo-only'}});
 if(!login.ok())throw new Error('Recording sign-in failed');
 const session=await login.json();
 const api=async(route,data)=>{const r=await context.request.fetch(`/v1${route}`,{method:data?'POST':'GET',headers:{Origin:origin,'X-CSRF-Token':session.csrf_token},...(data?{data}:{})});if(!r.ok())throw new Error(await r.text());return r.json()};
 const created=performance.now();
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 const click=async locator=>{await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:12});await hold(page,160);await locator.click();await hold(page,430)};
 const nav=async name=>{const menu=page.getByRole('button',{name:'Open menu',exact:true});if(await menu.isVisible())await click(menu);await click(page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}));await page.evaluate(()=>window.scrollTo(0,0));};
 const type=async(locator,text)=>{await click(locator);await locator.fill('');await locator.pressSequentially(text,{delay:33})};
 const confirm=async()=>{await click(page.getByRole('dialog').getByRole('button',{name:'Confirm and save',exact:true}));await page.getByRole('dialog').waitFor({state:'hidden'});await hold(page,650)};
 const dismiss=async()=>{const b=page.getByRole('button',{name:'Dismiss',exact:true});if(await b.isVisible())await b.click();};
 await page.addInitScript(()=>{document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='*{cursor:none!important}.demo-cursor{position:fixed;left:-50px;top:-50px;width:18px;height:18px;border:2px solid #a44735;border-radius:50%;background:#a447352b;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%)}.demo-ripple{position:fixed;width:32px;height:32px;pointer-events:none;border:2px solid #a44735;border-radius:50%;z-index:2147483646;animation:demo-ripple .55s ease-out forwards}@keyframes demo-ripple{from{transform:translate(-50%,-50%) scale(.5);opacity:.9}to{transform:translate(-50%,-50%) scale(1.8);opacity:0}}';document.head.append(s);const c=document.createElement('i');c.className='demo-cursor';document.body.append(c);document.addEventListener('mousemove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px'});document.addEventListener('mousedown',e=>{const r=document.createElement('i');r.className='demo-ripple';r.style.left=e.clientX+'px';r.style.top=e.clientY+'px';document.body.append(r);setTimeout(()=>r.remove(),650)})})});
 try{
  await page.goto('/');await page.getByRole('region',{name:'Care timeline'}).waitFor();
  const helpers={page,click,type,nav,confirm,dismiss,api};
  await prepare(helpers);await dismiss();await hold(page,600);await page.mouse.move(1250,610);
  const started=performance.now();const events=[];const mark=text=>events.push({at:(performance.now()-started)/1000,text});
  await action({...helpers,mark});await hold(page,900);
  const ended=performance.now();
  await page.screenshot({path:path.join(ROOT,`runtime/${id}-end.png`)});
  await context.close();
  const raw=await page.video().path();
  if(errors.length)throw new Error(errors.join('\n'));
  const record={id,title,mobile,raw:path.relative(ROOT,raw),start:(started-created)/1000,duration:(ended-started)/1000,events};
  manifest=manifest.filter(x=>x.id!==id);manifest.push(record);fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
  console.log(`Recorded ${id}: ${record.duration.toFixed(1)}s`,JSON.stringify(events));
 }catch(e){await page.screenshot({path:path.join(ROOT,`runtime/${id}-failure.png`)}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-2200));await context.close();throw e;}
}
try{
await take('timeline','See the day clearly',async()=>{},async({page,click,mark})=>{
 mark('Medication reports, notes and readings. One timeline.');await hold(page,2400);
 await click(page.getByRole('group',{name:'Filter timeline'}).getByRole('button',{name:'Notes',exact:true}));
 mark('Filter to the details you need.');await hold(page,2000);
 await click(page.getByRole('group',{name:'Filter timeline'}).getByRole('button',{name:'Readings',exact:true}));await hold(page,2000);
 await click(page.getByRole('group',{name:'Filter timeline'}).getByRole('button',{name:'All entries',exact:true}));await hold(page,1800);
});
await take('medication','Keep track of medication',async({nav})=>nav('Medications'),async({page,click,nav,confirm,api,mark})=>{
 mark('Keep the checked instructions and schedule together.');await hold(page,2400);
 await click(page.getByRole('button',{name:'Add entry',exact:true}));await page.getByLabel('Type',{exact:true}).selectOption('medication_report');
 const d=await api('/app/patients/demo-mei/dashboard');const dose=d.doses.find(x=>x.id==='demo-morning-today');
 await page.getByLabel('Scheduled dose',{exact:true}).selectOption(dose.id);await page.getByLabel('Reported status',{exact:true}).selectOption('reported_taken');await page.getByLabel('When it was taken (as described)').fill('After breakfast');
 mark('Record the reported dose, then review and confirm.');await hold(page,2000);
 await click(page.getByRole('button',{name:'Review proposal',exact:false}));await hold(page,2400);await confirm();
 await nav('Timeline');await click(page.getByRole('group',{name:'Filter timeline'}).getByRole('button',{name:'Medication',exact:true}));
 mark('A reminder alone never counts as a taken dose.');await hold(page,2200);
});
await take('notes','Keep the details that matter',async()=>{},async({page,click,type,confirm,dismiss,mark})=>{
 mark('Capture a care note in their own words.');await click(page.getByRole('button',{name:'Add entry',exact:true}));
 await type(page.getByLabel('What would you like recorded?'),'My knee felt better after resting.');await hold(page,1000);
 await click(page.getByRole('button',{name:'Review proposal',exact:false}));mark('Nothing is saved until you review and confirm.');await hold(page,2300);await confirm();await dismiss();
 await click(page.getByRole('group',{name:'Filter timeline'}).getByRole('button',{name:'Notes',exact:true}));
 const row=page.locator('.timeline-item').filter({hasText:'My knee felt better after resting.'});await click(row.getByRole('button',{name:'View',exact:true}));
 await click(row.getByRole('button',{name:'Manage sharing →',exact:true}));mark('Choose exactly who can see the note.');await hold(page,1700);
 await click(page.getByRole('dialog').getByRole('checkbox',{name:/Jamie Lim/}));await hold(page,850);await click(page.getByRole('button',{name:'Save sharing',exact:true}));await hold(page,1400);
});
await take('care-plan','Stay on top of follow-ups',async({nav})=>nav('Care plan'),async({page,click,confirm,mark})=>{
 mark('Keep the next steps from the care plan in view.');await hold(page,2000);
 const row=page.locator('.care-task').filter({hasText:'Medication review at the clinic'});
 await click(row.getByRole('button',{name:'Propose an update →',exact:true}));await row.getByLabel('New status').selectOption('arranged');await row.getByLabel('Appointment date').fill(appointment);
 mark('Record an arranged visit and its appointment date.');await hold(page,1600);await click(row.getByRole('button',{name:'Review proposed change',exact:true}));await hold(page,2000);await confirm();await hold(page,1500);
});
await take('support','Ask for a little help',async({nav})=>nav('Support'),async({page,click,type,confirm,mark})=>{
 mark('Ask someone in your care circle for practical help.');await click(page.getByRole('button',{name:'New request',exact:false}));
 await type(page.getByLabel('What help is needed?'),'Could you come with me to my clinic visit?');await page.getByLabel('Share with',{exact:true}).selectOption({label:'Jamie Lim'});await hold(page,1400);
 await click(page.getByRole('button',{name:'Review proposal',exact:false}));mark('Review the request and recipient before sending.');await hold(page,2400);await confirm();await hold(page,1500);
});
await take('summary','Prepare for the next visit',async({nav})=>nav('Visit summary'),async({page,click,mark})=>{
 mark('Bring the relevant care history to the next appointment.');await hold(page,1800);
 await click(page.getByRole('button',{name:/Prepare draft|Prepare a fresh draft/}));await page.locator('.summary-source textarea').first().waitFor();await hold(page,1300);
 const source=page.locator('.summary-source').first();await source.scrollIntoViewIfNeeded();mark('Review the draft. Every item keeps its source.');await hold(page,2000);
 await page.getByRole('button',{name:'Save review',exact:true}).scrollIntoViewIfNeeded();await hold(page,1200);await click(page.getByRole('button',{name:'Save review',exact:true}));await hold(page,800);
 await click(page.getByRole('button',{name:'Share read-only',exact:true}));const link=page.getByRole('link',{name:'Open read-only view'});await link.waitFor();mark('Share a read-only copy after your review.');await hold(page,1000);
 const href=await link.getAttribute('href');await page.goto(href);await page.getByText('Read-only summary',{exact:true}).waitFor();await hold(page,2500);
});
await take('mobile','Care, within reach',async()=>{},async({page,click,mark})=>{
 mark('The same care record, ready on your phone.');await hold(page,1800);
 await click(page.getByRole('group',{name:'Filter timeline'}).getByRole('button',{name:'Notes',exact:true}));await hold(page,1400);
 await page.evaluate(()=>window.scrollBy({top:270,behavior:'smooth'}));await hold(page,2100);
},true);
}finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
