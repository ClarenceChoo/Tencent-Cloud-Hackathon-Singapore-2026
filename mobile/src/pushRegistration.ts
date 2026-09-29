import { ApiError } from "./errors";
import type { PushRegistration } from "./contracts";

/** Token acquisition may outlive a native screen; only guarded server writes
 * change Parse's installation. The caller drains this queue before handoff. */
export class PushRegistrationSync<TNative> {
  private epoch = 0;
  private revision = 0;
  private handledRevision = -1;
  private forcedRevision = -1;
  private knownVersion: number | null = null;
  private latestNative: TNative | undefined;
  private running: Promise<void> | null = null;
  private queued = false;
  private retryAt = 0;
  paused = false;
  constructor(
    private ports: {
      read: () => Promise<PushRegistration>;
      write: (
        token: string,
        state: PushRegistration,
      ) => Promise<PushRegistration>;
      acquire: (nativeToken?: TNative) => Promise<string>;
      current: () => boolean;
      configured: boolean;
      status: (message: string) => void;
      now?: () => number;
    },
  ) {}
  private now() {
    return (this.ports.now ?? Date.now)();
  }
  private current(epoch: number) {
    return !this.paused && epoch === this.epoch && this.ports.current();
  }
  private describe(state: PushRegistration) {
    if (!state.push_configured)
      return "The server push service is not enabled. Local scheduled alerts are separate.";
    if (!["granted", "provisional"].includes(state.notification_permission))
      return "Push updates are off because notification permission is not enabled.";
    if (state.active_companion.device_id !== state.device_id)
      return "Push updates go to the selected reminder companion.";
    if (state.registered)
      return "Push registration accepted. Delivery depends on phone settings and network access.";
    if (state.disabled)
      return "Push registration was disabled. Choose Enable alerts to try registering again.";
    return "This phone has no push registration yet.";
  }
  sync(force = false, nativeToken?: TNative): Promise<void> {
    if (force) {
      this.revision++;
      this.forcedRevision = this.revision;
      this.latestNative = nativeToken;
      this.retryAt = 0;
    }
    this.queued = true;
    if (this.running) return this.running;
    if (this.paused || !this.ports.current()) return Promise.resolve();
    const epoch = this.epoch;
    this.running = (async () => {
      while (this.queued && this.current(epoch)) {
        this.queued = false;
        const revision = this.revision;
        try {
          const state = await this.ports.read();
          if (!this.current(epoch)) return;
          this.ports.status(this.describe(state));
          if (!this.ports.configured) {
            this.ports.status(
              "Push updates are not configured for this build. Local scheduled alerts are separate.",
            );
            continue;
          }
          if (
            state.active_companion.device_id !== state.device_id ||
            !["granted", "provisional"].includes(state.notification_permission)
          )
            continue;
          const forced = this.forcedRevision > this.handledRevision;
          if (
            !forced &&
            (state.disabled ||
              (state.registered && state.version === this.knownVersion))
          )
            continue;
          if (this.now() < this.retryAt) continue;
          if (revision !== this.revision) {
            this.queued = true;
            continue;
          }
          const token = await this.ports.acquire(this.latestNative);
          if (!this.current(epoch)) return;
          if (revision !== this.revision) {
            this.queued = true;
            continue;
          }
          // Acquiring a native/Expo token may be slow. Preserve the route and
          // registration version observed before it, rather than overwriting a
          // newer server decision by silently fetching a fresh write version.
          const result = await this.ports.write(token, state);
          if (!this.current(epoch)) return;
          this.knownVersion = result.version;
          this.handledRevision = revision;
          this.ports.status(this.describe(result));
        } catch (error) {
          if (!this.current(epoch)) return;
          this.retryAt = this.now() + 30000;
          this.ports.status(
            error instanceof ApiError && error.status === 409
              ? "Push registration changed. Parse will refresh its state before retrying."
              : "Push registration could not be refreshed. Local alerts are separate; Parse will retry while open.",
          );
        }
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async pause() {
    this.paused = true;
    this.epoch++;
    this.queued = false;
    await this.running;
  }
  resume() {
    this.paused = false;
  }
}

/** Expo's token request has no AbortSignal option. Expire our interest in its
 * result; any eventual native response must still pass the caller's epoch. */
export function tokenDeadline<T>(work: Promise<T>, ms = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Push token request timed out")),
      ms,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
