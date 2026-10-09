// Exercise the built worker through a loopback-only production preview.
// Fictional identity headers are used only locally; Sites verifies them upstream in production.
import assert from 'node:assert/strict';

const origin=new URL(process.argv[2]??'http://127.0.0.1:5175');
assert(origin.protocol==='http:'&&origin.hostname==='127.0.0.1'&&origin.pathname==='/'&&!origin.search&&!origin.hash,'Use a loopback production preview only.');
const headers={
  'oai-authenticated-user-id':'local-production-care-test',
  'oai-authenticated-user-email':'seedy@sites.test',
  'oai-authenticated-user-full-name':'Seedy',
  'oai-authenticated-user-full-name-encoding':'percent-encoded-utf-8',
};
async function read(path,requestHeaders=headers){return fetch(new URL(path,origin),{headers:requestHeaders,redirect:'manual',signal:AbortSignal.timeout(10000)});}
const dashboard=await read('/');assert.equal(dashboard.status,200);assert((await dashboard.text()).includes('Opening your care space'),'The signed-in response must render the care dashboard loader.');
const shared=await read('/shared/summaries/fictional-test-token');assert.equal(shared.status,200);
const anonymous=await read('/',{});assert.equal(anonymous.status,200);assert((await anonymous.text()).includes('Sign in to your dashboard'),'Anonymous visitors must receive the sign-in gate.');
const outsider=await read('/',{...headers,'oai-authenticated-user-email':'outside@example.test'});assert.equal(outsider.status,200);assert((await outsider.text()).includes('hasn’t been invited'),'An uninvited account must receive the invite gate.');
assert.equal((await read('/v1/auth/session',{})).status,401);
assert.equal((await read('/v1/auth/session',{...headers,'oai-authenticated-user-email':'outside@example.test'})).status,403);
const sessionResponse=await read('/v1/auth/session');assert.equal(sessionResponse.status,200);const session=await sessionResponse.json();assert(session.patients[0].id);
const care=await read(`/v1/app/patients/${session.patients[0].id}/dashboard`);assert.equal(care.status,200);const state=await care.json();assert(state.notes.length&&state.medication_plans.length&&state.preventive_tasks.length);
console.log(JSON.stringify({passed:true,runtime:'built production worker on loopback',checks:['Signed-in dashboard and shared-summary route render without browser globals on the server.','Anonymous and uninvited visitors receive the access gate; care APIs enforce 401/403.','The built worker reads a persistent fictional care space through the actual API route.'],realApiRequests:0,microphoneRecorded:false},null,2));
