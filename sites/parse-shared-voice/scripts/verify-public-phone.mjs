import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { Miniflare } from "miniflare";

const root = new URL("../", import.meta.url);
const bundled = await build({ entryPoints: [fileURLToPath(new URL("app/voice-http.ts", root))], bundle: true, write: false, format: "esm", target: "es2022" });
const { serveAuthorizedVoice } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
const compiled = await transform(await readFile(new URL("app/dashboard-access.ts", root), "utf8"), { loader: "ts", format: "esm", target: "es2022" });
const { dashboardAccess } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);
const audioModule = await build({entryPoints:[fileURLToPath(new URL("app/voice-backend.ts",root))],bundle:true,write:false,format:"esm",target:"es2022"});
const { wave } = await import(`data:text/javascript;base64,${Buffer.from(audioModule.outputFiles[0].contents).toString("base64")}`);
const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('test')}}", compatibilityDate: "2026-05-15", d1Databases: ["DB"], r2Buckets: ["BUCKET"], host: "127.0.0.1", port: 0 });
const checks = [];
try {
  const DB = await mf.getD1Database("DB"), BUCKET = await mf.getR2Bucket("BUCKET");
  const origin = "https://parse-test.example";
  const bindings = { DB, BUCKET, PUBLIC_SITE_ORIGIN: origin, DASHBOARD_ALLOWED_EMAILS: "owner@example.test, clarence@example.test, calvin@example.test" };
  const owner = { userId: "owner", email: "owner@example.test" }, teammate = { userId: "clarence", email: "Clarence@example.test" }, calvin = { userId: "calvin", email: "calvin@example.test" }, outsider = { userId: "outside", email: "outside@example.test" };
  for(const name of (await readdir(new URL("drizzle/",root))).filter(name=>name.endsWith(".sql")).sort())for(const sql of (await readFile(new URL(`drizzle/${name}`,root),"utf8")).split("--> statement-breakpoint"))if(sql.trim())await DB.prepare(sql).run();
  async function request(path, { user = null, data, cookie, bytes, originHeader = origin, extraHeaders = {}, method } = {}) {
    const headers = new Headers(extraHeaders);
    let body;
    if (data !== undefined) { body = JSON.stringify(data); headers.set("Content-Type", "application/json"); }
    if (bytes) { body = bytes; headers.set("Content-Type", "audio/wav"); }
    if (body) { headers.set("Origin", originHeader); headers.set("X-Parse-Voice", "1"); }
    if (cookie) headers.set("Cookie", cookie);
    return serveAuthorizedVoice(new Request(`${origin}/api/voice/${path}`, { method: method ?? (body ? "POST" : "GET"), headers, body }), user, bindings);
  }
  async function value(response, status = 200) { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
  assert.equal(dashboardAccess(owner, bindings), "allowed");
  assert.equal(dashboardAccess(teammate, bindings), "allowed");
  assert.equal(dashboardAccess(calvin, bindings), "allowed");
  assert.equal(dashboardAccess(outsider, bindings), "denied");
  assert.equal(dashboardAccess(null, bindings), "anonymous");
  assert.equal(dashboardAccess(owner, {}), "denied");
  for (const path of ["status", "rooms", "recordings"]) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, { user: outsider })).status, 403);
  }
  checks.push("Only the configured owner and two teammates can use dashboard APIs; a missing allowlist denies access.");
  const pair = await value(await request("rooms", { user: owner, data: {  } }), 201), room = pair.room.id;
  const token = new URL(pair.phonePath, origin).hash.slice(6);
  assert.equal((await request(`phone/rooms/${room}`)).status, 403);
  assert.equal((await request(`phone/rooms/${room}/claim`, { data: { token: "a".repeat(64) } })).status, 409);
  assert.equal((await request(`phone/rooms/${room}/claim`, { data: { token }, originHeader: "https://outside.example" })).status, 403);
  const claim = await request(`phone/rooms/${room}/claim`, { user: outsider, data: { token } }), claimed = await value(claim, 201), cookie = claim.headers.get("Set-Cookie").split(";")[0];
  assert.match(claim.headers.get("Set-Cookie"), /HttpOnly; SameSite=Strict/);
  assert.match(claim.headers.get("Set-Cookie"), /Secure/);
  assert.equal((await request(`phone/rooms/${room}/claim`, { data: { token } })).status, 409);
  assert.equal((await value(await request(`phone/rooms/${room}`, { cookie }))).room.state, "pending");
  assert.equal((await request(`phone/rooms/${room}/approve`, { cookie, data: { code: claimed.room.code } })).status, 404);
  assert.equal((await request(`rooms/${room}/approve`, { cookie, data: { code: claimed.room.code } })).status, 401);
  assert.equal((await request("phone/recordings", { cookie, data: { roomId: room,  } })).status, 403);
  await value(await request(`rooms/${room}/approve`, { user: owner, data: { code: claimed.room.code } }));
  checks.push("A phone needs no ChatGPT account, but must have the single-use QR and a separate dashboard approval.");
  for (const path of ["phone/status", "phone/rooms", "phone/recordings"]) assert.equal((await request(path, { cookie })).status, 404);
  assert.equal((await request("phone/rooms", { cookie, data: {  } })).status, 404);
  assert.equal((await request("recordings", { cookie })).status, 401);
  assert.equal((await request("recordings", { cookie, user: outsider })).status, 403);
  const starts = await Promise.all([request("phone/recordings", { cookie, data: { roomId: room,  } }), request("phone/recordings", { cookie, data: { roomId: room,  } })]);
  assert.deepEqual(starts.map(r => r.status).sort(), [201, 409]);
  const recording = (await value(starts.find(r => r.status === 201), 201)).recording.id;
  const pcm = new Uint8Array(32000), wav = wave(pcm);
  assert.equal((await request(`phone/recordings/${recording}/chunks/0`, { bytes: wav })).status, 403);
  await value(await request(`phone/recordings/${recording}/chunks/0`, { cookie, bytes: wav }));
  const inbox = await value(await request("recordings", { user: owner }));
  assert.equal(inbox.recordings[0].id, recording);
  assert.equal(inbox.recordings[0].state, "receiving");
  const audio = await request(`recordings/${recording}/audio/0`, { user: owner });
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), wav);
  assert.equal((await request(`recordings/${recording}/audio/0`, { cookie })).status, 401);
  assert.equal((await request(`phone/recordings/${recording}/audio/0`, { cookie })).status, 404);
  assert.equal((await request(`phone/recordings/${recording}/chunks`, { cookie })).status, 404);
  assert.equal((await request(`recordings/${recording}/audio/0`, { user: teammate })).status, 404);
  checks.push("An approved anonymous phone sends live audio to its dashboard, but cannot read any inbox, audio, or another teammate’s recording.");
  const secondPair = await value(await request("rooms", { user: teammate, data: {  } }), 201);
  const secondClaim = await request(`phone/rooms/${secondPair.room.id}/claim`, { data: { token: new URL(secondPair.phonePath, origin).hash.slice(6) } });
  const secondCookie = secondClaim.headers.get("Set-Cookie").split(";")[0], second = await value(secondClaim, 201);
  await value(await request(`rooms/${secondPair.room.id}/approve`, { user: teammate, data: { code: second.room.code } }));
  assert.equal((await request(`phone/recordings/${recording}/chunks/1`, { cookie: secondCookie, bytes: wav })).status, 403);
  assert.equal((await request(`phone/rooms/${room}`, { cookie: secondCookie })).status, 403);
  checks.push("Phone credentials are bound to one pairing and cannot write into another laptop’s session.");
  const finished = await value(await request(`phone/recordings/${recording}/finish`, { cookie, data: { chunks: 1 } }));
  assert.equal(finished.recording.state, "ready");
  assert.equal(finished.recording.audioUrl, null);
  assert.equal(finished.recording.transcript, null);
  // The phone response must still omit private fields if the dashboard has a transcript.
  await DB.prepare("UPDATE voice_recordings SET transcript = ? WHERE id = ?").bind("Fictional dashboard-only transcript", recording).run();
  const retried = await value(await request(`phone/recordings/${recording}/finish`, { cookie, data: { chunks: 1 } }));
  assert.equal(retried.recording.transcript, null);
  assert.equal(retried.recording.audioUrl, null);
  assert.equal((await value(await request(`recordings/${recording}`, { user: owner }))).recording.transcript, "Fictional dashboard-only transcript");
  checks.push("Finished phone responses omit dashboard audio URLs and transcripts, including retries.");
  const expired = await value(await request("rooms", { user: calvin, data: {  } }), 201);
  await DB.prepare("UPDATE voice_rooms SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired.room.id).run();
  assert.equal((await request(`phone/rooms/${expired.room.id}/claim`, { data: { token: new URL(expired.phonePath, origin).hash.slice(6) } })).status, 410);
  const interrupted = (await value(await request("phone/recordings", { cookie, data: { roomId: room,  } }), 201)).recording.id;
  await value(await request(`rooms/${room}/revoke`, { user: owner, data: {} }));
  assert.equal((await request(`phone/recordings/${interrupted}/chunks/0`, { cookie, bytes: wav })).status, 410);
  assert.equal((await request(`phone/rooms/${room}`, { cookie })).status, 410);
  assert.equal((await value(await request(`recordings/${interrupted}`, { user: owner }))).recording.state, "interrupted");
  checks.push("Expired invitations and disconnected phone credentials stop access immediately.");
  console.log(JSON.stringify({ passed: true, realApiRequests: 0, microphoneRecorded: false, checks }, null, 2));
} finally { await mf.dispose(); }
