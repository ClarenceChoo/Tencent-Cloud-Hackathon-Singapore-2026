import { env } from "cloudflare:workers";
import Image from "next/image";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getChatGPTUser, chatGPTSignInPath, chatGPTSignOutPath } from "./chatgpt-auth";
import { dashboardAccess } from "./dashboard-access";
import CareDashboard from "./care/App";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  if (dashboardAccess(user, env) !== "allowed") {
    return <main className="voice-shell voice-phone-shell">
      <header className="voice-header"><Image unoptimized src="/brand/parse-aurora-logo-light.png" alt="Parse" width={158} height={54}/></header>
      <div className="voice-phone-content"><p className="voice-eyebrow">PARSE TEAM DASHBOARD</p><h1>A private place<br/>for your team.</h1><section className="voice-panel voice-phone-card"><ShieldCheck size={30}/><h2>{user ? "This account hasn’t been invited" : "Sign in to your dashboard"}</h2><p>{user ? "Use the ChatGPT account your team invited, or ask the owner to add you." : "Dashboard access is limited to the owner and invited teammates. Anyone can pair a phone by scanning a QR from an approved dashboard."}</p><Button asChild className="voice-button"><a href={user ? chatGPTSignOutPath("/") : chatGPTSignInPath("/")} target="_top">{user ? "Use another account" : "Sign in with ChatGPT"}</a></Button></section><p className="voice-phone-footnote">Using a phone? Scan the QR shown on your team’s laptop. No ChatGPT sign-in is needed on the phone.</p></div>
    </main>;
  }
  return <CareDashboard phoneOrigin={env.PUBLIC_PHONE_ORIGIN ?? ""}/>;
}
