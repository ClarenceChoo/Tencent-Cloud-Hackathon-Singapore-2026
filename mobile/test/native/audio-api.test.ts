import { afterEach, beforeEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("expo/fetch", () => ({ fetch: transport.fetch }));
vi.mock("expo-file-system", () => ({ File: class {} }));
import { PhoneApi } from "../../src/api";
const path = "/v1/device/audio/audio_" + "a".repeat(32);
const api = new PhoneApi({
  version: 1,
  service: "https://parse.example.invalid",
  credential: "private-fixture",
  enrollmentKey: "fixture",
  platform: "ios",
  displayName: "Phone",
});
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});
it("freshness checks authenticate with HEAD, refuse redirects and carry no audio body", async () => {
  transport.fetch.mockResolvedValue(new Response(null, { status: 200 }));
  await api.validateAudio(path, signal());
  expect(transport.fetch).toHaveBeenCalledWith(
    "https://parse.example.invalid" + path,
    expect.objectContaining({
      method: "HEAD",
      redirect: "error",
      headers: { Authorization: "Bearer private-fixture" },
    }),
  );
  for (const status of [401, 403, 404, 410]) {
    transport.fetch.mockResolvedValue(new Response(null, { status }));
    await expect(api.validateAudio(path, signal())).rejects.toMatchObject({
      status,
    });
  }
});
it("a streamed reply is reconstructed without requiring a Content-Length header", async () => {
  transport.fetch.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          c.enqueue(new Uint8Array([3]));
          c.close();
        },
      }),
    ),
  );
  expect(await api.audio(path, signal())).toEqual(new Uint8Array([1, 2, 3]));
});
it("oversized declared and chunked bodies are cancelled before native playback", async () => {
  const cancel = vi.fn();
  transport.fetch.mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Length": "900000" },
    }),
  );
  await expect(api.audio(path, signal())).rejects.toThrow("size limit");
  expect(cancel).toHaveBeenCalledOnce();
  const streamCancel = vi.fn();
  let chunks = 0;
  transport.fetch.mockResolvedValue(
    new Response(
      new ReadableStream(
        {
          pull(c) {
            chunks++;
            c.enqueue(new Uint8Array(256 * 1024));
          },
          cancel: streamCancel,
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  await expect(api.audio(path, signal())).rejects.toThrow("size limit");
  expect(chunks).toBe(4);
  expect(streamCancel).toHaveBeenCalledOnce();
});
it("aborting a stalled body cancels the stream and retains no incomplete reply", async () => {
  const cancel = vi.fn();
  const controller = new AbortController();
  transport.fetch.mockResolvedValue(
    new Response(new ReadableStream({ cancel })),
  );
  const task = api.audio(path, controller.signal);
  const rejected = expect(task).rejects.toThrow("interrupted");
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([
  ["HEAD", 5000],
  ["GET", 30000],
] as const)("%s request has a bounded timeout", async (method, timeout) => {
  transport.fetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
  );
  const task =
    method === "HEAD"
      ? api.validateAudio(path, signal())
      : api.audio(path, signal());
  const rejected = expect(task).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(timeout);
  await rejected;
  expect(transport.fetch.mock.calls[0]![1].signal.aborted).toBe(true);
});
it("a body that stalls after headers still hits the total transfer timeout", async () => {
  const cancel = vi.fn();
  transport.fetch.mockResolvedValue(
    new Response(new ReadableStream({ cancel })),
  );
  const task = api.audio(path, signal());
  const rejected = expect(task).rejects.toThrow("interrupted");
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
});
