import { dashboardAccess, type DashboardIdentity } from "./dashboard-access";
import { serveVoice, type VoiceBindings } from "./voice-backend";
import { interpretRelayRecording } from "./care/care-backend";

export async function serveAuthorizedVoice(
  request: Request,
  user: DashboardIdentity | null,
  bindings: VoiceBindings,
): Promise<Response> {
  if (new URL(request.url).pathname.startsWith("/api/voice/phone/") ||
      new URL(request.url).pathname.startsWith("/api/voice/device/")) {
    return serveVoice(request, null, bindings,(ownerId,recordingId)=>interpretRelayRecording(bindings,ownerId,recordingId));
  }
  const access = dashboardAccess(user, bindings);
  if (access !== "allowed") {
    return Response.json(
      { error: access === "anonymous" ? "Sign in to an invited dashboard account." : "This account does not have access to the team dashboard." },
      { status: access === "anonymous" ? 401 : 403, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }
  return serveVoice(request, user!.userId, bindings,(ownerId,recordingId)=>interpretRelayRecording(bindings,ownerId,recordingId));
}
