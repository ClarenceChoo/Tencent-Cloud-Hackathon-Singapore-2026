import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
const root = new URL("../", import.meta.url), dashboard = new URL("../parse-shared-voice/", root);
async function load(path) {
  const result = await build({ entryPoints: [fileURLToPath(path)], bundle: true, write: false, format: "esm", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}
const { forwardPhone } = await load(new URL("app/phone-proxy.ts", root));
const { serveAuthorizedVoice } = await load(new URL("app/voice-http.ts", dashboard));
const { wave } = await load(new URL("app/voice-backend.ts", dashboard));
const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('test')}}", compatibilityDate: "2026-05-15", d1Databases: ["DB"], r2Buckets: ["BUCKET"], host: "127.0.0.1", port: 0 });
const checks = [];
try {
  const DB = await mf.getD1Database("DB"), BUCKET = await mf.getR2Bucket("BUCKET");
  const privateOrigin = "https://private-dashboard.example", phoneOrigin = "https://public-phone.example", owner = { userId: "owner", email: "owner@example.test" };
  const backend = { DB, BUCKET, PUBLIC_SITE_ORIGIN: privateOrigin, PUBLIC_PHONE_ORIGIN: phoneOrigin, DASHBOARD_ALLOWED_EMAILS: owner.email };
  const proxy = { PRIVATE_DASHBOARD_ORIGIN: privateOrigin, PRIVATE_VOICE_SERVICE_TOKEN: "isolated-test-credential", PUBLIC_SITE_ORIGIN: phoneOrigin };
  for (const sql of (await readFile(new URL("drizzle/0000_daffy_charles_xavier.sql", dashboard), "utf8")).split("--> statement-breakpoint")) if (sql.trim()) await DB.prepare(sql).run();
  let forwarded = 0;
  async function send(url, init) {
    forwarded++;
    assert.equal(new URL(url).origin, privateOrigin);
    assert.ok(new URL(url).pathname.startsWith("/api/voice/phone/"));
    assert.equal(init.headers.get("OAI-Sites-Authorization"), "Bearer isolated-test-credential");
    assert.equal(init.headers.get("oai-authenticated-user-id"), null);
    assert.equal(init.headers.get("oai-authenticated-user-email"), null);
    assert.ok(!init.headers.get("Cookie")?.includes("__sites_local_auth"));
    assert.equal(init.redirect, "manual");
    return serveAuthorizedVoice(new Request(url, init), null, backend);
  }
  async function dashboardRequest(path, data) {
    const headers = new Headers();
    if (data) { headers.set("Content-Type", "application/json"); headers.set("Origin", privateOrigin); headers.set("X-Parse-Voice", "1"); }
    return serveAuthorizedVoice(new Request(`${privateOrigin}/api/voice/${path}`, { method: data ? "POST" : "GET", headers, body: data ? JSON.stringify(data) : undefined }), owner, backend);
  }
  async function phoneRequest(path, { data, cookie, bytes, origin = phoneOrigin, headers: additions = {}, method } = {}) {
    const headers = new Headers(additions); let body;
    if (data) { body = JSON.stringify(data); headers.set("Content-Type", "application/json"); }
    if (bytes) { body = bytes; headers.set("Content-Type", "audio/wav"); }
    if (body) { headers.set("Origin", origin); headers.set("X-Parse-Voice", "1"); }
    if (cookie) headers.set("Cookie", cookie);
    return forwardPhone(new Request(`${phoneOrigin}/api/voice/${path}`, { method: method ?? (body ? "POST" : "GET"), headers, body }), proxy, send);
  }
  async function value(r, status = 200) { assert.equal(r.status, status, await r.clone().text()); return r.json(); }
  for (const path of ["rooms", "recordings", "status", "phone/rooms", "phone/recordings", "phone/recordings/00000000-0000-0000-0000-000000000000/audio"]) assert.equal((await phoneRequest(path)).status, 404);
  assert.equal(forwarded, 0);
  checks.push("The public companion exposes no dashboard, inbox, playback, transcript or general forwarding endpoint.");
  const invitation = await value(await dashboardRequest("rooms", { fictionalDemo: true }), 201), room = invitation.room.id, token = new URL(invitation.phonePath, privateOrigin).hash.slice(6);
  assert.equal((await phoneRequest(`phone/rooms/${room}/claim`, { data: { token }, origin: "https://outside.example" })).status, 403);
  assert.equal(forwarded, 0);
  const claim = await phoneRequest(`phone/rooms/${room}/claim`, { data: { token }, headers: { "oai-authenticated-user-id": "spoofed", "oai-authenticated-user-email": owner.email, "Cookie": "__sites_local_auth=1" } }), claimed = await value(claim, 201), cookie = claim.headers.get("Set-Cookie").split(";")[0];
  assert.match(claim.headers.get("Set-Cookie"), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await phoneRequest("phone/recordings", { cookie, data: { roomId: room, fictionalDemo: true } })).status, 403);
  assert.equal((await phoneRequest(`phone/rooms/${room}/approve`, { cookie, data: { code: claimed.room.code } })).status, 404);
  await value(await dashboardRequest(`rooms/${room}/approve`, { code: claimed.room.code }));
  assert.equal((await value(await phoneRequest(`phone/rooms/${room}`, { cookie }))).room.state, "paired");
  checks.push("Anonymous QR claim crosses the authenticated server bridge, while only the private dashboard can approve the phone.");
  const recording = (await value(await phoneRequest("phone/recordings", { cookie, data: { roomId: room, fictionalDemo: true } }), 201)).recording.id;
  const pcm = new Uint8Array(32000), wav = wave(pcm);
  await value(await phoneRequest(`phone/recordings/${recording}/chunks/0`, { cookie: `${cookie}; __sites_local_auth=1`, bytes: wav }));
  const audio = await dashboardRequest(`recordings/${recording}/audio/0`);
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), wav);
  assert.equal((await value(await dashboardRequest("recordings"))).recordings[0].state, "receiving");
  assert.equal((await phoneRequest(`phone/recordings/${recording}/audio/0`, { cookie })).status, 404);
  checks.push("Live audio sent through the public Site is readable before Stop only from its private dashboard.");
  const finished = await value(await phoneRequest(`phone/recordings/${recording}/finish`, { cookie, data: { chunks: 1 } }));
  assert.equal(finished.recording.state, "ready"); assert.equal(finished.recording.audioUrl, null); assert.equal(finished.recording.transcript, null);
  const sanitized = await forwardPhone(new Request(`${phoneOrigin}/api/voice/phone/rooms/${room}`, { headers: { Cookie: cookie } }), proxy, async () => Response.json({ room: { id: room, state: "paired", owner_id: "private-owner" }, recordings: [{ transcript: "private" }], apiKey: "private", thisPhone: true }));
  const safe = await sanitized.json(); assert.equal(safe.apiKey, undefined); assert.equal(safe.recordings, undefined); assert.equal(safe.room.owner_id, undefined);
  checks.push("The bridge strips private fields and retains secure, phone-only cookies.");
  let redirectAttempts=0;
  const redirected=await forwardPhone(new Request(`${phoneOrigin}/api/voice/phone/rooms/${room}`,{headers:{Cookie:cookie}}),proxy,async()=>{redirectAttempts++;return new Response(null,{status:302,headers:{Location:"https://outside.example"}});});
  assert.equal(redirected.status,503);assert.equal(redirected.headers.get("Location"),null);assert.equal(redirectAttempts,1);
  checks.push("An upstream redirect is rejected without forwarding the service credential to another origin.");
  assert.equal((await phoneRequest(`phone/rooms/${room}/claim`, { data: { token: "a".repeat(5000) } })).status, 413);
  assert.equal((await forwardPhone(new Request(`${phoneOrigin}/api/voice/phone/rooms/${room}/claim`, { method: "POST", headers: { Origin: phoneOrigin, "X-Parse-Voice": "1", "Content-Type": "application/json" }, body: JSON.stringify({ token }) }), { ...proxy, PRIVATE_VOICE_SERVICE_TOKEN: undefined }, send)).status, 503);
  const count = forwarded;
  assert.equal((await phoneRequest(`phone/rooms/${room}`, { cookie, method: "HEAD" })).status, 404);
  assert.equal(forwarded, count);
  await value(await dashboardRequest(`rooms/${room}/revoke`, {}));
  assert.equal((await phoneRequest(`phone/rooms/${room}`, { cookie })).status, 410);
  checks.push("Request bounds, missing configuration, method restrictions, and revoked pairings fail closed.");
  console.log(JSON.stringify({ passed: true, realApiRequests: 0, microphoneRecorded: false, checks }, null, 2));
} finally { await mf.dispose(); }
