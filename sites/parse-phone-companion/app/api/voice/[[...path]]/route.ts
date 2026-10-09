import { env } from "cloudflare:workers";
import { forwardPhone } from "@/app/phone-proxy";
export const dynamic = "force-dynamic";
async function handle(request: Request) { return forwardPhone(request, env); }
export const GET = handle;
export const HEAD = handle;
export const POST = handle;
