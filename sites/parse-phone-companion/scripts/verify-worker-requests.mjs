import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
const bundled = await build({ entryPoints: [fileURLToPath(new URL("../app/phone-proxy.ts", import.meta.url))], bundle: true, write: false, format: "esm", target: "es2022" });
const script = Buffer.from(bundled.outputFiles[0].contents).toString("utf8") + `
export default { async fetch() {
  let unsupportedRejected=false;
  try { new Request("https://example.test",{redirect:"error"}); } catch { unsupportedRejected=true; }
  const origin="https://public-phone.example",room="00000000-0000-0000-0000-000000000000";
  const request=new Request(origin+"/api/voice/phone/rooms/"+room+"/claim",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","X-Parse-Voice":"1"},body:JSON.stringify({token:"a".repeat(64)})});
  let actualRedirect;
  const response=await forwardPhone(request,{PRIVATE_DASHBOARD_ORIGIN:"https://private-dashboard.example",PRIVATE_VOICE_SERVICE_TOKEN:"isolated-worker-test",PUBLIC_SITE_ORIGIN:origin},async(url,init)=>{
    const outbound=new Request(url,init);actualRedirect=outbound.redirect;
    return Response.json({room:{id:room,state:"pending",code:"123456"}},{status:201,headers:{"Set-Cookie":"parse_voice_phone="+"b".repeat(64)+"; HttpOnly; SameSite=Strict"}});
  });
  const form=new FormData();form.append("model","gpt-4o-mini-transcribe");form.append("file",new Blob([new Uint8Array(44)],{type:"audio/wav"}),"fictional.wav");
  const transcriptionRequest=new Request("https://api.openai.com/v1/audio/transcriptions",{method:"POST",headers:{Authorization:"Bearer isolated-worker-test"},body:form,redirect:"manual",signal:AbortSignal.timeout(45000)});
  return Response.json({unsupportedRejected,phoneStatus:response.status,phoneRedirect:actualRedirect,transcriptionRedirect:transcriptionRequest.redirect,phoneCookieSecure:response.headers.get("Set-Cookie").includes("HttpOnly; Secure; SameSite=Strict")});
}};
`;
const mf = new Miniflare({ modules: true, script, compatibilityDate: "2026-05-15", host: "127.0.0.1", port: 0 });
try {
  const result = await (await mf.dispatchFetch("https://isolated-worker.example")).json();
  assert.equal(result.unsupportedRejected, true);
  assert.equal(result.phoneStatus, 201);
  assert.equal(result.phoneRedirect, "manual");
  assert.equal(result.transcriptionRedirect, "manual");
  assert.equal(result.phoneCookieSecure, true);
  console.log(JSON.stringify({ passed: true, runtime: "Cloudflare workerd", realApiRequests: 0, microphoneRecorded: false, checks: result }, null, 2));
} finally { await mf.dispose(); }
