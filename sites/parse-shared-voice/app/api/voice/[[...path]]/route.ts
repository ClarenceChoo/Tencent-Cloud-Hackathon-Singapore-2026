import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { serveAuthorizedVoice } from "@/app/voice-http";

export const dynamic = "force-dynamic";
async function handle(request:Request){return serveAuthorizedVoice(request,await getChatGPTUser(),env);}
export const GET=handle;
export const HEAD=handle;
export const POST=handle;
