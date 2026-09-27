import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import type {
  Enrollment,
  Home,
  Installation,
  Receipt,
  TurnEvent,
  TurnStatus,
  Reminder,
  ReminderSchedule,
  PlaybackStage,
  PushRegistration,
} from "./contracts";
import { audioPath } from "./validation";
import { ApiError } from "./errors";
export { ApiError } from "./errors";
export class PhoneApi {
  constructor(readonly installation: Installation) {}
  async request<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort);
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 30000);
    try {
      const response = await fetch(this.installation.service + path, {
        ...init,
        redirect: "error",
        headers: {
          Authorization: "Bearer " + this.installation.credential,
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `Parse could not complete this request (${response.status}).`;
        try {
          const data = await response.json();
          if (typeof data.detail === "string") detail = data.detail;
        } catch {}
        throw new ApiError(response.status, detail);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  enroll() {
    return this.request<Enrollment>("/v1/phone/enrollments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": this.installation.enrollmentKey,
      },
      body: JSON.stringify({
        platform: this.installation.platform,
        display_name: this.installation.displayName,
      }),
    });
  }
  enrollment() {
    return this.request<Enrollment>("/v1/phone/enrollments/current");
  }
  home() {
    return this.request<Home>("/v1/phone/home");
  }
  upload(
    uri: string,
    key: string,
    context: string | null,
    signal: AbortSignal,
  ) {
    return this.request<Receipt>(
      "/v1/phone/turns",
      {
        method: "POST",
        body: new File(uri),
        headers: {
          "Content-Type": "audio/mp4",
          "Idempotency-Key": key,
          ...(context ? { "X-Context-Id": context } : {}),
        },
      },
      signal,
    );
  }
  receipt(key: string, signal?: AbortSignal) {
    return this.request<Receipt>(
      "/v1/phone/turn-receipts/" + encodeURIComponent(key),
      {},
      signal,
    );
  }
  turn(id: string, signal?: AbortSignal) {
    return this.request<TurnStatus>(
      "/v1/device/turns/" + encodeURIComponent(id),
      {},
      signal,
    );
  }
  confirm(id: string, context: string) {
    return this.request<{ status: "committed" }>(
      "/v1/phone/proposals/" + encodeURIComponent(id) + "/confirm",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context_id: context, confirmed: true }),
      },
    );
  }
  cancel(id: string, context: string) {
    return this.request(
      "/v1/phone/proposals/" + encodeURIComponent(id) + "/cancel",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context_id: context }),
      },
    );
  }
  speech(id: string, context: string) {
    return this.request<TurnEvent>(
      "/v1/phone/proposals/" + encodeURIComponent(id) + "/speech",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context_id: context }),
      },
    );
  }
  schedule() {
    return this.request<ReminderSchedule>("/v1/phone/reminder-schedule");
  }
  pending() {
    return this.request<{
      active_companion: Home["active_companion"];
      commands: Reminder[];
      checkins: Reminder[];
    }>("/v1/device/pending-commands");
  }
  currentReminder(id: string) {
    return this.request<Reminder>(
      "/v1/phone/reminders/" + encodeURIComponent(id),
    );
  }
  ack(command: string, id: string, stage: PlaybackStage) {
    return this.request("/v1/device/acks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: command, ack_id: id, stage }),
    });
  }
  notificationEvent(
    identity: string,
    eventId: string,
    stage: "scheduled" | "opened" | "suppressed" | "cancelled",
  ) {
    return this.request("/v1/phone/notification-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity, event_id: eventId, stage }),
    });
  }
  presence(body: Record<string, unknown>) {
    return this.request("/v1/phone/presence", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  pushRegistration() {
    return this.request<PushRegistration>(
      "/v1/phone/notification-registration",
    );
  }
  registerPush(token: string | null, state: PushRegistration) {
    return this.request<PushRegistration>(
      "/v1/phone/notification-registration",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          expected_version: state.version,
          expected_route_generation: state.active_companion.generation,
        }),
      },
    );
  }
  quiesce() {
    return this.request("/v1/phone/quiesce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playback_stopped: true,
        local_alerts_cleared: true,
      }),
    });
  }
  revoke() {
    return this.request("/v1/phone/installation", { method: "DELETE" });
  }
  private async fetchAudio<T>(
    path: string,
    signal: AbortSignal,
    method: "GET" | "HEAD",
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, method === "HEAD" ? 5000 : 30000);
    try {
      const response = await fetch(
        this.installation.service + audioPath(path),
        {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: { Authorization: "Bearer " + this.installation.credential },
        },
      );
      if (!response.ok)
        throw new ApiError(
          response.status,
          "This spoken reply is no longer available. Check the current care details.",
        );
      if (controller.signal.aborted)
        throw new Error("Spoken reply transfer was interrupted.");
      return await consume(response, controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  validateAudio(path: string, signal: AbortSignal) {
    return this.fetchAudio(path, signal, "HEAD", async () => {});
  }
  audio(path: string, signal: AbortSignal) {
    return this.fetchAudio(path, signal, "GET", async (response, transfer) => {
      const max = 768 * 1024;
      const length = Number(response.headers.get("Content-Length"));
      if (length > max) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Spoken reply exceeds its size limit.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Spoken reply body is missing.");
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      transfer.addEventListener("abort", abort, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        if (transfer.aborted) abort();
        while (true) {
          const { done, value } = await reader.read();
          if (transfer.aborted)
            throw new Error("Spoken reply transfer was interrupted.");
          if (done) break;
          size += value.length;
          if (size > max)
            throw new Error("Spoken reply exceeds its size limit.");
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      } finally {
        transfer.removeEventListener("abort", abort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }
}
