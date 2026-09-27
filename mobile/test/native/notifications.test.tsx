/** Production reminder hook, real queue/ledger code, controlled OS/network adapters. */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors";
import type { PhoneApi } from "../../src/api";
import type {
  Home,
  PushRegistration,
  ReminderSchedule,
} from "../../src/contracts";
const native = vi.hoisted(() => ({
  appState: { currentState: "active", addEventListener: vi.fn() },
  os: { OS: "ios" },
  listeners: new Map<string, (value: any) => void>(),
  permission: "granted",
  channel: 3,
  request: vi.fn(),
  getPermission: vi.fn(),
  getToken: vi.fn(),
  schedule: vi.fn(),
  all: vi.fn(),
  cancel: vi.fn(),
  cancelAll: vi.fn(),
  dismissAll: vi.fn(),
  scheduled: new Map<string, any>(),
  last: null as any,
  refresh: vi.fn(),
  speak: vi.fn(),
  uuid: 0,
}));
vi.mock("react-native", () => ({
  AppState: native.appState,
  Platform: native.os,
}));
vi.mock("expo-audio", () => ({
  AudioModule: {
    getRecordingPermissionsAsync: async () => ({ status: "granted" }),
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => `event-${++native.uuid}` }));
vi.mock("../../src/api", async () => ({
  ApiError: (await import("../../src/errors")).ApiError,
}));
vi.mock("../../src/storage", () => ({ loadPending: async () => null }));
vi.mock("../../src/reminderStorage", () => ({
  readPlayback: async () => null,
  writePlayback: async () => {},
  listPlayback: async () => [],
}));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  AndroidImportance: { DEFAULT: 3, NONE: 0 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DATE: "date" },
  setNotificationChannelAsync: async () => {},
  getNotificationChannelAsync: async () => ({ importance: native.channel }),
  getPermissionsAsync: native.getPermission,
  requestPermissionsAsync: native.request,
  getExpoPushTokenAsync: native.getToken,
  getAllScheduledNotificationsAsync: native.all,
  scheduleNotificationAsync: native.schedule,
  cancelScheduledNotificationAsync: native.cancel,
  cancelAllScheduledNotificationsAsync: native.cancelAll,
  dismissNotificationAsync: async () => {},
  dismissAllNotificationsAsync: native.dismissAll,
  addNotificationReceivedListener: (fn: any) => {
    native.listeners.set("received", fn);
    return { remove: () => native.listeners.delete("received") };
  },
  addNotificationResponseReceivedListener: (fn: any) => {
    native.listeners.set("tapped", fn);
    return { remove: () => native.listeners.delete("tapped") };
  },
  addPushTokenListener: (fn: any) => {
    native.listeners.set("token", fn);
    return { remove: () => native.listeners.delete("token") };
  },
  getLastNotificationResponse: () => native.last,
  clearLastNotificationResponseAsync: async () => {
    native.last = null;
  },
}));
import { useReminders } from "../../src/useReminders";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const drain = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
function makeApi(device = "phone") {
  const state: PushRegistration = {
    device_id: device,
    registered: false,
    push_configured: true,
    version: 0,
    disabled: false,
    notification_permission: "unknown",
    active_companion: { device_id: device, generation: 2 },
  };
  const schedule: ReminderSchedule = {
    device_id: device,
    server_time: new Date(Date.now()).toISOString(),
    valid_until: new Date(Date.now() + 86400000).toISOString(),
    covered_until: new Date(Date.now() + 86400000).toISOString(),
    revision: "plan-one",
    truncated: false,
    active_companion: state.active_companion,
    title: "must not copy",
    body: "private clinical text",
    alerts: [
      {
        identity: `parse.${device}.occ_one.g2`,
        occurrence_id: "occ_one",
        route_generation: 2,
        due_at: new Date(Date.now() + 600000).toISOString(),
        expires_at: new Date(Date.now() + 720000).toISOString(),
      },
    ],
  };
  return {
    state,
    scheduleData: schedule,
    presence: vi.fn(async (body: any) => {
      state.notification_permission = body.notification_permission;
      if (["denied", "undetermined"].includes(body.notification_permission)) {
        state.registered = false;
        state.disabled = true;
        state.version++;
      }
      return {};
    }),
    schedule: vi.fn(async () => structuredClone(schedule)),
    pushRegistration: vi.fn(async () => structuredClone(state)),
    registerPush: vi.fn(
      async (_token: string | null, prior: PushRegistration) => {
        if (
          prior.version !== state.version ||
          prior.active_companion.generation !==
            state.active_companion.generation
        )
          throw new ApiError(409, "changed");
        state.registered = !!_token;
        state.disabled = false;
        state.version++;
        return structuredClone(state);
      },
    ),
    pending: vi.fn(async () => ({
      active_companion: state.active_companion,
      commands: [],
      checkins: [],
    })),
    notificationEvent: vi.fn(async () => ({})),
    currentReminder: vi.fn(),
    ack: vi.fn(),
  };
}
let api: ReturnType<typeof makeApi>,
  root: ReactTestRenderer,
  hook: ReturnType<typeof useReminders>;
function Harness({ client = api }: { client?: typeof api }) {
  hook = useReminders({
    api: client as unknown as PhoneApi,
    home: { device_id: client.state.device_id, current_proposal: null } as Home,
    voice: { phase: "idle", reminder: native.speak },
    ready: true,
    refresh: native.refresh,
    onReminder: vi.fn(),
  });
  return null;
}
async function render(client = api) {
  await act(async () => {
    root = create(<Harness client={client} />);
    await drain();
  });
}
async function start(work: () => Promise<unknown>) {
  let task!: Promise<unknown>;
  await act(async () => {
    task = work();
    await drain();
  });
  return { task };
}
async function event(name: string, value: any) {
  await act(async () => {
    native.listeners.get(name)?.(value);
    await drain();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubEnv(
    "EXPO_PUBLIC_EAS_PROJECT_ID",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  native.appState.currentState = "active";
  native.os.OS = "ios";
  native.permission = "granted";
  native.channel = 3;
  native.scheduled.clear();
  native.listeners.clear();
  native.last = null;
  native.getPermission.mockImplementation(async () => ({
    status: native.permission,
  }));
  native.request.mockImplementation(async () => ({
    status: native.permission,
  }));
  native.getToken.mockResolvedValue({
    data: "ExpoPushToken[fixture_token_one]",
  });
  native.refresh.mockResolvedValue({ current_proposal: null });
  native.speak.mockResolvedValue("busy");
  native.all.mockImplementation(async () => [...native.scheduled.values()]);
  native.schedule.mockImplementation(async (entry) => {
    native.scheduled.set(entry.identifier, entry);
    return entry.identifier;
  });
  native.cancel.mockImplementation(async (id) => {
    native.scheduled.delete(id);
  });
  native.cancelAll.mockImplementation(async () => {
    native.scheduled.clear();
  });
  native.dismissAll.mockResolvedValue(undefined);
  native.appState.addEventListener.mockImplementation((name, fn) => {
    native.listeners.set(name, fn);
    return { remove: () => native.listeners.delete(name) };
  });
  api = makeApi();
});
afterEach(async () => {
  if (root)
    await act(async () => {
      root.unmount();
      await drain();
    });
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
it("registers against current server state and schedules generic content only", async () => {
  await render();
  expect(api.registerPush).toHaveBeenCalledOnce();
  expect(hook.pushStatus).toContain("registration accepted");
  expect([...native.scheduled.values()][0].content).toEqual({
    title: "Parse",
    body: "Open Parse to check your care schedule.",
    sound: "default",
    data: { parse: true, identity: "parse.phone.occ_one.g2" },
  });
  expect(JSON.stringify([...native.scheduled.values()])).not.toContain(
    "private clinical",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(api.registerPush).toHaveBeenCalledOnce();
});
it("permission denial clears local alerts and invalidates the server registration", async () => {
  await render();
  native.permission = "denied";
  await act(async () => {
    await hook.enable();
    await drain();
  });
  expect(native.scheduled.size).toBe(0);
  expect(api.state.registered).toBe(false);
  expect(api.state.notification_permission).toBe("denied");
  expect(hook.pushStatus).toContain("permission");
  expect(hook.status).toContain("Notifications are off");
});
it("denied permission clears local alerts even when the backend is offline", async () => {
  await render();
  native.permission = "denied";
  api.presence.mockRejectedValue(new Error("Offline"));
  await act(async () => {
    await hook.enable();
    await drain();
  });
  expect(native.scheduled.size).toBe(0);
  expect(hook.status).toContain("Offline");
  expect(hook.pushStatus).toContain("has not confirmed");
});
it("a native token refresh uses the supplied native token without asking for it recursively", async () => {
  await render();
  native.getToken.mockResolvedValue({
    data: "ExpoPushToken[fixture_token_two]",
  });
  await event("token", { type: "ios", data: "new-native-token" });
  expect(native.getToken).toHaveBeenLastCalledWith({
    projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    devicePushToken: { type: "ios", data: "new-native-token" },
  });
  expect(api.registerPush).toHaveBeenLastCalledWith(
    "ExpoPushToken[fixture_token_two]",
    expect.objectContaining({ version: 1 }),
  );
});
it("an old enable dialog cannot re-register after a pause", async () => {
  await render();
  const gate = deferred<any>();
  native.request.mockReturnValue(gate.promise);
  const enabling = await start(() => hook.enable());
  await act(async () => {
    await hook.pause();
  });
  const calls = api.registerPush.mock.calls.length;
  await act(async () => {
    gate.resolve({ status: "granted" });
    await enabling.task;
    await drain();
  });
  expect(api.registerPush).toHaveBeenCalledTimes(calls);
  expect(native.scheduled.size).toBe(0);
});
it("pause drains a pending token request without writing its late result", async () => {
  const gate = deferred<any>();
  native.getToken.mockReturnValue(gate.promise);
  await render();
  let done = false;
  const pausing = await start(() =>
    hook.pause().then(() => {
      done = true;
    }),
  );
  expect(done).toBe(false);
  await act(async () => {
    gate.resolve({ data: "ExpoPushToken[late_token_value]" });
    await pausing.task;
  });
  expect(api.registerPush).not.toHaveBeenCalled();
  expect(native.scheduled.size).toBe(0);
});
it("a changed installation waits for old cleanup and never uses the new account for an old token", async () => {
  const gate = deferred<any>();
  native.getToken.mockReturnValueOnce(gate.promise);
  await render();
  const newer = makeApi("new-phone");
  await act(async () => {
    root.update(<Harness client={newer} />);
    await drain();
  });
  expect(newer.registerPush).not.toHaveBeenCalled();
  await act(async () => {
    gate.resolve({ data: "ExpoPushToken[old_pending_token]" });
    await drain();
  });
  expect(api.registerPush).not.toHaveBeenCalled();
  expect(newer.registerPush).toHaveBeenCalledOnce();
  expect([...native.scheduled.keys()]).toEqual(["parse.new-phone.occ_one.g2"]);
});
it("pause waits for an admitted server write before handoff", async () => {
  const gate = deferred<PushRegistration>();
  api.registerPush.mockImplementation(() => gate.promise);
  await render();
  let finished = false;
  const pause = await start(() =>
    hook.pause().then(() => {
      finished = true;
    }),
  );
  expect(finished).toBe(false);
  await act(async () => {
    gate.resolve({ ...api.state, version: 1, registered: true });
    await pause.task;
  });
  expect(finished).toBe(true);
  expect(native.scheduled.size).toBe(0);
});
it("a native schedule that resolves after pause is removed before cleanup succeeds", async () => {
  const gate = deferred<void>();
  native.schedule.mockImplementation(async (entry) => {
    await gate.promise;
    native.scheduled.set(entry.identifier, entry);
    return entry.identifier;
  });
  await render();
  let done = false;
  const pause = await start(() =>
    hook.pause().then(() => {
      done = true;
    }),
  );
  expect(done).toBe(false);
  await act(async () => {
    gate.resolve();
    await pause.task;
  });
  expect(native.scheduled.size).toBe(0);
});
it("backgrounding preserves generic scheduled alerts and does not speak", async () => {
  await render();
  native.appState.currentState = "background";
  await event("change", "background");
  expect(native.scheduled.size).toBe(1);
  expect(native.speak).not.toHaveBeenCalled();
  expect(api.presence).toHaveBeenLastCalledWith(
    expect.objectContaining({ lifecycle: "background" }),
  );
});
it("a notification tap refreshes care before reading current pending commands", async () => {
  await render();
  const gate = deferred<any>();
  native.refresh.mockReturnValue(gate.promise);
  const calls = api.pending.mock.calls.length;
  await event("tapped", {
    notification: {
      request: { content: { data: { identity: "parse.phone.occ_one.g2" } } },
    },
  });
  expect(api.pending).toHaveBeenCalledTimes(calls);
  expect(api.ack).not.toHaveBeenCalled();
  await act(async () => {
    gate.resolve({ current_proposal: null });
    await drain();
  });
  expect(api.pending.mock.calls.length).toBeGreaterThan(calls);
  expect(native.speak).not.toHaveBeenCalled();
});
it("Android channel denial overrides the general OS permission", async () => {
  native.os.OS = "android";
  native.channel = 0;
  await render();
  expect(api.state.notification_permission).toBe("denied");
  expect(api.registerPush).not.toHaveBeenCalled();
  expect(native.scheduled.size).toBe(0);
});
it("server-disabled tokens do not get repeatedly registered by routine polling", async () => {
  await render();
  api.state.registered = false;
  api.state.disabled = true;
  api.state.version++;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(api.registerPush).toHaveBeenCalledOnce();
  expect(hook.pushStatus).toContain("was disabled");
  await act(async () => {
    await hook.enable();
    await drain();
  });
  expect(api.registerPush).toHaveBeenCalledTimes(2);
});
it("out-of-order token acquisitions cannot overwrite the newest token", async () => {
  await render();
  const first = deferred<any>();
  native.getToken
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({ data: "ExpoPushToken[newest_token_value]" });
  await event("token", { type: "ios", data: "older-native" });
  await event("token", { type: "ios", data: "newest-native" });
  await act(async () => {
    first.resolve({ data: "ExpoPushToken[obsolete_token_value]" });
    await drain();
  });
  expect(api.registerPush).toHaveBeenCalledTimes(2);
  expect(api.registerPush).toHaveBeenLastCalledWith(
    "ExpoPushToken[newest_token_value]",
    expect.anything(),
  );
  expect(
    api.registerPush.mock.calls.some(
      ([token]) => token === "ExpoPushToken[obsolete_token_value]",
    ),
  ).toBe(false);
});
it("a route change during token acquisition is rejected using the original server version", async () => {
  const token = deferred<any>();
  native.getToken.mockReturnValue(token.promise);
  await render();
  api.state.active_companion = { device_id: null, generation: 3 };
  await act(async () => {
    token.resolve({ data: "ExpoPushToken[late_route_token]" });
    await drain();
  });
  expect(api.state.registered).toBe(false);
  expect(api.registerPush).toHaveBeenLastCalledWith(
    "ExpoPushToken[late_route_token]",
    expect.objectContaining({
      active_companion: { device_id: "phone", generation: 2 },
    }),
  );
  expect(hook.pushStatus).toContain("changed");
});
it("a hung Expo request times out and its eventual response cannot register", async () => {
  const token = deferred<any>();
  native.getToken.mockReturnValue(token.promise);
  await render();
  expect(native.scheduled.size).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10001);
  });
  await act(async () => {
    token.resolve({ data: "ExpoPushToken[too_late_token_value]" });
    await drain();
  });
  expect(api.registerPush).not.toHaveBeenCalled();
});
it("build and server configuration are distinguished from local scheduled alerts", async () => {
  vi.stubEnv("EXPO_PUBLIC_EAS_PROJECT_ID", "");
  await render();
  expect(native.getToken).not.toHaveBeenCalled();
  expect(native.scheduled.size).toBe(1);
  expect(hook.pushStatus).toContain("not configured for this build");
});
it("cleanup failure still waits for pending registration before reporting failure", async () => {
  const token = deferred<any>();
  native.getToken.mockReturnValue(token.promise);
  await render();
  native.cancelAll.mockRejectedValueOnce(new Error("Native cancel failed"));
  let finished = false;
  const work = await start(() =>
    hook.pause().catch((error) => {
      finished = true;
      return error.message;
    }),
  );
  expect(finished).toBe(false);
  await act(async () => {
    token.resolve({ data: "ExpoPushToken[ignored_late_token]" });
    expect(await work.task).toBe("Native cancel failed");
  });
  expect(api.registerPush).not.toHaveBeenCalled();
});
it("pause on a replacement installation also waits for the preceding cleanup", async () => {
  const token = deferred<any>();
  native.getToken.mockReturnValueOnce(token.promise);
  await render();
  const newer = makeApi("replacement");
  await act(async () => {
    root.update(<Harness client={newer} />);
    await drain();
  });
  let done = false;
  const work = await start(() =>
    hook.pause().then(() => {
      done = true;
    }),
  );
  expect(done).toBe(false);
  await act(async () => {
    token.resolve({ data: "ExpoPushToken[old_installation_token]" });
    await work.task;
  });
  expect(api.registerPush).not.toHaveBeenCalled();
  expect(newer.registerPush).not.toHaveBeenCalled();
  expect(native.scheduled.size).toBe(0);
});

it("rebuilds unchanged native alarms after backward and forward device clock changes", async () => {
  const server = Date.now();
  await render();
  const first = [...native.scheduled.values()][0];
  const original = first.trigger.date.getTime();
  for (const [index, offset] of [-300000, 300000].entries()) {
    vi.setSystemTime(server + index * 5000 + offset);
    api.scheduleData.server_time = new Date(
      server + (index + 1) * 5000,
    ).toISOString();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const [current] = [...native.scheduled.values()];
    expect(current.identifier).toBe(first.identifier);
    expect(current.trigger.date.getTime()).toBe(original + offset);
    expect(current.content).toEqual(first.content);
    expect(native.cancel).toHaveBeenCalledWith(first.identifier);
    expect(native.scheduled.size).toBe(1);
    expect(native.speak).not.toHaveBeenCalled();
  }
});

it("rebuilds on device time-zone change without changing the server due instant", async () => {
  vi.stubEnv("TZ", "Asia/Singapore");
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
    "Asia/Singapore",
  );
  const server = Date.now();
  await render();
  const first = [...native.scheduled.values()][0];
  vi.stubEnv("TZ", "Pacific/Honolulu");
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
    "Pacific/Honolulu",
  );
  api.scheduleData.server_time = new Date(server + 5000).toISOString();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(native.schedule).toHaveBeenCalledTimes(2);
  expect([...native.scheduled.values()][0]).toEqual(first);
  expect(native.cancel).toHaveBeenCalledWith(first.identifier);
});

it("refreshes native triggers on foreground resume even when revision and time are unchanged", async () => {
  await render();
  const first = [...native.scheduled.values()][0];
  await event("change", "background");
  expect(native.schedule).toHaveBeenCalledOnce();
  await event("change", "active");
  expect(native.schedule).toHaveBeenCalledTimes(2);
  expect([...native.scheduled.values()][0]).toEqual(first);
  expect(native.refresh).toHaveBeenCalledOnce();
});

it("does not churn native alarms for small response-time variations", async () => {
  const server = Date.now();
  await render();
  const first = [...native.scheduled.values()][0];
  for (let step = 1; step <= 4; step++) {
    api.scheduleData.server_time = new Date(
      server + step * 5000 - step * 100,
    ).toISOString();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
  }
  expect(native.schedule).toHaveBeenCalledOnce();
  expect(native.cancel).not.toHaveBeenCalled();
  expect([...native.scheduled.values()][0]).toEqual(first);
});

it("keeps a foreground refresh requested while a native rebuild is still pending", async () => {
  await render();
  const gate = deferred<void>();
  native.all.mockImplementationOnce(async () => {
    await gate.promise;
    return [...native.scheduled.values()];
  });
  const enable = await start(() => hook.enable());
  await event("change", "background");
  await event("change", "active");
  await act(async () => {
    gate.resolve();
    await enable.task;
    await drain();
  });
  expect(native.schedule).toHaveBeenCalledTimes(3);
  expect(native.scheduled.size).toBe(1);
  expect([...native.scheduled.keys()]).toEqual(["parse.phone.occ_one.g2"]);
  expect(native.speak).not.toHaveBeenCalled();
});
