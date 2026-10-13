export type PhoneProxyBindings = {
  PRIVATE_DASHBOARD_ORIGIN?: string;
  PRIVATE_VOICE_SERVICE_TOKEN?: string;
  PUBLIC_SITE_ORIGIN?: string;
};
const COOKIE = "parse_voice_phone";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
function phoneCookie(request: Request) {
  const matches = (request.headers.get("Cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(COOKIE + "="));
  return matches.length === 1 && /^parse_voice_phone=[a-f0-9]{64}$/.test(matches[0]) ? matches[0] : null;
}
function pick(value: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(fields.filter(key => key in value).map(key => [key, value[key]]));
}

export async function forwardPhone(request: Request, bindings: PhoneProxyBindings, send: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url), deviceApi=url.pathname.startsWith("/api/voice/device/"),phoneApi=url.pathname.startsWith("/api/voice/phone/"),prefix=deviceApi?"device":phoneApi?"phone":"",path = prefix?url.pathname.replace(new RegExp(`^/api/voice/${prefix}/`),""):"";
  const claim = /^rooms\/[a-f0-9-]{36}\/claim$/.test(path),deviceCredential=/^Bearer [a-f0-9]{64}$/.test(request.headers.get("Authorization")??"");
  const phoneAllowed=phoneApi&&((request.method==="GET"&&/^rooms\/[a-f0-9-]{36}$/.test(path))||(request.method==="POST"&&(claim||/^rooms\/[a-f0-9-]{36}\/relay$/.test(path)||path==="recordings"||/^recordings\/[a-f0-9-]{36}\/(?:chunks\/[0-9]{1,2}|finish|discard|reply)$/.test(path))));
  const deviceAllowed=deviceApi&&deviceCredential&&((request.method==="GET"&&/^rooms\/[a-f0-9-]{36}$/.test(path))||(request.method==="POST"&&(claim||/^rooms\/[a-f0-9-]{36}\/relay$/.test(path)||path==="recordings"||/^recordings\/[a-f0-9-]{36}\/(?:chunks\/[0-9]{1,2}|finish|discard)$/.test(path))));
  const allowed=!url.search&&(phoneAllowed||deviceAllowed);
  if (!allowed) return json({ error: "This phone action was not found." }, 404);
  if (!bindings.PRIVATE_DASHBOARD_ORIGIN || !bindings.PRIVATE_VOICE_SERVICE_TOKEN || !bindings.PUBLIC_SITE_ORIGIN) return json({ error: "Phone pairing is temporarily unavailable." }, 503);
  const cookie = phoneApi?phoneCookie(request):null;
  if (phoneApi&&!claim&&!cookie) return json({ error: "Scan a fresh pairing QR from the dashboard." }, 403);
  const headers = new Headers({ "OAI-Sites-Authorization": `Bearer ${bindings.PRIVATE_VOICE_SERVICE_TOKEN}` });
  if (cookie) headers.set("Cookie", cookie);
  if(deviceApi)headers.set("Authorization",request.headers.get("Authorization")!);
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.method === "POST") {
    if (phoneApi&&(request.headers.get("Origin") !== bindings.PUBLIC_SITE_ORIGIN || request.headers.get("X-Parse-Voice") !== "1" || request.headers.get("Sec-Fetch-Site") === "cross-site")) return json({ error: "Open the phone companion to make this change." }, 403);
    const audio = /\/(?:chunks\/[0-9]{1,2}|reply)$/.test(path), contentType = audio ? "audio/wav" : "application/json", limit = path.endsWith("/reply") ? 640044 : audio ? 32044 : 4096;
    if (request.headers.get("Content-Type") !== contentType || Number(request.headers.get("Content-Length") ?? 0) > limit) return json({ error: "Use a short, valid phone request." }, 413);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "The phone request is missing." }, 400);
    const parts: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) return json({ error: "The phone request is too large." }, 413); parts.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    body = new Uint8Array(size); let offset = 0; for (const part of parts) { body.set(part, offset); offset += part.length; }
    headers.set("Content-Type", contentType);
    if(phoneApi){headers.set("Origin", bindings.PUBLIC_SITE_ORIGIN); headers.set("X-Parse-Voice", "1");}
  }
  try {
    const destination = new URL(bindings.PRIVATE_DASHBOARD_ORIGIN);
    if (destination.protocol !== "https:" || destination.pathname !== "/" || destination.search || destination.hash || destination.username || destination.password) return json({ error: "Phone pairing is temporarily unavailable." }, 503);
    destination.pathname = `/api/voice/${prefix}/${path}`;
    const upstream = await send(destination.href, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(path.endsWith('/finish')?120_000:60_000) });
    if (upstream.status >= 300 && upstream.status < 400) return json({ error: "The paired dashboard is temporarily unavailable." }, 503);
    if (!upstream.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "The paired dashboard is temporarily unavailable." }, 503);
    const value = await upstream.json() as Record<string, unknown>, safe: Record<string, unknown> = {};
    if (typeof value.error === "string") safe.error = value.error.slice(0, 240);
    if (value.room && typeof value.room === "object") safe.room = pick(value.room as Record<string, unknown>, ["id", "state", "clientType", "code", "createdAt", "expiresAt", "updatedAt"]);
    if (value.recording && typeof value.recording === "object") safe.recording = { ...pick(value.recording as Record<string, unknown>, ["id", "roomId", "state", "chunks", "duration", "createdAt", "updatedAt", "errorCode"]), transcript: null, audioUrl: null };
    // The private service returns these fields only for the cookie's approved
    // ESP32 room. Keep the public bridge restricted to that one recording.
    if (upstream.ok && path.endsWith('/finish') && value.recording && typeof value.recording === 'object' && ['esp32','esp32_wifi'].includes(String((value.recording as Record<string,unknown>).clientType)) && value.relay && typeof value.relay === 'object') {
      const relay=value.relay as Record<string,unknown>;
      safe.relay=Object.fromEntries(['transcript','spokenText','functionName','proposalId','proposalStatus','error'].filter(key=>typeof relay[key]==='string'||relay[key]===null).map(key=>[key,typeof relay[key]==='string'?(relay[key] as string).slice(0,key==='transcript'?10000:1500):null]));
    }
    if(upstream.ok && path.endsWith('/relay')) {
      safe.command=value.command&&typeof value.command==='object'?pick(value.command as Record<string,unknown>,['id','kind','state','createdAt','expiresAt']):null;
      if(value.claimed===true)safe.claimed=true;
    }
    for (const key of ["thisPhone", "accepted", "sequence", "reused", "stopped", "transcriptionConfigured"]) if (typeof value[key] === "boolean" || typeof value[key] === "number") safe[key] = value[key];
    const response = json(safe, upstream.status);
    const issued = upstream.headers.get("Set-Cookie")?.match(/^parse_voice_phone=([a-f0-9]{64});/);
    if (phoneApi&&claim && upstream.status === 201 && issued) response.headers.set("Set-Cookie", `${COOKIE}=${issued[1]}; HttpOnly; Secure; SameSite=Strict; Path=/api/voice; Max-Age=86400`);
    return response;
  } catch { return json({ error: "The paired dashboard is temporarily unavailable. Keep this page open and try again." }, 503); }
}
