import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/errors";
import {
  PendingTurnJournal,
  resolveAcceptedTurn,
  RecoveryInterrupted,
  abortableDelay,
} from "../src/turnRecovery";
import type {
  Home,
  PendingTurn,
  TurnEvent,
  TurnStatus,
} from "../src/contracts";

const original: PendingTurn = {
  key: "same-upload-key",
  context: "original-context",
  createdAt: 123,
};
function harness() {
  let saved: PendingTurn | null = structuredClone(original);
  const calls: string[] = [];
  const journal = new PendingTurnJournal({
    read: async () => saved && structuredClone(saved),
    write: async (value) => {
      saved = value && structuredClone(value);
    },
  });
  const event: TurnEvent = {
    expires_at: new Date(Date.now() + 120000).toISOString(),
    payload: {
      status: "awaiting_confirmation",
      context_id: "readback",
      spoken_text: "Unsaved note. Is that right?",
    },
  };
  const receipt = {
    turn_id: "accepted-turn",
    status: "accepted",
    received_at: "2026-09-27T00:00:00Z",
  };
  const ports = {
    receipt: async (key: string, _signal: AbortSignal) => {
      calls.push("receipt:" + key);
      return receipt;
    },
    turn: async (id: string, _signal: AbortSignal): Promise<TurnStatus> => {
      calls.push("turn:" + id);
      return {
        ...receipt,
        event,
        error: null,
        status: "awaiting_confirmation",
      };
    },
    retain: (pending: PendingTurn) => journal.replace(pending.key, pending),
    clear: async (key: string) => {
      calls.push("clear");
      return journal.replace(key, null);
    },
    refresh: async (): Promise<Home | null> => {
      calls.push("refresh");
      return { current_proposal: { context_id: "readback" } } as Home;
    },
    current: () => true,
    received: () => {
      calls.push("received");
    },
    delay: async () => {},
    polls: 3,
  };
  return { ports, journal, calls, event, receipt, saved: () => saved };
}

test("lost receipt recovery retains the original turn/context and refreshes care before clearing", async () => {
  const h = harness();
  const read = h.ports.turn;
  h.ports.turn = async (id, signal) => {
    assert.deepEqual(h.saved(), { ...original, turnId: "accepted-turn" });
    return read(id, signal);
  };
  const result = await resolveAcceptedTurn(
    original,
    h.ports,
    new AbortController().signal,
  );
  assert.equal(result.kind, "response");
  assert.equal(h.calls.filter((c) => c.startsWith("receipt:")).length, 1);
  assert.ok(h.calls.indexOf("refresh") < h.calls.indexOf("clear"));
  assert.equal(h.saved(), null);
  // This resolver has no upload, confirmation or audio port: reconciliation is read-only.
});

test("missing receipts remain unknown; a later foreground pass recovers without another upload", async () => {
  const h = harness();
  const receipt = h.ports.receipt;
  h.ports.receipt = async () => {
    throw new ApiError(404, "Not found");
  };
  assert.deepEqual(
    await resolveAcceptedTurn(original, h.ports, new AbortController().signal),
    { kind: "receipt_unknown" },
  );
  assert.deepEqual(h.saved(), original);
  assert.deepEqual(h.calls, []);
  h.ports.receipt = receipt;
  assert.equal(
    (
      await resolveAcceptedTurn(
        h.saved()!,
        h.ports,
        new AbortController().signal,
      )
    ).kind,
    "response",
  );
});

test("accepted results survive a failed care refresh and resume using the retained turn ID", async () => {
  const h = harness();
  const refresh = h.ports.refresh;
  h.ports.refresh = async () => {
    throw new ApiError(503, "offline");
  };
  await assert.rejects(
    () => resolveAcceptedTurn(original, h.ports, new AbortController().signal),
    /offline/,
  );
  assert.equal(h.saved()?.turnId, "accepted-turn");
  h.ports.refresh = refresh;
  assert.equal(
    (
      await resolveAcceptedTurn(
        h.saved()!,
        h.ports,
        new AbortController().signal,
      )
    ).kind,
    "response",
  );
  assert.equal(h.calls.filter((c) => c.startsWith("receipt:")).length, 1);
});

test("background/stop while refreshing retains recovery state and cannot expose a playable result", async () => {
  const h = harness();
  const controller = new AbortController();
  const refresh = h.ports.refresh;
  h.ports.refresh = async () => {
    controller.abort();
    return refresh();
  };
  await assert.rejects(
    () => resolveAcceptedTurn(original, h.ports, controller.signal),
    RecoveryInterrupted,
  );
  assert.equal(h.saved()?.turnId, "accepted-turn");
  assert.ok(!h.calls.includes("clear"));
});

test("stale readbacks and expired speech reconcile records but never become playable", async () => {
  for (const kind of ["stale", "expired"] as const) {
    const h = harness();
    if (kind === "stale") h.event.payload.context_id = "replaced";
    else h.event.expires_at = new Date(Date.now() - 1000).toISOString();
    const result = await resolveAcceptedTurn(
      original,
      h.ports,
      new AbortController().signal,
    );
    assert.equal(result.kind, "response");
    if (result.kind !== "response") throw new Error("Expected response");
    assert.equal(result.playable, false);
    assert.equal(result.stale, kind === "stale");
    assert.equal(h.saved(), null);
  }
});

test("bounded processing polls preserve pending identity; terminal provider failure clears only that turn", async () => {
  const h = harness();
  h.ports.turn = async () => ({
    ...h.receipt,
    event: null,
    error: null,
    status: "processing",
  });
  assert.deepEqual(
    await resolveAcceptedTurn(original, h.ports, new AbortController().signal),
    { kind: "processing" },
  );
  const pending = h.saved()!;
  h.ports.turn = async () => ({
    ...h.receipt,
    event: null,
    error: "Speech unavailable",
    status: "failed",
  });
  assert.deepEqual(
    await resolveAcceptedTurn(pending, h.ports, new AbortController().signal),
    { kind: "failed", message: "Speech unavailable" },
  );
  assert.equal(h.saved(), null);
});

test("late callbacks cannot resurrect a discarded turn or clear a newer recording", async () => {
  const h = harness();
  await assert.rejects(
    () => h.journal.write({ ...original, key: "next" }),
    /unfinished/,
  );
  let release!: () => void;
  const originalReceipt = h.ports.receipt;
  h.ports.receipt = async (key, signal) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return originalReceipt(key, signal);
  };
  const pending = resolveAcceptedTurn(
    original,
    h.ports,
    new AbortController().signal,
  );
  await h.journal.write(null);
  await h.journal.write({ ...original, key: "next" });
  release();
  await assert.rejects(() => pending, RecoveryInterrupted);
  assert.equal(h.saved()?.key, "next");
  assert.equal(await h.journal.replace(original.key, null), false);
});

test("secure storage failure prevents recovery completion; explicit discard repairs unreadable state", async () => {
  const h = harness();
  h.ports.retain = async () => {
    throw new Error("Secure storage unavailable");
  };
  await assert.rejects(
    () => resolveAcceptedTurn(original, h.ports, new AbortController().signal),
    /Secure storage/,
  );
  assert.ok(!h.calls.some((c) => c.startsWith("turn:")));
  let cleared = false;
  const broken = new PendingTurnJournal({
    read: async () => {
      throw new Error("corrupt");
    },
    write: async (value) => {
      cleared = value === null;
    },
  });
  await broken.write(null);
  assert.equal(cleared, true);
});

test("poll delay cancels immediately on focus loss instead of waiting for the timer", async () => {
  const controller = new AbortController();
  const wait = abortableDelay(60000, controller.signal);
  controller.abort();
  await assert.rejects(() => wait, RecoveryInterrupted);
});
