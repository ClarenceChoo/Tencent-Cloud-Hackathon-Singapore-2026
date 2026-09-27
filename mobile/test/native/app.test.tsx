/** Full production app, voice/reminder hooks and storage; controlled OS/API ports.
 * These are component-integration fixtures, not native device or live speech evidence.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Pressable, Switch, Text } from "react-native";
import type { Home, Installation, TurnEvent } from "../../src/contracts";
import { ApiError } from "../../src/errors";

const ports = vi.hoisted(() => ({
  api: null as any,
  secure: new Map<string, string>(),
  files: new Map<string, unknown>(),
  listeners: new Map<string, Set<(value: any) => void>>(),
  appState: { currentState: "active", addEventListener: vi.fn() },
  permission: vi.fn(),
  checkPermission: vi.fn(),
  mode: vi.fn(),
  active: vi.fn(),
  recorder: {
    uri: "file:///cache/recording-app.m4a",
    prepareToRecordAsync: vi.fn(),
    record: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn(),
  },
  recording: false,
  playerFactory: vi.fn(),
  players: [] as any[],
  cancelAlerts: vi.fn(),
  dismissAlerts: vi.fn(),
  scheduled: [] as any[],
  alert: vi.fn(),
  openURL: vi.fn(),
  openSettings: vi.fn(),
  screenReader: false,
  screenReaderCheck: vi.fn(),
  announce: vi.fn(),
  uuid: 0,
}));
const listen = (name: string, callback: (value: any) => void) => {
  const listeners = ports.listeners.get(name) || new Set();
  listeners.add(callback);
  ports.listeners.set(name, listeners);
  return { remove: () => listeners.delete(callback) };
};
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  StatusBar: "StatusBar",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: "ios" },
  AppState: ports.appState,
  Alert: { alert: ports.alert },
  Linking: { openURL: ports.openURL, openSettings: ports.openSettings },
  AccessibilityInfo: {
    isScreenReaderEnabled: ports.screenReaderCheck,
    addEventListener: (name: string, cb: any) => listen(name, cb),
    announceForAccessibility: ports.announce,
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: "SafeAreaView",
  SafeAreaProvider: "SafeAreaProvider",
}));
vi.mock("expo-audio", () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: ports.permission,
    getRecordingPermissionsAsync: ports.checkPermission,
  },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: ports.mode,
  setIsAudioActiveAsync: ports.active,
  useAudioRecorder: () => ports.recorder,
  createAudioPlayer: ports.playerFactory,
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async (key: string) => ports.secure.get(key) || null,
  setItemAsync: async (key: string, value: string) => {
    ports.secure.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    ports.secure.delete(key);
  },
}));
vi.mock("expo-crypto", () => ({
  randomUUID: () =>
    `00000000-0000-4000-8000-${String(++ports.uuid).padStart(12, "0")}`,
  getRandomBytesAsync: async () => new Uint8Array(32).fill(2),
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: async () => "01",
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: async () => {},
}));
vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(first: string | { uri: string }, name?: string) {
      this.uri = (typeof first === "string" ? first : first.uri) + (name || "");
    }
    get exists() {
      return ports.files.has(this.uri);
    }
    get name() {
      return this.uri.split("/").at(-1);
    }
    write(value: unknown) {
      ports.files.set(this.uri, value);
    }
    delete() {
      ports.files.delete(this.uri);
    }
  }
  return {
    File,
    Paths: {
      cache: { uri: "file:///cache/" },
      document: { uri: "file:///document/" },
    },
    Directory: class {
      uri: string;
      constructor(first: string | { uri: string }, name = "") {
        this.uri = (typeof first === "string" ? first : first.uri) + name;
        if (!this.uri.endsWith("/")) this.uri += "/";
      }
      get exists() {
        return (
          this.uri === "file:///cache/" ||
          [...ports.files.keys()].some((uri) => uri.startsWith(this.uri))
        );
      }
      list() {
        return [...ports.files.keys()]
          .filter(
            (uri) =>
              uri.startsWith(this.uri) &&
              !uri.slice(this.uri.length).includes("/"),
          )
          .map((uri) => new File(uri));
      }
    },
  };
});
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  AndroidImportance: { DEFAULT: 3, NONE: 0 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DATE: "date" },
  setNotificationChannelAsync: async () => {},
  getNotificationChannelAsync: async () => ({ importance: 3 }),
  getPermissionsAsync: async () => ({ status: "granted" }),
  requestPermissionsAsync: async () => ({ status: "granted" }),
  getExpoPushTokenAsync: async () => ({ data: "ExponentPushToken[fixture]" }),
  getAllScheduledNotificationsAsync: async () => ports.scheduled,
  scheduleNotificationAsync: async (notice: any) => {
    ports.scheduled.push(notice);
    return notice.identifier;
  },
  cancelScheduledNotificationAsync: async () => {},
  dismissNotificationAsync: async () => {},
  cancelAllScheduledNotificationsAsync: ports.cancelAlerts,
  dismissAllNotificationsAsync: ports.dismissAlerts,
  addNotificationReceivedListener: (cb: any) => listen("notification", cb),
  addNotificationResponseReceivedListener: (cb: any) => listen("tap", cb),
  addPushTokenListener: (cb: any) => listen("token", cb),
  getLastNotificationResponse: () => null,
  clearLastNotificationResponseAsync: async () => {},
}));
vi.mock("../../src/api", async () => ({
  ApiError: (await import("../../src/errors")).ApiError,
  PhoneApi: class {
    constructor() {
      return ports.api;
    }
  },
}));
import App from "../../src/App";

const installation: Installation = {
  version: 1,
  credential: "a".repeat(64),
  service: "https://parse.example",
  enrollmentKey: "00000000-0000-4000-8000-000000000001",
  platform: "ios",
  displayName: "Fictional phone",
};
let root: ReactTestRenderer | null, home: Home;
const drain = async () => {
  for (let i = 0; i < 120; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function wav() {
  const bytes = new Uint8Array(44 + 12800),
    v = new DataView(bytes.buffer);
  const text = (offset: number, text: string) =>
    [...text].forEach(
      (letter, index) => (bytes[offset + index] = letter.charCodeAt(0)),
    );
  text(0, "RIFF");
  v.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, 12800, true);
  return bytes;
}
const reply = (status = "completed"): TurnEvent => ({
  expires_at: new Date(Date.now() + 60000).toISOString(),
  payload: {
    status,
    spoken_text: "Fictional spoken reply",
    audio_paths: ["/v1/device/audio/audio_fixture"],
  },
});
const proposal = () => ({
  id: "proposal_one",
  context_id: "context_one",
  kind: "health_note",
  status: "pending",
  readback: "Left knee after walking. Share with Jamie?",
  payload: { wording: "Left knee after walking" },
  expires_at: new Date(Date.now() + 60000).toISOString(),
});
function button(label: string) {
  return root!.root.findAll(
    (node) =>
      node.type === Pressable && node.props.accessibilityLabel === label,
  )[0];
}
function text() {
  return root!.root
    .findAll((node) => node.type === Text)
    .map((node) =>
      node.children.filter((child) => typeof child === "string").join(""),
    )
    .join("\n");
}
async function mount() {
  await act(async () => {
    root = create(<App />);
    await drain();
  });
  await act(drain);
}
async function press(label: string, event = "onPress") {
  await act(async () => {
    const node = button(label);
    if (!node) throw new Error("Missing button: " + label);
    expect(node.props.disabled, label).not.toBe(true);
    void node.props[event]();
    await drain();
  });
}
async function tab(name: string) {
  await act(async () => {
    root!.root
      .findAll(
        (node) =>
          node.type === Pressable &&
          node.props.accessibilityRole === "tab" &&
          node.findByType(Text).children.includes(name),
      )[0]!
      .props.onPress();
    await drain();
  });
}
async function finishSpeech() {
  await act(async () => {
    ports.players.at(-1)?.emit({ didJustFinish: true, playing: false });
    await drain();
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await drain();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  root = null;
  ports.secure.clear();
  ports.files.clear();
  ports.listeners.clear();
  ports.players = [];
  ports.scheduled = [];
  ports.uuid = 0;
  ports.recording = false;
  ports.screenReader = false;
  ports.appState.currentState = "active";
  ports.appState.addEventListener.mockImplementation(listen);
  ports.secure.set("parse.installation", JSON.stringify(installation));
  ports.files.set("file:///document/parse-installation-v1", "v1");
  ports.permission.mockResolvedValue({ granted: true, status: "granted" });
  ports.checkPermission.mockResolvedValue({ granted: true, status: "granted" });
  ports.screenReaderCheck.mockImplementation(async () => ports.screenReader);
  ports.mode.mockResolvedValue(undefined);
  ports.active.mockResolvedValue(undefined);
  ports.recorder.prepareToRecordAsync.mockImplementation(async () => {
    ports.files.set(ports.recorder.uri, "AAC fixture");
  });
  ports.recorder.record.mockImplementation(() => {
    ports.recording = true;
  });
  ports.recorder.stop.mockImplementation(async () => {
    ports.recording = false;
  });
  ports.recorder.getStatus.mockImplementation(() => ({
    isRecording: ports.recording,
    canRecord: true,
    durationMillis: 1000,
  }));
  ports.cancelAlerts.mockImplementation(async () => {
    ports.scheduled = [];
  });
  ports.dismissAlerts.mockResolvedValue(undefined);
  ports.openURL.mockResolvedValue(undefined);
  ports.openSettings.mockResolvedValue(undefined);
  ports.playerFactory.mockImplementation(() => {
    let notify = (_value: any) => {};
    const player = {
      isLoaded: true,
      play: vi.fn(),
      pause: vi.fn(),
      release: vi.fn(),
      addListener: vi.fn((_name, cb) => {
        notify = cb;
        return {
          remove: () => {
            notify = () => {};
          },
        };
      }),
      emit: (value: any) =>
        notify({ isLoaded: true, isBuffering: false, ...value }),
    };
    player.play.mockImplementation(() => player.emit({ playing: true }));
    ports.players.push(player);
    return player;
  });
  home = {
    device_id: "phone_one",
    patient: {
      id: "patient_one",
      name: "Fictional Mei",
      preferred_name: "Mei",
      timezone: "Asia/Singapore",
      calling_route: null,
    },
    active_companion: { device_id: null, generation: 1 },
    voice: { voice_service: "configured", scheduler_enabled: false },
    current_proposal: null,
    medication_plan: null,
    doses: [],
    notes: [],
    measurements: [],
    preventive_tasks: [],
    support_requests: [],
    followups: [],
    permitted_recipients: [],
  };
  ports.api = {
    home: vi.fn(async () => structuredClone(home)),
    enrollment: vi.fn(async () => ({
      status: "paired",
      device_id: home.device_id,
      patient: { id: home.patient.id, name: home.patient.name },
    })),
    enroll: vi.fn(),
    presence: vi.fn(async () => ({})),
    schedule: vi.fn(async () => ({
      device_id: home.device_id,
      active_companion: home.active_companion,
      server_time: new Date().toISOString(),
      revision: "v1",
      valid_until: new Date(Date.now() + 86400000).toISOString(),
      covered_until: new Date(Date.now() + 86400000).toISOString(),
      alerts: [],
    })),
    pushRegistration: vi.fn(async () => ({
      device_id: home.device_id,
      registered: false,
      disabled: false,
      push_configured: false,
      version: 0,
      notification_permission: "granted",
      active_companion: home.active_companion,
    })),
    pending: vi.fn(async () => ({
      active_companion: home.active_companion,
      commands: [],
      checkins: [],
    })),
    quiesce: vi.fn(async () => ({ status: "paused" })),
    revoke: vi.fn(async () => ({})),
    confirm: vi.fn(async () => ({ status: "committed" })),
    cancel: vi.fn(async () => ({})),
    speech: vi.fn(async () => reply()),
    audio: vi.fn(async () => wav()),
    validateAudio: vi.fn(async () => {}),
    upload: vi.fn(async () => ({
      turn_id: "turn_" + "1".repeat(32),
      status: "accepted",
    })),
    turn: vi.fn(async () => ({ status: "completed", event: reply() })),
    receipt: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await drain();
  });
  vi.useRealTimers();
});

it("loads paired care without requesting microphone permission or creating care facts", async () => {
  home.notes = [
    {
      id: "note_one",
      wording: "Previously confirmed note",
      created_at: new Date().toISOString(),
    },
  ];
  await mount();
  expect(text()).toContain("Previously confirmed note");
  expect(ports.permission).not.toHaveBeenCalled();
  expect(ports.api.confirm).not.toHaveBeenCalled();
  expect(ports.recorder.record).not.toHaveBeenCalled();
});

it("runs tap capture through an unsaved proposal and explicit confirmation with both production hooks mounted", async () => {
  await mount();
  await act(async () => {
    root!.root.findByType(Switch).props.onValueChange(true);
    await drain();
  });
  ports.api.turn.mockImplementation(async () => {
    home.current_proposal = proposal();
    return {
      status: "completed",
      event: {
        ...reply("awaiting_confirmation"),
        payload: {
          ...reply().payload,
          status: "awaiting_confirmation",
          context_id: "context_one",
        },
      },
    };
  });
  await press("Tap to start recording");
  expect(ports.recorder.record).toHaveBeenCalledOnce();
  expect(text()).toContain(
    "Listening. Tap to send, or choose Cancel recording.",
  );
  await press("Recording. Tap to send.");
  expect(ports.api.upload).toHaveBeenCalledOnce();
  expect(ports.files.has(ports.recorder.uri)).toBe(false);
  expect(text()).toContain("Have I got that right?");
  expect(ports.api.confirm).not.toHaveBeenCalled();
  await finishSpeech();
  ports.api.confirm.mockImplementation(async () => {
    home.current_proposal = null;
    home.notes = [
      {
        id: "saved_note",
        wording: "Left knee after walking",
        created_at: new Date().toISOString(),
      },
    ];
    return { status: "committed" };
  });
  await press("Confirm and save");
  expect(ports.api.confirm).toHaveBeenCalledExactlyOnceWith(
    "proposal_one",
    "context_one",
  );
  expect(text()).toContain("Left knee after walking");
  expect(button("Confirm and save")).toBeUndefined();
  await finishSpeech();
});

it("waits for native stop verification before requesting another read-back", async () => {
  home.current_proposal = proposal();
  await mount();
  const stopped = deferred<void>();
  ports.active.mockImplementation((active: boolean) =>
    active ? Promise.resolve() : stopped.promise,
  );
  await press("Hear this read-back");
  expect(ports.api.speech).not.toHaveBeenCalled();
  await act(async () => {
    stopped.resolve();
    await drain();
  });
  expect(ports.api.speech).toHaveBeenCalledExactlyOnceWith(
    "proposal_one",
    "context_one",
  );
  await finishSpeech();
});

it("hides revoked care immediately even when notification cleanup fails", async () => {
  home.notes = [
    {
      id: "private_note",
      wording: "Private confirmed concern",
      created_at: new Date().toISOString(),
    },
  ];
  await mount();
  ports.cancelAlerts.mockRejectedValue(
    new Error("Native notification cleanup failed"),
  );
  ports.api.enrollment.mockRejectedValue(
    new ApiError(403, "This phone was revoked"),
  );
  await advance(5000);
  expect(text()).not.toContain("Private confirmed concern");
  expect(button("Hold to talk")).toBeUndefined();
  expect(text()).toMatch(/revoked|access/i);
  expect(button("Retry local cleanup")).toBeTruthy();
  ports.cancelAlerts.mockImplementation(async () => {
    ports.scheduled = [];
  });
  await press("Retry local cleanup");
  expect(text()).toContain("Local audio and alerts are cleared");
  expect(ports.api.quiesce).toHaveBeenCalledOnce();
  const reads = ports.api.home.mock.calls.length;
  await advance(10000);
  expect(ports.api.home).toHaveBeenCalledTimes(reads);
  expect(button("Hold to talk")).toBeUndefined();
});

it("waits for a pending microphone dialog before attesting reminder cleanup", async () => {
  await mount();
  const permission = deferred<{ granted: boolean }>();
  ports.checkPermission.mockResolvedValueOnce({ granted: false });
  ports.permission.mockReturnValue(permission.promise);
  await press("Hold to talk", "onPressIn");
  await tab("Settings");
  await press("Pause reminders");
  expect(ports.api.quiesce).not.toHaveBeenCalled();
  await act(async () => {
    permission.resolve({ granted: true });
    await drain();
  });
  expect(ports.recorder.record).not.toHaveBeenCalled();
  expect(ports.api.quiesce).toHaveBeenCalledOnce();
  expect(ports.api.upload).not.toHaveBeenCalled();
});

it("does not leave for permission settings until recording has stopped", async () => {
  await mount();
  await press("Hold to talk", "onPressIn");
  expect(ports.recording).toBe(true);
  await tab("Settings");
  const stopped = deferred<void>();
  ports.active.mockImplementation((active: boolean) =>
    active ? Promise.resolve() : stopped.promise,
  );
  await press("Open phone permission settings");
  expect(ports.openSettings).not.toHaveBeenCalled();
  await act(async () => {
    stopped.resolve();
    await drain();
  });
  expect(ports.openSettings).toHaveBeenCalledOnce();
  expect(ports.recording).toBe(false);
  expect(ports.api.upload).not.toHaveBeenCalled();
  expect(ports.files.has(ports.recorder.uri)).toBe(false);
});

it("keeps access closed when an old home response arrives after revocation", async () => {
  home.notes = [
    {
      id: "old",
      wording: "Old private note",
      created_at: new Date().toISOString(),
    },
  ];
  await mount();
  const gate = deferred<Home>();
  ports.api.home.mockReturnValue(gate.promise);
  await act(async () => {
    ports.listeners
      .get("tap")
      ?.forEach((callback) =>
        callback({ notification: { request: { content: { data: {} } } } }),
      );
    await drain();
  });
  ports.api.enrollment.mockRejectedValue(new ApiError(403, "Revoked"));
  await advance(5000);
  await act(async () => {
    gate.resolve(structuredClone(home));
    await drain();
  });
  expect(text()).not.toContain("Old private note");
  expect(text()).toContain("Phone access stopped");
});

it("keeps the newer care result when concurrent refreshes finish out of order", async () => {
  await mount();
  const old = deferred<Home>();
  ports.api.home.mockReturnValueOnce(old.promise);
  await act(async () => {
    ports.listeners
      .get("tap")
      ?.forEach((callback) =>
        callback({ notification: { request: { content: { data: {} } } } }),
      );
    await drain();
  });
  const stale = structuredClone(home);
  home.notes = [
    {
      id: "new",
      wording: "New confirmed information",
      created_at: new Date().toISOString(),
    },
  ];
  await advance(5000);
  expect(text()).toContain("New confirmed information");
  await act(async () => {
    old.resolve(stale);
    await drain();
  });
  expect(text()).toContain("New confirmed information");
});

it("does not play a delayed read-back after access is revoked", async () => {
  home.current_proposal = proposal();
  await mount();
  const speech = deferred<TurnEvent>();
  ports.api.speech.mockReturnValue(speech.promise);
  await press("Hear this read-back");
  ports.api.enrollment.mockRejectedValue(new ApiError(403, "Revoked"));
  await advance(5000);
  await act(async () => {
    speech.resolve(reply());
    await drain();
  });
  expect(ports.playerFactory).not.toHaveBeenCalled();
  expect(text()).toContain("Phone access stopped");
});

it("uses a deliberate tap for screen-reader activation and retains a user’s chosen tap mode", async () => {
  ports.screenReader = true;
  await mount();
  expect(button("Tap to start recording")).toBeTruthy();
  expect(root!.root.findByType(Switch).props.disabled).toBe(true);
  // Accessibility activation may include a brief press-in/out before onPress.
  await press("Tap to start recording", "onPressIn");
  await press("Tap to start recording", "onPressOut");
  expect(ports.recorder.record).not.toHaveBeenCalled();
  await press("Tap to start recording");
  expect(ports.recorder.record).toHaveBeenCalledOnce();
  await press("Cancel recording");
  expect(ports.api.upload).not.toHaveBeenCalled();
  await act(async () => {
    ports.screenReader = false;
    ports.listeners.get("screenReaderChanged")?.forEach((cb) => cb(false));
    await drain();
  });
  await act(async () => {
    root!.root.findByType(Switch).props.onValueChange(true);
    await drain();
  });
  expect(ports.secure.get("parse.interaction-mode")).toBe("tap");
  await act(async () => {
    root!.unmount();
    root = null;
    await drain();
  });
  await mount();
  expect(button("Tap to start recording")).toBeTruthy();
});

it("cancels a held recording if screen-reader activation changes its gesture", async () => {
  await mount();
  await press("Hold to talk", "onPressIn");
  expect(ports.recording).toBe(true);
  await act(async () => {
    ports.listeners.get("screenReaderChanged")?.forEach((cb) => cb(true));
    await drain();
  });
  expect(ports.recording).toBe(false);
  expect(ports.api.upload).not.toHaveBeenCalled();
  expect(button("Tap to start recording")).toBeTruthy();
});

it("keeps a newer screen-reader event when the initial accessibility query resolves late", async () => {
  const check = deferred<boolean>();
  ports.screenReaderCheck.mockReturnValue(check.promise);
  await mount();
  expect(button("Hold to talk")?.props.disabled).toBe(true);
  await act(async () => {
    ports.listeners.get("screenReaderChanged")?.forEach((cb) => cb(true));
    check.resolve(false);
    await drain();
  });
  expect(button("Tap to start recording")?.props.disabled).toBe(false);
  expect(root!.root.findByType(Switch).props.disabled).toBe(true);
});

it("treats restored Keychain identity only as cleanup authority before pairing again", async () => {
  ports.files.delete("file:///document/parse-installation-v1");
  await mount();
  expect(text()).toContain("Pairing from an earlier installation");
  expect(ports.api.home).not.toHaveBeenCalled();
  expect(ports.api.enrollment).not.toHaveBeenCalled();
  await press("Start a new pairing");
  expect(ports.api.quiesce).toHaveBeenCalledOnce();
  expect(ports.api.revoke).toHaveBeenCalledOnce();
  expect(ports.secure.has("parse.installation")).toBe(false);
  expect(button("Get pairing code")).toBeTruthy();
});
