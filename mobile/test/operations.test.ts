import test from "node:test";
import assert from "node:assert/strict";
import { Operations } from "../src/operations";

test("quiescence waits for native cleanup and rejects new playback until verification", async () => {
  const operations = new Operations();
  let resolve!: () => void;
  let verified = false;
  const task = operations.run(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const stop = operations.stop(
    async () => {},
    async () => {
      verified = true;
    },
  );
  assert.equal(operations.closed, true);
  assert.equal(
    await operations.run(async () => {
      throw new Error("Must never start");
    }),
    undefined,
  );
  await Promise.resolve();
  assert.equal(verified, false);
  resolve();
  await task;
  await stop;
  assert.equal(verified, true);
  assert.equal(operations.closed, false);
});

test("failed native verification cannot yield a successful handoff", async () => {
  const operations = new Operations();
  let attested = false;
  await assert.rejects(async () => {
    await operations.stop(
      async () => {},
      async () => {
        throw new Error("Audio still active");
      },
    );
    attested = true;
  }, /Audio still active/);
  assert.equal(attested, false);
});

test("a second stop still performs its own handoff verification", async () => {
  const operations = new Operations();
  const steps: string[] = [];
  let finish!: () => void;
  const first = operations.stop(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    async () => {
      steps.push("first");
    },
  );
  const second = operations.stop(
    async () => {},
    async () => {
      steps.push("handoff");
    },
  );
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(steps, ["first", "handoff"]);
});

test("a failed native stop drains old callbacks and keeps admission closed until a verified retry", async () => {
  const operations = new Operations();
  let release!: () => void;
  const pending = operations.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let finished = false,
    attested = false;
  const stop = operations.stop(
    async () => {
      throw new Error("Native stop failed");
    },
    async () => {
      attested = true;
    },
  );
  const rejected = assert.rejects(stop, /Native stop failed/).then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(operations.closed, true);
  release();
  await pending;
  await rejected;
  assert.equal(attested, false);
  assert.equal(operations.closed, true);
  assert.equal(await operations.run(async () => "must not start"), undefined);
  await operations.stop(
    async () => {},
    async () => {
      attested = true;
    },
  );
  assert.equal(attested, true);
  assert.equal(operations.closed, false);
});
