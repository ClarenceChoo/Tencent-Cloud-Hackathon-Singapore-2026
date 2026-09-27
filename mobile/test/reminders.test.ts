import test from "node:test";
import assert from "node:assert/strict";
import { ReminderDelivery } from "../src/reminderDelivery";
import {
  AlertSerialiser,
  ALERT_BODY,
  desiredAlerts,
} from "../src/alertSchedule";
import type { LedgerEntry, Reminder, ReminderSchedule } from "../src/contracts";
const command: Reminder = {
  device_id: "dev_fixture",
  type: "reminder.play",
  expires_at: new Date(Date.now() + 120000).toISOString(),
  payload: {
    status: "reminder",
    command_id: "cmd_fixture",
    occurrence_id: "occ_fixture",
    route_generation: 2,
    context_id: "ctx_fixture",
    audio_paths: ["/v1/device/audio/audio_fixture"],
  },
};
function harness() {
  let entry: LedgerEntry | null = null;
  const events: string[] = [];
  const ports = {
    read: async () => (entry ? structuredClone(entry) : null),
    write: async (value: LedgerEntry) => {
      entry = structuredClone(value);
      events.push("persist:" + value.stage);
    },
    uuid: () => String(events.length),
    current: async () => {
      events.push("current");
      return command;
    },
    ack: async (_command: string, _id: string, stage: string) => {
      events.push("ack:" + stage);
    },
    cancelAlert: async () => {
      events.push("cancel-alert");
    },
    play: async (
      _command: Reminder,
      prepare: () => Promise<void>,
      authorize: () => Promise<void>,
    ) => {
      await prepare();
      await authorize();
      events.push("native-finished");
      return "completed" as const;
    },
    completed: () => {
      events.push("context-applied");
    },
  };
  return { ports, events, entry: () => entry };
}

test("native completion alone produces completed acknowledgement after durable start and fresh checks", async () => {
  const h = harness();
  const runner = new ReminderDelivery(h.ports);
  assert.equal(await runner.deliver(command), "completed");
  assert.ok(
    h.events.indexOf("persist:reserved") < h.events.indexOf("ack:received"),
  );
  assert.ok(
    h.events.indexOf("cancel-alert") < h.events.indexOf("ack:playback_started"),
  );
  assert.ok(
    h.events.indexOf("persist:started") <
      h.events.indexOf("ack:playback_started"),
  );
  assert.ok(
    h.events.indexOf("native-finished") <
      h.events.indexOf("ack:playback_completed"),
  );
  assert.equal(h.entry()?.stage, "completed");
  const played = h.events.filter((e) => e === "native-finished").length;
  assert.equal(await runner.deliver(command), "skipped");
  assert.equal(h.events.filter((e) => e === "native-finished").length, played);
});

test("process restart after reservation or playback start never repeats uncertain audio", async () => {
  for (const stage of ["reserved", "started", "interrupted"] as const) {
    const h = harness();
    await h.ports.write({
      command: command.payload.command_id,
      expires: Date.now() + 1000,
      stage,
      ackIds: {},
    });
    assert.equal(
      await new ReminderDelivery(h.ports).deliver(command),
      "skipped",
    );
    assert.ok(!h.events.includes("native-finished"));
    assert.ok(h.events.includes("ack:interrupted"));
  }
});

test("interruption never acknowledges completion and cannot replay on retry", async () => {
  const h = harness();
  h.ports.play = async (_event, prepare, authorize) => {
    await prepare();
    await authorize();
    throw new Error("Native interruption");
  };
  const delivery = new ReminderDelivery(h.ports);
  await assert.rejects(() => delivery.deliver(command), /Native interruption/);
  assert.equal(h.entry()?.stage, "interrupted");
  assert.ok(!h.events.includes("ack:playback_completed"));
  assert.equal(await delivery.deliver(command), "skipped");
});

test("busy voice leaves no ledger reservation and storage failure prevents sound", async () => {
  const h = harness();
  h.ports.play = async () => "busy" as never;
  assert.equal(await new ReminderDelivery(h.ports).deliver(command), "busy");
  assert.equal(h.entry(), null);
  const failed = harness();
  failed.ports.write = async () => {
    throw new Error("Secure storage unavailable");
  };
  await assert.rejects(
    () => new ReminderDelivery(failed.ports).deliver(command),
    /Secure storage/,
  );
  assert.ok(!failed.events.includes("native-finished"));
});

test("lost completion acknowledgement retries its original identity without playing again", async () => {
  const h = harness();
  const ids: string[] = [];
  h.ports.ack = async (_command, id, stage) => {
    if (stage === "playback_completed") {
      ids.push(id);
      throw new Error("offline");
    }
  };
  const runner = new ReminderDelivery(h.ports);
  assert.equal(await runner.deliver(command), "completed");
  assert.equal(await runner.deliver(command), "skipped");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(h.events.filter((e) => e === "native-finished").length, 1);
});

const schedule: ReminderSchedule = {
  device_id: "dev_fixture",
  server_time: "2026-09-27T00:00:00Z",
  valid_until: "2026-09-28T00:00:00Z",
  covered_until: "2026-09-28T00:00:00Z",
  revision: "fixture",
  truncated: false,
  active_companion: { device_id: "dev_fixture", generation: 2 },
  title: "Parse",
  body: ALERT_BODY,
  alerts: [
    {
      identity: "parse.dev_fixture.occ_fixture.g2",
      occurrence_id: "occ_fixture",
      route_generation: 2,
      due_at: "2026-09-27T01:00:00Z",
      expires_at: "2026-09-27T01:02:00Z",
    },
  ],
};

test("local alerts honor route generation, a 24-hour horizon and device clock offset", () => {
  assert.deepEqual(desiredAlerts(schedule, 1000), [
    { id: schedule.alerts[0]!.identity, at: 3601000 },
  ]);
  assert.deepEqual(
    desiredAlerts(
      { ...schedule, active_companion: { device_id: "other", generation: 3 } },
      1000,
    ),
    [],
  );
  assert.throws(() =>
    desiredAlerts(
      { ...schedule, alerts: [...schedule.alerts, ...schedule.alerts] },
      1000,
    ),
  );
  assert.throws(() =>
    desiredAlerts({ ...schedule, valid_until: "2026-09-29T00:00:00Z" }, 1000),
  );
  assert.throws(() =>
    desiredAlerts(
      {
        ...schedule,
        alerts: [{ ...schedule.alerts[0]!, route_generation: 1 }],
      },
      1000,
    ),
  );
});

test("quiescence invalidates a delayed sync before cancelling alerts and cannot reschedule them", async () => {
  const serial = new AlertSerialiser();
  let release!: () => void;
  let scheduled = false,
    cleared = false;
  const sync = serial.run(async (current) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (current()) scheduled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  const clear = serial.clear(async () => {
    cleared = true;
  });
  release();
  await Promise.all([sync, clear]);
  assert.equal(scheduled, false);
  assert.equal(cleared, true);
  assert.equal(serial.suspended, true);
});
