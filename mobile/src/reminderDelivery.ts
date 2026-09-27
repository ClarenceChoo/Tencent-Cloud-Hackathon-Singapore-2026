import type { LedgerEntry, PlaybackStage, Reminder } from "./contracts";
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
  constructor(private ports: DeliveryPorts) {}
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
        const stage =
          entry.stage === "completed" ? "playback_completed" : "interrupted";
        await send(stage).catch(() => {});
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
      await send("playback_completed").catch(() => {});
      this.ports.completed(fresh);
      return "completed";
    } catch (error) {
      if (reserved && entry) {
        entry.stage = "interrupted";
        await this.ports.write(entry);
        await send("interrupted").catch(() => {});
      }
      throw error;
    } finally {
      this.running = false;
    }
  }
}
