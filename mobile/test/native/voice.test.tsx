/** React hook integration with controlled native adapters, not phone evidence. */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors";
import type { PhoneApi } from "../../src/api";
import type { Home, PendingTurn, TurnEvent } from "../../src/contracts";

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(value?: string) => void>>(),
  appState: { currentState: "active", addEventListener: vi.fn() },
  permission: vi.fn(),
  checkPermission: vi.fn(),
  mode: vi.fn(),
  active: vi.fn(),
  recorder: {
    uri: "file:///cache/recording-test.m4a",
    prepareToRecordAsync: vi.fn(),
    record: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn(),
  },
  recording: false,
  duration: 1200,
  recordingListener: null as null | ((status: Record<string, unknown>) => void),
  playerFactory: vi.fn(),
  players: [] as Array<{
    isLoaded: boolean;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    addListener: ReturnType<typeof vi.fn>;
    emit: (value: Record<string, unknown>) => void;
  }>,
  files: new Set<string>(),
  deleted: [] as string[],
  pending: null as PendingTurn | null,
  load: vi.fn(),
  save: vi.fn(),
  retain: vi.fn(),
  clear: vi.fn(),
  uuid: 0,
}));
vi.mock("react-native", () => ({ AppState: native.appState }));
vi.mock("expo-audio", () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: native.permission,
    getRecordingPermissionsAsync: native.checkPermission,
  },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: native.mode,
  setIsAudioActiveAsync: native.active,
  useAudioRecorder: (_: unknown, listener: typeof native.recordingListener) => {
    native.recordingListener ||= listener;
    return native.recorder;
  },
  createAudioPlayer: native.playerFactory,
}));
vi.mock("expo-crypto", () => ({
  randomUUID: () => `fixture-${++native.uuid}`,
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: async () => {},
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache/" } },
  File: class {
    uri: string;
    constructor(_path: unknown, name: string) {
      this.uri = "file:///cache/" + name;
    }
    write() {
      native.files.add(this.uri);
    }
  },
}));
vi.mock("../../src/api", async () => ({
  ApiError: (await import("../../src/errors")).ApiError,
}));
vi.mock("../../src/storage", () => ({
  loadPending: native.load,
  savePending: native.save,
  retainPending: native.retain,
  clearPending: native.clear,
  removeAudio: (uri: string) => {
    native.files.delete(uri);
    native.deleted.push(uri);
  },
  sweepAudio: () => native.files.clear(),
}));
import { useVoice } from "../../src/useVoice";

function wav(seconds = 0.4) {
  const bytes = new Uint8Array(44 + seconds * 32000),
    view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => (bytes[offset + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes.length - 44, true);
  return bytes;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const reply = (count = 1): TurnEvent => ({
  expires_at: new Date(Date.now() + 60000).toISOString(),
  payload: {
    status: "completed",
    spoken_text: "A fictional reply",
    audio_paths: Array.from(
      { length: count },
      (_, i) => `/v1/device/audio/audio_${i}`,
    ),
  },
});
let voice!: ReturnType<typeof useVoice>, root: ReactTestRenderer;
let api: ReturnType<typeof makeApi>;
function makeApi() {
  return {
    audio: vi.fn(async () => wav()),
    validateAudio: vi.fn(async () => {}),
    currentReminder: vi.fn(async () => ({})),
    upload: vi.fn(
      async (
        _uri: string,
        _key: string,
        _context: string | null,
        _signal: AbortSignal,
      ) => ({ turn_id: "turn_one" }),
    ),
    turn: vi.fn(async () => ({ status: "completed", event: reply() })),
    receipt: vi.fn(async () => ({ turn_id: "turn_one" })),
  };
}
function Harness({
  client = api,
  context = "original-context",
}: {
  client?: typeof api;
  context?: string;
}) {
  voice = useVoice(
    client as unknown as PhoneApi,
    context,
    async () => ({ current_proposal: null }) as Home,
  );
  return null;
}
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function start(work: () => Promise<unknown>) {
  let task!: Promise<unknown>;
  await act(async () => {
    task = work();
    await drain();
  });
  return { task };
}
async function emit(
  value: Record<string, unknown>,
  index = native.players.length - 1,
) {
  await act(async () => {
    native.players[index]!.emit(value);
    await drain();
  });
}
async function background(event = "change") {
  await act(async () => {
    if (event === "change") native.appState.currentState = "background";
    native.listeners
      .get(event)
      ?.forEach((listener) =>
        listener(event === "change" ? "background" : undefined),
      );
    await drain();
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  native.listeners.clear();
  native.appState.currentState = "active";
  native.files.clear();
  native.deleted = [];
  native.pending = null;
  native.players = [];
  native.recording = false;
  native.duration = 1200;
  native.recordingListener = null;
  native.appState.addEventListener.mockImplementation((name, listener) => {
    const set = native.listeners.get(name) || new Set();
    set.add(listener);
    native.listeners.set(name, set);
    return { remove: () => set.delete(listener) };
  });
  native.permission.mockResolvedValue({ granted: true });
  native.checkPermission.mockResolvedValue({
    granted: true,
    status: "granted",
  });
  native.mode.mockResolvedValue(undefined);
  native.active.mockResolvedValue(undefined);
  native.recorder.prepareToRecordAsync.mockImplementation(async () => {
    native.files.add(native.recorder.uri);
  });
  native.recorder.record.mockImplementation(() => {
    native.recording = true;
  });
  native.recorder.stop.mockImplementation(async () => {
    native.recording = false;
  });
  native.recorder.getStatus.mockImplementation(() => ({
    isRecording: native.recording,
    canRecord: true,
    durationMillis: native.duration,
    mediaServicesDidReset: false,
  }));
  native.load.mockImplementation(async () => native.pending);
  native.save.mockImplementation(async (p) => {
    native.pending = p;
  });
  native.retain.mockImplementation(async (p) => {
    native.pending = p;
    return true;
  });
  native.clear.mockImplementation(async () => {
    native.pending = null;
    return true;
  });
  native.playerFactory.mockImplementation(() => {
    let listener: (value: Record<string, unknown>) => void = () => {};
    const player = {
      isLoaded: true,
      play: vi.fn(),
      pause: vi.fn(),
      release: vi.fn(),
      addListener: vi.fn((_name, cb) => {
        listener = cb;
        return {
          remove: () => {
            listener = () => {};
          },
        };
      }),
      emit: (value: Record<string, unknown>) =>
        listener({ isLoaded: true, isBuffering: false, ...value }),
    };
    player.play.mockImplementation(() => player.emit({ playing: true }));
    native.players.push(player);
    return player;
  });
  api = makeApi();
  await act(async () => {
    root = create(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await drain();
  });
  vi.useRealTimers();
});

it("releasing while microphone permission is pending never starts capture", async () => {
  const gate = deferred<{ granted: boolean }>();
  native.checkPermission.mockResolvedValueOnce({ granted: false });
  native.permission.mockReturnValue(gate.promise);
  const running = await start(() => voice.begin());
  expect(voice.phase).toBe("preparing");
  await act(async () => {
    await voice.finish();
    gate.resolve({ granted: true });
    await running.task;
  });
  expect(native.recorder.record).not.toHaveBeenCalled();
  expect(api.upload).not.toHaveBeenCalled();
});
it("permission-dialog blur explains the cancelled start and requires a fresh deliberate press", async () => {
  const gate = deferred<{ granted: boolean }>();
  native.checkPermission.mockResolvedValueOnce({ granted: false });
  native.permission.mockReturnValueOnce(gate.promise);
  const running = await start(() => voice.begin());
  await background("blur");
  await act(async () => {
    gate.resolve({ granted: true });
    await running.task;
  });
  expect(voice.phase).toBe("idle");
  expect(voice.message).toContain("Recording did not start");
  expect(native.recorder.record).not.toHaveBeenCalled();
  expect(api.upload).not.toHaveBeenCalled();
  await act(async () => {
    native.listeners.get("focus")?.forEach((listener) => listener());
    await drain();
  });
  expect(native.recorder.record).not.toHaveBeenCalled();
  await act(async () => {
    await voice.begin();
  });
  expect(native.recorder.record).toHaveBeenCalledOnce();
  expect(voice.phase).toBe("recording");
});
it("an existing microphone grant starts capture without relaunching Android permission UI", async () => {
  native.permission.mockImplementation(async () => {
    native.listeners.get("blur")?.forEach((listener) => listener());
    return { granted: true };
  });
  await act(async () => {
    await voice.begin();
  });
  expect(native.permission).not.toHaveBeenCalled();
  expect(native.recorder.record).toHaveBeenCalledOnce();
  expect(voice.phase).toBe("recording");
});
it("release during permission lookup cannot open a later permission request", async () => {
  const gate = deferred<{ granted: boolean }>();
  native.checkPermission.mockReturnValueOnce(gate.promise);
  const running = await start(() => voice.begin());
  await act(async () => {
    await voice.finish();
    gate.resolve({ granted: false });
    await running.task;
  });
  expect(native.permission).not.toHaveBeenCalled();
  expect(native.recorder.record).not.toHaveBeenCalled();
  expect(api.upload).not.toHaveBeenCalled();
  expect(voice.message).toContain("Recording did not start");
});
it("cancel and handoff wait for a pending native preparation and delete its file", async () => {
  const gate = deferred<void>();
  native.recorder.prepareToRecordAsync.mockImplementation(async () => {
    native.files.add(native.recorder.uri);
    await gate.promise;
  });
  const beginning = await start(() => voice.begin());
  const after = vi.fn(async () => {});
  const stopping = await start(() => voice.stop(after));
  expect(after).not.toHaveBeenCalled();
  await act(async () => {
    gate.resolve();
    await beginning.task;
    await stopping.task;
  });
  expect(native.recorder.record).not.toHaveBeenCalled();
  expect(native.files.size).toBe(0);
  expect(after).toHaveBeenCalledOnce();
});
it("setup failure stops native audio and removes any partial capture", async () => {
  native.recorder.prepareToRecordAsync.mockImplementation(async () => {
    native.files.add(native.recorder.uri);
    throw new Error("Microphone unavailable");
  });
  await act(async () => {
    await voice.begin();
  });
  expect(voice.message).toContain("Microphone unavailable");
  expect(native.files.size).toBe(0);
  expect(native.active).toHaveBeenLastCalledWith(false);
  expect(api.upload).not.toHaveBeenCalled();
});
it.each(["change", "blur"])(
  "%s interruption discards capture and never uploads",
  async (event) => {
    await act(async () => {
      await voice.begin();
    });
    expect(voice.phase).toBe("recording");
    await background(event);
    expect(native.recording).toBe(false);
    expect(native.files.size).toBe(0);
    expect(api.upload).not.toHaveBeenCalled();
  },
);
it("a native recorder pause without a finished event cancels instead of uploading partial speech", async () => {
  await act(async () => {
    await voice.begin();
  });
  native.recording = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(voice.phase).not.toBe("recording");
  expect(native.files.size).toBe(0);
  expect(api.upload).not.toHaveBeenCalled();
});
it("audio mode cleanup failure still deletes the capture and prevents upload", async () => {
  await act(async () => {
    await voice.begin();
  });
  native.mode.mockRejectedValueOnce(new Error("Audio session failed"));
  await act(async () => {
    await voice.finish();
  });
  expect(native.files.size).toBe(0);
  expect(api.upload).not.toHaveBeenCalled();
  expect(voice.phase).toBe("error");
});
it("an installation change during native preparation cannot record or use the old identity", async () => {
  const gate = deferred<void>();
  native.recorder.prepareToRecordAsync.mockImplementation(() => gate.promise);
  const beginning = await start(() => voice.begin());
  await act(async () => {
    root.update(<Harness client={makeApi()} />);
  });
  await act(async () => {
    gate.resolve();
    await beginning.task;
  });
  expect(native.recorder.record).not.toHaveBeenCalled();
  expect(api.upload).not.toHaveBeenCalled();
});
it("release captures its original context once and deletes input after acceptance", async () => {
  await act(async () => {
    await voice.begin();
    root.update(<Harness context="new-context" />);
  });
  const finishing = await start(() => voice.finish());
  expect(api.upload).toHaveBeenCalledTimes(1);
  expect(api.upload.mock.calls[0]?.[2]).toBe("original-context");
  expect(native.files.has(native.recorder.uri)).toBe(false);
  await emit({ didJustFinish: true, playing: false });
  await act(async () => {
    await finishing.task;
  });
  expect(voice.phase).toBe("idle");
  expect(native.files.size).toBe(0);
});
it("each speech clip finishes before the next plays and releases its private file", async () => {
  const speaking = await start(() => voice.speak(reply(2)));
  expect(native.players).toHaveLength(1);
  expect(native.players[0]!.play).toHaveBeenCalledOnce();
  await emit({ didJustFinish: true, playing: false });
  expect(native.players).toHaveLength(2);
  expect(native.players[0]!.release).toHaveBeenCalledOnce();
  await emit({ didJustFinish: true, playing: false });
  await act(async () => {
    await speaking.task;
  });
  expect(native.files.size).toBe(0);
  expect(voice.phase).toBe("idle");
});
it("a changed read-back after download but before native readiness never plays", async () => {
  native.playerFactory.mockImplementationOnce(() => {
    const p = {
      isLoaded: false,
      play: vi.fn(),
      pause: vi.fn(),
      release: vi.fn(),
      addListener: vi.fn(),
      emit: (_: Record<string, unknown>) => {},
    };
    p.addListener.mockImplementation((_name, listener) => {
      p.emit = listener;
      return {
        remove: () => {
          p.emit = () => {};
        },
      };
    });
    native.players.push(p);
    return p;
  });
  const speaking = await start(() => voice.speak(reply()));
  api.validateAudio.mockRejectedValue(
    new ApiError(410, "This read-back is no longer current"),
  );
  await emit({ isLoaded: true, playing: false });
  await act(async () => {
    await speaking.task;
  });
  expect(native.players[0]!.play).not.toHaveBeenCalled();
  expect(native.files.size).toBe(0);
  expect(voice.phase).toBe("error");
});
it("stop while playback authorization is pending prevents a late callback from playing", async () => {
  const gate = deferred<void>();
  api.validateAudio.mockReturnValue(gate.promise);
  const speaking = await start(() => voice.speak(reply()));
  const stopping = await start(() => voice.stop());
  await act(async () => {
    gate.resolve();
    await speaking.task;
    await stopping.task;
  });
  expect(native.players[0]!.play).not.toHaveBeenCalled();
  expect(native.files.size).toBe(0);
});
it("loss of native playback focus stops the sequence and never plays its next part", async () => {
  const speaking = await start(() => voice.speak(reply(2)));
  await emit({ playing: false });
  await act(async () => {
    await speaking.task;
  });
  expect(native.players).toHaveLength(1);
  expect(native.players[0]!.release).toHaveBeenCalledOnce();
  expect(native.files.size).toBe(0);
  expect(voice.phase).toBe("error");
});
it("microphone denial and sub-300ms accidental presses never send a turn", async () => {
  native.checkPermission.mockResolvedValueOnce({ granted: false });
  native.permission.mockResolvedValueOnce({ granted: false });
  await act(async () => {
    await voice.begin();
  });
  expect(voice.message).toContain("Microphone access is off");
  expect(native.recorder.record).not.toHaveBeenCalled();
  native.duration = 299;
  await act(async () => {
    await voice.begin();
    await voice.finish();
  });
  expect(api.upload).not.toHaveBeenCalled();
  expect(native.files.size).toBe(0);
});
it("permission loss during recording discards the partial capture", async () => {
  await act(async () => {
    await voice.begin();
  });
  native.checkPermission.mockResolvedValue({
    granted: false,
    status: "denied",
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(native.recording).toBe(false);
  expect(native.files.size).toBe(0);
  expect(api.upload).not.toHaveBeenCalled();
});
it("the native ceiling and JS deadline bound a single deliberate recording", async () => {
  await act(async () => {
    await voice.begin();
    await voice.begin();
  });
  expect(native.recorder.record).toHaveBeenCalledExactlyOnceWith({
    forDuration: 19.5,
  });
  native.duration = 19000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(19000);
  });
  expect(native.recording).toBe(false);
  expect(api.upload).toHaveBeenCalledOnce();
  await emit({ didJustFinish: true, playing: false });
  expect(native.files.size).toBe(0);
});
it("failed protected-state persistence deletes capture without an upload", async () => {
  native.save.mockRejectedValueOnce(new Error("Protected storage unavailable"));
  await act(async () => {
    await voice.begin();
    await voice.finish();
  });
  expect(api.upload).not.toHaveBeenCalled();
  expect(native.files.size).toBe(0);
  expect(voice.message).toContain("Protected storage unavailable");
});
it("an installation change while recording stops its microphone", async () => {
  await act(async () => {
    await voice.begin();
  });
  await act(async () => {
    root.update(<Harness client={makeApi()} />);
    await drain();
  });
  expect(native.recording).toBe(false);
  expect(native.files.size).toBe(0);
  expect(api.upload).not.toHaveBeenCalled();
});
it("expiry while downloading prevents local playback", async () => {
  const gate = deferred<Uint8Array<ArrayBuffer>>();
  api.audio.mockReturnValue(gate.promise);
  const speaking = await start(() =>
    voice.speak({
      ...reply(),
      expires_at: new Date(Date.now() + 500).toISOString(),
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
    gate.resolve(wav());
    await speaking.task;
  });
  expect(native.playerFactory).not.toHaveBeenCalled();
  expect(native.files.size).toBe(0);
});
it("revocation during playback stops sound and prevents another clip", async () => {
  api.audio.mockResolvedValue(wav(3));
  const speaking = await start(() => voice.speak(reply(2)));
  api.validateAudio.mockRejectedValue(new ApiError(403, "Device revoked"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
    await speaking.task;
  });
  expect(native.players).toHaveLength(1);
  expect(native.players[0]!.pause).toHaveBeenCalledOnce();
  expect(native.files.size).toBe(0);
});
it.each(["loading", "playing"])(
  "the local reply deadline stops %s even while its freshness request is stalled",
  async (stage) => {
    api.audio.mockResolvedValue(wav(18));
    let stalledSignal: AbortSignal | undefined;
    const stalled = vi.fn(
      (_path: string, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          stalledSignal = signal;
          signal.addEventListener(
            "abort",
            () => reject(new Error("Request aborted")),
            { once: true },
          );
        }),
    );
    if (stage === "loading")
      api.validateAudio.mockImplementation(stalled as any);
    const speaking = await start(() =>
      voice.speak({
        ...reply(2),
        expires_at: new Date(Date.now() + 2500).toISOString(),
      }),
    );
    if (stage === "playing") {
      expect(native.players[0]!.play).toHaveBeenCalledOnce();
      api.validateAudio.mockImplementation(stalled as any);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(stalled).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
      await drain();
    });
    expect(native.players[0]!.pause).toHaveBeenCalledOnce();
    expect(native.players[0]!.release).toHaveBeenCalledOnce();
    expect(stalledSignal?.aborted).toBe(true);
    expect(native.files.size).toBe(0);
    expect(voice.phase).toBe("error");
    expect(voice.message).toContain("spoken reply has expired");
    expect(api.audio).toHaveBeenCalledOnce();
    if (stage === "loading")
      expect(native.players[0]!.play).not.toHaveBeenCalled();
    await act(async () => {
      await speaking.task;
    });
  },
);
it("completed playback removes its expiry timer without later aborting the operation", async () => {
  const speaking = await start(() =>
    voice.speak({
      ...reply(),
      expires_at: new Date(Date.now() + 500).toISOString(),
    }),
  );
  const signal = (api.audio.mock.calls as any[][])[0]![1] as AbortSignal;
  await emit({ didJustFinish: true, playing: false });
  await act(async () => {
    await speaking.task;
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(signal.aborted).toBe(false);
  expect(native.files.size).toBe(0);
  expect(native.players[0]!.pause).toHaveBeenCalledOnce();
});
it("a timed-out player cannot start when its late authorization returns", async () => {
  const gate = deferred<void>();
  api.validateAudio.mockReturnValue(gate.promise);
  const speaking = await start(() => voice.speak(reply()));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8500);
    gate.resolve();
    await speaking.task;
    await drain();
  });
  expect(native.players[0]!.play).not.toHaveBeenCalled();
  expect(native.files.size).toBe(0);
});
it("malformed expiry and excessive clip counts never activate audio", async () => {
  await act(async () => {
    await voice.speak({ ...reply(), expires_at: "unknown" });
    await voice.speak(reply(21));
  });
  expect(native.active).not.toHaveBeenCalled();
  expect(native.playerFactory).not.toHaveBeenCalled();
});
it("sequence duration cannot exceed 120 seconds", async () => {
  api.audio.mockResolvedValue(wav(20));
  const speaking = await start(() => voice.speak(reply(7)));
  for (let i = 0; i < 6; i++)
    await emit({ didJustFinish: true, playing: false });
  await act(async () => {
    await speaking.task;
  });
  expect(native.players).toHaveLength(6);
  expect(native.files.size).toBe(0);
  expect(voice.message).toContain("two minutes");
});
it("handoff drains a delayed reminder start write before attesting local cleanup", async () => {
  const gate = deferred<void>();
  const event = {
    ...reply(),
    device_id: "phone",
    type: "reminder.play" as const,
    payload: {
      ...reply().payload,
      audio_paths: ["/v1/device/audio/audio_1"],
      command_id: "command",
      occurrence_id: "occurrence",
      route_generation: 1,
      context_id: "reminder-context",
    },
  };
  const authorize = vi.fn(() => gate.promise),
    after = vi.fn(async () => {});
  const speaking = await start(() =>
    voice.reminder(event, async () => {}, authorize).catch(() => "interrupted"),
  );
  expect(authorize).toHaveBeenCalledOnce();
  const stopping = await start(() => voice.stop(after));
  expect(native.players[0]!.pause).toHaveBeenCalledOnce();
  expect(after).not.toHaveBeenCalled();
  await act(async () => {
    gate.resolve();
    await speaking.task;
    await stopping.task;
  });
  expect(after).toHaveBeenCalledOnce();
  expect(native.players[0]!.play).not.toHaveBeenCalled();
});
it("failed cleanup exposes a retry state and prevents new speech until verified", async () => {
  native.active.mockRejectedValueOnce(new Error("Native audio unavailable"));
  await act(async () => {
    await expect(voice.stop()).rejects.toThrow("Native audio unavailable");
  });
  expect(voice.phase).toBe("cleanup_required");
  expect(voice.message).toContain("Retry stop");
  await act(async () => {
    await voice.begin();
  });
  expect(native.permission).not.toHaveBeenCalled();
  await act(async () => {
    await voice.stop();
  });
  expect(voice.phase).toBe("idle");
  await act(async () => {
    await voice.begin();
  });
  expect(voice.phase).toBe("recording");
});

it.each([500, 502, 503])(
  "an HTTP %s upload failure keeps receipt identity and original context for read-only recovery",
  async (status) => {
    api.upload.mockRejectedValueOnce(
      new ApiError(status, "Gateway response unavailable"),
    );
    await act(async () => {
      await voice.begin();
      await voice.finish();
    });
    const sentKey = api.upload.mock.calls[0]![1];
    expect(native.pending).toMatchObject({
      key: sentKey,
      context: "original-context",
    });
    expect(native.files.size).toBe(0);
    expect(voice.phase).toBe("error");
    expect(voice.message).not.toContain("Saved");
    const recovering = await start(() => voice.recover());
    expect(api.receipt).toHaveBeenCalledWith(sentKey, expect.any(AbortSignal));
    await emit({ didJustFinish: true, playing: false });
    await act(async () => {
      await recovering.task;
    });
    expect(native.pending).toBeNull();
    expect(api.upload).toHaveBeenCalledOnce();
    expect(voice.phase).toBe("idle");
  },
);

it("a genuinely unaccepted 503 remains unknown until explicit discard, without replaying audio", async () => {
  api.upload.mockRejectedValueOnce(new ApiError(503, "Service unavailable"));
  api.receipt.mockRejectedValue(new ApiError(404, "Receipt not found"));
  await act(async () => {
    await voice.begin();
    await voice.finish();
    await voice.recover();
  });
  expect(native.pending).not.toBeNull();
  expect(voice.message).toContain("receipt is still unknown");
  expect(native.files.size).toBe(0);
  expect(api.upload).toHaveBeenCalledOnce();
  expect(native.playerFactory).not.toHaveBeenCalled();
  await act(async () => {
    await voice.discard();
  });
  expect(native.pending).toBeNull();
  expect(voice.message).toContain("does not undo a recording already received");
});
