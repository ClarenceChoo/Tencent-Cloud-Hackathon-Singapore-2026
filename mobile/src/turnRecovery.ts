import type {
  Home,
  PendingTurn,
  Receipt,
  TurnEvent,
  TurnStatus,
} from "./contracts";
import { ApiError } from "./errors";

/** Serial, conditional updates prevent an old HTTP callback replacing a new turn. */
export class PendingTurnJournal {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: {
      read: () => Promise<PendingTurn | null>;
      write: (value: PendingTurn | null) => Promise<void>;
    },
  ) {}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }
  read() {
    return this.run(() => this.storage.read());
  }
  write(value: PendingTurn | null) {
    return this.run(async () => {
      const prior = value ? await this.storage.read() : null;
      if (value && prior && prior.key !== value.key)
        throw new Error("Recover or discard the unfinished recording first.");
      await this.storage.write(value);
    });
  }
  replace(key: string, value: PendingTurn | null) {
    return this.run(async () => {
      const prior = await this.storage.read();
      if (!prior || prior.key !== key) return false;
      if (value && value.key !== key)
        throw new Error("Recording identity changed.");
      await this.storage.write(value);
      return true;
    });
  }
}

export class RecoveryInterrupted extends Error {
  constructor() {
    super("Recovery paused. Parse will check this recording when you return.");
  }
}

export function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new RecoveryInterrupted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

type RecoveryPorts = {
  receipt: (key: string, signal: AbortSignal) => Promise<Receipt>;
  turn: (id: string, signal: AbortSignal) => Promise<TurnStatus>;
  retain: (pending: PendingTurn) => Promise<boolean>;
  clear: (key: string) => Promise<boolean>;
  refresh: () => Promise<Home | null>;
  current: () => boolean;
  received: () => void;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  polls?: number;
};
export type TurnResolution =
  | { kind: "receipt_unknown" }
  | { kind: "processing" }
  | { kind: "failed"; message: string }
  | { kind: "response"; event: TurnEvent; playable: boolean; stale: boolean };

/** Read-only recovery: never upload again, confirm a proposal, or play speech. */
export async function resolveAcceptedTurn(
  original: PendingTurn,
  ports: RecoveryPorts,
  signal: AbortSignal,
): Promise<TurnResolution> {
  const check = () => {
    if (signal.aborted || !ports.current()) throw new RecoveryInterrupted();
  };
  check();
  let pending = original;
  if (!pending.turnId) {
    let receipt: Receipt;
    try {
      receipt = await ports.receipt(pending.key, signal);
    } catch (error) {
      check();
      if (error instanceof ApiError && error.status === 404)
        return { kind: "receipt_unknown" };
      throw error;
    }
    check();
    pending = { ...pending, turnId: receipt.turn_id };
    if (!(await ports.retain(pending))) throw new RecoveryInterrupted();
    check();
  }
  ports.received();
  for (let count = 0; count < (ports.polls ?? 90); count++) {
    check();
    const result = await ports.turn(pending.turnId!, signal);
    check();
    if (result.status === "failed") {
      if (!(await ports.clear(pending.key))) throw new RecoveryInterrupted();
      check();
      return {
        kind: "failed",
        message:
          result.error ||
          "Speech could not be processed. No new confirmation was made.",
      };
    }
    if (result.event) {
      // Keep the accepted identifiers until the care view has reconciled. If this
      // request fails or the app leaves the foreground, the next run retries it.
      const home = await ports.refresh();
      check();
      if (!home) throw new RecoveryInterrupted();
      const event = result.event;
      const stale =
        event.payload.status === "awaiting_confirmation" &&
        home.current_proposal?.context_id !== event.payload.context_id;
      const playable =
        !stale &&
        Number.isFinite(Date.parse(event.expires_at)) &&
        Date.parse(event.expires_at) > Date.now();
      if (!(await ports.clear(pending.key))) throw new RecoveryInterrupted();
      check();
      return { kind: "response", event, playable, stale };
    }
    if (count + 1 < (ports.polls ?? 90))
      await (ports.delay ?? abortableDelay)(700, signal);
  }
  return { kind: "processing" };
}
