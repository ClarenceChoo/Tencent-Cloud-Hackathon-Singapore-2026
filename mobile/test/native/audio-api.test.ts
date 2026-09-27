import { afterEach, beforeEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({
  fetch: vi.fn(),
  read: vi.fn(),
  size: 16,
  type: "audio/x-m4a",
}));
vi.mock("expo/fetch", () => ({ fetch: transport.fetch }));
vi.mock("expo-file-system", () => ({
  File: class {
    get size() {
      return transport.size;
    }
    get type() {
      return transport.type;
    }
    arrayBuffer() {
      return transport.read();
    }
  },
}));
// Load the actual pinned implementation without importing Expo's internal web
// FormData declarations into the native application's TypeScript program.
const expoRequestUtils = "../../node_modules/expo/src/winter/fetch/RequestUtils.ts";
const { normalizeBodyInitAsync, normalizeHeadersInit, overrideHeaders } =
  await import(expoRequestUtils);
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
  transport.size = 16;
  transport.type = "audio/x-m4a";
  transport.read.mockResolvedValue(
    new Uint8Array([
      0, 0, 0, 16, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0,
    ]).buffer,
  );
});
it.each(["audio/mpeg", "audio/x-m4a", ""])(
  "upload keeps the AAC container MIME when the filesystem reports %s",
  async (mime) => {
    transport.type = mime;
    let wireHeaders: [string, string][] = [];
    transport.fetch.mockImplementation(async (_url, options) => {
      // Exercise the pinned Expo normalizer that overrides headers for File bodies.
      const normalized = await normalizeBodyInitAsync(options.body);
      wireHeaders = overrideHeaders(
        normalizeHeadersInit(options.headers),
        normalized.overriddenHeaders ?? [],
      );
      expect(normalized.body?.slice(4, 8)).toEqual(
        new Uint8Array([102, 116, 121, 112]),
      );
      return Response.json({ turn_id: "native-turn", status: "received" });
    });
    await api.upload(
      "file:///private/cache/recording.m4a",
      "upload-key",
      "context",
      signal(),
    );
    expect(Object.fromEntries(wireHeaders)).toMatchObject({
      "Content-Type": "audio/mp4",
      "Idempotency-Key": "upload-key",
      "X-Context-Id": "context",
      Authorization: "Bearer private-fixture",
    });
  },
);
it("an oversized recording is refused before loading its bytes", async () => {
  transport.size = 2 * 1024 * 1024 + 1;
  await expect(
    api.upload("file:///cache/recording.m4a", "key", null, signal()),
  ).rejects.toThrow("size limit");
  expect(transport.read).not.toHaveBeenCalled();
  expect(transport.fetch).not.toHaveBeenCalled();
});
it("a recording that changes while reading is checked again before upload", async () => {
  transport.read.mockResolvedValue(new ArrayBuffer(2 * 1024 * 1024 + 1));
  await expect(
    api.upload("file:///cache/recording.m4a", "key", null, signal()),
  ).rejects.toThrow("size limit");
  expect(transport.fetch).not.toHaveBeenCalled();
});
it("cancellation during file read never admits a later upload", async () => {
  const controller = new AbortController();
  let finish!: (buffer: ArrayBuffer) => void;
  transport.read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const upload = api.upload(
    "file:///cache/recording.m4a",
    "key",
    null,
    controller.signal,
  );
  controller.abort();
  finish(new ArrayBuffer(16));
  await expect(upload).rejects.toThrow("interrupted");
  expect(transport.fetch).not.toHaveBeenCalled();
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
