import type { LedgerEntry, PlaybackStage, Reminder } from "./contracts";
import { ApiError } from "./errors";
export interface DeliveryPorts {
  read: (command: string) => Promise<LedgerEntry | null>;
  write: (entry: LedgerEntry) => Promise<void>;
  uuid: () => string;
  current: (command: string) => Promise<Reminder>;
  ack: (command: string, id: string, stage: PlaybackStage) => Promise<unknown>;
  cancelAlert: (identity: string) => Promise<void>;
  play: (
    command: Reminder,
    prepare: () => Promise<void>,
    authorize: () => Promise<void>,
  ) => Promise<"completed" | "busy">;
  completed: (command: Reminder) => void;
}
export class ReminderDelivery {
  private running = false;
  private waiters: (() => void)[] = [];
  constructor(private ports: DeliveryPorts) {}
  whenIdle(): Promise<void> {
    return this.running
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve();
  }
  private finish() {
    this.running = false;
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
  private async settle(entry: LedgerEntry) {
    if (entry.terminalAck) return;
    const stage =
      entry.stage === "completed" ? "playback_completed" : "interrupted";
    if (entry.stage !== "completed") entry.stage = "interrupted";
    entry.ackIds[stage] ||= this.ports.uuid();
    await this.ports.write(entry);
    try {
      await this.ports.ack(entry.command, entry.ackIds[stage]!, stage);
      entry.terminalAck = "recorded";
    } catch (error) {
      if (error instanceof ApiError && [404, 409, 410].includes(error.status))
        entry.terminalAck = "rejected";
      else throw error; // Keep the same id for an unknown/transient result.
    }
    await this.ports.write(entry);
  }
  /** Reconcile durable evidence even when the server no longer queues the command. */
  async reconcile(entries: LedgerEntry[], current: () => boolean = () => true) {
    if (this.running) return;
    this.running = true;
    try {
      for (const entry of entries) {
        if (!current()) break;
        await this.settle(entry);
      }
    } finally {
      this.finish();
    }
  }
  async deliver(command: Reminder): Promise<"completed" | "skipped" | "busy"> {
    if (this.running) return "busy";
    this.running = true;
    let entry: LedgerEntry | null = null;
    let reserved = false;
    const send = async (stage: PlaybackStage) => {
      entry!.ackIds[stage] ||= this.ports.uuid();
      await this.ports.write(entry!); // Persist retry identity before any network call.
      await this.ports.ack(
        command.payload.command_id,
        entry!.ackIds[stage]!,
        stage,
      );
    };
    try {
      entry = await this.ports.read(command.payload.command_id);
      if (entry) {
        // An app killed after reservation/start cannot know whether speech occurred.
        // Never replay it. Retry only the corresponding terminal evidence.
        await this.settle(entry).catch(() => {});
        return "skipped";
      }
      if (Date.parse(command.expires_at) <= Date.now()) return "skipped";
      const fresh = await this.ports.current(command.payload.command_id);
      if (fresh.payload.route_generation !== command.payload.route_generation)
        return "skipped";
      entry = {
        command: command.payload.command_id,
        expires: Date.parse(command.expires_at),
        stage: "reserved",
        ackIds: {},
      };
      const identity = `parse.${command.device_id}.${command.payload.occurrence_id}.g${command.payload.route_generation}`;
      const result = await this.ports.play(
        fresh,
        async () => {
          await this.ports.write(entry!);
          reserved = true;
          await this.ports.cancelAlert(identity);
          await send("received");
        },
        async () => {
          await this.ports.current(command.payload.command_id);
          entry!.stage = "started";
          await this.ports.write(entry!);
          await send("playback_started");
        },
      );
      if (result === "busy") return "busy";
      entry.stage = "completed";
      await this.ports.write(entry);
      await this.settle(entry).catch(() => {});
      this.ports.completed(fresh);
      return "completed";
    } catch (error) {
      if (reserved && entry) {
        entry.stage = "interrupted";
        await this.ports.write(entry);
        await this.settle(entry).catch(() => {});
      }
      throw error;
    } finally {
      this.finish();
    }
  }
}
