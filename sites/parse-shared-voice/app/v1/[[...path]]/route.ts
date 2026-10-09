import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { serveCare } from "@/app/care/care-backend";

export const dynamic="force-dynamic";
async function handle(request:Request){return serveCare(request,await getChatGPTUser(),env);}
export const GET=handle;
export const POST=handle;
export const PUT=handle;
export const DELETE=handle;
