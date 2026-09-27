import { useEffect, useRef, useState } from "react";
import { PushRegistrationSync, tokenDeadline } from "./pushRegistration";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Crypto from "expo-crypto";
import { AudioModule } from "expo-audio";
import { PhoneApi, ApiError } from "./api";
import type { Home, Reminder, ReminderSchedule } from "./contracts";
import { ReminderDelivery } from "./reminderDelivery";
import { readPlayback, writePlayback, listPlayback } from "./reminderStorage";
import { loadPending } from "./storage";
import {
  AlertSerialiser,
  ALERT_BODY,
  ALERT_TITLE,
  desiredAlerts,
} from "./alertSchedule";

type Voice = {
  reminder: (
    event: Reminder,
    prepare: () => Promise<void>,
    authorize: () => Promise<void>,
  ) => Promise<"completed" | "busy">;
  phase: string;
};
type Options = {
  api: PhoneApi | null;
  home: Home | null;
  voice: Voice;
  ready: boolean;
  refresh: () => Promise<Home | null>;
  onReminder: (event: Reminder) => void;
};
// Foreground speech owns the audible prompt. Suppress duplicate OS banners/sounds
// while JS is active; background/terminated delivery is left to the native OS.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: false,
    shouldShowList: false,
  }),
});
export function useReminders(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [status, setStatus] = useState("Alerts have not been enabled.");
  const [pushStatus, setPushStatus] = useState("Checking push registration.");
  const previousCleanup = useRef<Promise<void>>(Promise.resolve());
  const controls = useRef({
    enable: async () => {},
    pause: async () => {},
    resume: () => {},
  });
  useEffect(() => {
    const api = options.api;
    if (!api) {
      controls.current = {
        enable: async () => {},
        // Losing access does not prove that native cleanup has finished. Keep
        // the preceding session's drain/retry action available without reads.
        pause: controls.current.pause,
        resume: () => {},
      };
      return;
    }
    let alive = true,
      active = AppState.currentState === "active",
      epoch = 0;
    let busy = false,
      rerun = false,
      forcePush = true,
      enabling = false;
    let coverage: ReminderSchedule | null = null;
    let scheduledClock: { offset: number; zone: string } | null = null;
    let requestedRefresh = 0,
      appliedRefresh = -1;
    let permission = "unknown",
      microphone = "unknown";
    const inheritedCleanup = previousCleanup.current;
    let pauseWork = inheritedCleanup;
    const serial = new AlertSerialiser();
    serial.suspended = true; // Wait for the preceding installation's cleanup.
    const bound = () => alive && latest.current.api === api;
    const current = (version: number) =>
      bound() && active && !serial.suspended && version === epoch;
    const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
    const push = new PushRegistrationSync<Notifications.DevicePushToken>({
      read: () => api.pushRegistration(),
      write: (token, state) => api.registerPush(token, state),
      acquire: async (devicePushToken) =>
        (
          await tokenDeadline(
            Notifications.getExpoPushTokenAsync({
              projectId,
              ...(devicePushToken ? { devicePushToken } : {}),
            }),
          )
        ).data,
      configured: !!projectId && /^[a-f0-9-]{36}$/i.test(projectId),
      current: () => bound() && active && !serial.suspended,
      status: (message) => {
        if (bound()) setPushStatus(message);
      },
    });
    const playback = new ReminderDelivery({
      read: readPlayback,
      write: writePlayback,
      uuid: Crypto.randomUUID,
      current: (id) => api.currentReminder(id),
      ack: (id, key, stage) => api.ack(id, key, stage),
      cancelAlert: async (identity) => {
        await Notifications.cancelScheduledNotificationAsync(identity);
        await Notifications.dismissNotificationAsync(identity);
      },
      play: (event, prepare, authorize) =>
        bound()
          ? latest.current.voice.reminder(event, prepare, authorize)
          : Promise.resolve("busy"),
      completed: (event) => {
        if (bound()) latest.current.onReminder(event);
      },
    });
    async function clearAlerts() {
      await Notifications.cancelAllScheduledNotificationsAsync();
      await Notifications.dismissAllNotificationsAsync();
      if ((await Notifications.getAllScheduledNotificationsAsync()).length)
        throw new Error(
          "Some alerts remain scheduled. Keep this phone selected and try Pause reminders again.",
        );
      coverage = null;
      scheduledClock = null;
    }
    function pause() {
      epoch++;
      const clearing = serial.clear(async () => {
        // A rapid identity change can expose a new Pause action while the old
        // native scheduler is still draining. Wait before clearing this app's
        // alerts; a completed failure may then be retried by this cleanup.
        await inheritedCleanup.catch(() => {});
        await clearAlerts();
      });
      const stoppingPush = push.pause();
      pauseWork = Promise.allSettled([
        clearing,
        stoppingPush,
        playback.whenIdle(),
      ]).then((results) => {
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      });
      return pauseWork;
    }
    async function permissions(request = false) {
      if (Platform.OS === "android")
        await Notifications.setNotificationChannelAsync("parse-care", {
          name: "Parse care reminders",
          importance: Notifications.AndroidImportance.DEFAULT,
          lockscreenVisibility:
            Notifications.AndroidNotificationVisibility.PRIVATE,
          sound: "default",
        });
      const result = request
        ? await Notifications.requestPermissionsAsync({
            ios: { allowAlert: true, allowSound: true, allowBadge: false },
          })
        : await Notifications.getPermissionsAsync();
      let value =
        result.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
          ? "provisional"
          : result.status;
      if (Platform.OS === "android") {
        const channel =
          await Notifications.getNotificationChannelAsync("parse-care");
        if (channel?.importance === Notifications.AndroidImportance.NONE)
          value = "denied";
      }
      const mic = (await AudioModule.getRecordingPermissionsAsync()).status;
      return {
        notification: value,
        microphone: mic,
        granted: value === "granted" || value === "provisional",
      };
    }
    function sendPresence() {
      return api!.presence({
        lifecycle: active ? "foreground" : "background",
        microphone_permission: microphone,
        notification_permission: permission,
        schedule_revision: coverage?.revision || null,
        scheduled_until: coverage?.covered_until || null,
      });
    }
    function report(error: unknown) {
      if (bound())
        setStatus(
          error instanceof Error
            ? error.message
            : "Reminder connection unavailable. Previously scheduled alerts remain generic.",
        );
    }
    async function sync(force = false) {
      forcePush ||= force;
      if (force) requestedRefresh++;
      if (!bound() || !active || !latest.current.home || serial.suspended)
        return;
      if (busy) {
        rerun = true;
        return;
      }
      busy = true;
      const version = epoch;
      try {
        const observed = await permissions();
        if (!current(version)) return;
        const restored =
          !["granted", "provisional"].includes(permission) && observed.granted;
        permission = observed.notification;
        microphone = observed.microphone;
        if (!observed.granted) {
          // Clear locally even if the backend is unreachable. Drain a pending
          // registration before reporting denial, so it cannot re-enable push.
          await serial.run(async (valid) => {
            if (valid() && current(version)) await clearAlerts();
          });
          await push.pause();
          if (!current(version)) return;
          setStatus("Notifications are off. Voice works while Parse is open.");
          setPushStatus(
            "Notifications are off on this phone. The server has not confirmed this permission change.",
          );
        }
        await sendPresence();
        if (!current(version)) return;
        push.resume();
        const refreshPush = forcePush || restored;
        forcePush = false;
        void push.sync(refreshPush);
        const schedule = await api!.schedule();
        if (!current(version)) return;
        await serial.run(async (valid) => {
          if (!valid() || !current(version)) return;
          const now = Date.now();
          const desired = observed.granted ? desiredAlerts(schedule, now) : [];
          const clock = {
            offset: now - Date.parse(schedule.server_time),
            zone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
          };
          const refresh = requestedRefresh;
          // Android date alarms retain the device's old wall-clock timestamp.
          // Rebase when its offset from the server changes; allow five seconds
          // of response-time variation to avoid churning alarms on every poll.
          // Keep the last rebuild's offset so small cumulative drift is caught.
          const rebuild =
            appliedRefresh !== refresh ||
            coverage?.revision !== schedule.revision ||
            !scheduledClock ||
            Math.abs(scheduledClock.offset - clock.offset) > 5000 ||
            scheduledClock.zone !== clock.zone;
          let existing =
            await Notifications.getAllScheduledNotificationsAsync();
          if (!valid() || !current(version)) return;
          if (rebuild) {
            for (const entry of existing) {
              if (!valid() || !current(version)) return;
              await Notifications.cancelScheduledNotificationAsync(
                entry.identifier,
              );
            }
            existing = [];
          }
          const ids = new Set(desired.map((a) => a.id));
          for (const entry of existing) {
            if (!valid() || !current(version)) return;
            if (!ids.has(entry.identifier))
              await Notifications.cancelScheduledNotificationAsync(
                entry.identifier,
              );
          }
          for (const alert of desired) {
            if (!valid() || !current(version)) return;
            if (!existing.some((e) => e.identifier === alert.id)) {
              await Notifications.scheduleNotificationAsync({
                identifier: alert.id,
                content: {
                  title: ALERT_TITLE,
                  body: ALERT_BODY,
                  sound: "default",
                  data: { parse: true, identity: alert.id },
                },
                trigger: {
                  type: Notifications.SchedulableTriggerInputTypes.DATE,
                  date: new Date(alert.at),
                  channelId: "parse-care",
                },
              });
              if (!valid() || !current(version)) return;
              void api!
                .notificationEvent(alert.id, Crypto.randomUUID(), "scheduled")
                .catch(() => {});
            }
          }
          if (!valid() || !current(version)) return;
          coverage = observed.granted ? schedule : null;
          if (rebuild) scheduledClock = observed.granted ? clock : null;
          // A foreground refresh requested while native work was pending must
          // still run; do not consume a later request with this completion.
          appliedRefresh = refresh;
          setStatus(
            !observed.granted
              ? "Notifications are off. Voice works while Parse is open."
              : schedule.active_companion.device_id !== schedule.device_id
                ? "This phone is not selected for reminders."
                : schedule.truncated
                  ? "Some alerts exceed the phone schedule limit. Reopen Parse regularly to refresh them."
                  : "Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.",
          );
        });
        if (!current(version)) return;
        await sendPresence();
        if (!current(version)) return;
        await playback.reconcile(await listPlayback(), () => current(version));
        if (!current(version)) return;
        if (
          latest.current.ready &&
          !latest.current.home?.current_proposal &&
          !(await loadPending())
        ) {
          if (!current(version)) return;
          const pending = await api!.pending();
          if (
            !current(version) ||
            pending.active_companion.device_id !== schedule.device_id
          )
            return;
          for (const command of [...pending.commands, ...pending.checkins]) {
            if (!current(version) || !latest.current.ready) break;
            const result = await playback.deliver(command);
            if (result === "completed" || result === "busy") break;
          }
        }
      } catch (error) {
        if (!bound()) return;
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          try {
            await pause();
          } catch (cleanupError) {
            report(cleanupError);
            return;
          }
        }
        report(error);
      } finally {
        busy = false;
        if (rerun && bound()) {
          rerun = false;
          void sync();
        }
      }
    }
    async function enable() {
      if (!bound() || enabling) return;
      if (serial.suspended) {
        setStatus(
          "Reminders are paused. Finish or retry Pause reminders before enabling alerts.",
        );
        return;
      }
      enabling = true;
      const version = epoch;
      try {
        await permissions(true);
        if (!bound() || version !== epoch) return;
        await sync(true);
      } catch (error) {
        report(error);
      } finally {
        enabling = false;
      }
    }
    function resume() {
      const version = epoch;
      void pauseWork
        .then(() => {
          if (!bound() || version !== epoch) return;
          serial.resume();
          push.resume();
          void sync(true);
        })
        .catch(report);
    }
    controls.current = { enable, pause, resume };
    function refreshFromAlert(identity: unknown) {
      if (!bound()) return;
      if (typeof identity === "string")
        void api!
          .notificationEvent(identity, Crypto.randomUUID(), "opened")
          .catch(() => {});
      // A tap is read-only: reconcile care before considering current commands.
      void latest.current
        .refresh()
        .then(() => {
          if (bound()) return sync();
        })
        .catch(report);
    }
    const received = Notifications.addNotificationReceivedListener(
      (notification) => {
        if (!bound()) return;
        const identity = notification.request.content.data?.identity;
        if (typeof identity === "string")
          void api!
            .notificationEvent(identity, Crypto.randomUUID(), "suppressed")
            .catch(() => {});
        void latest.current
          .refresh()
          .then(() => sync())
          .catch(report);
      },
    );
    const tapped = Notifications.addNotificationResponseReceivedListener(
      (response) =>
        refreshFromAlert(response.notification.request.content.data?.identity),
    );
    const changed = Notifications.addPushTokenListener((deviceToken) => {
      // Pass the supplied native token through to Expo. Fetching a new device
      // token inside its listener can recursively trigger another token event.
      if (bound() && active && !serial.suspended)
        void push.sync(true, deviceToken);
      else forcePush = true;
    });
    const lifecycle = AppState.addEventListener("change", (state) => {
      active = state === "active";
      if (active)
        void latest.current
          .refresh()
          .then(() => sync(true))
          .catch(report);
      else if (bound()) void sendPresence().catch(() => {});
    });
    const interval = setInterval(() => {
      if (busy && active && !serial.suspended)
        void sendPresence().catch(() => {});
      void sync();
    }, 5000);
    const startupEpoch = epoch;
    void pauseWork
      .then(() => {
        if (!bound() || epoch !== startupEpoch) return;
        serial.resume();
        const last = Notifications.getLastNotificationResponse();
        if (last) {
          refreshFromAlert(last.notification.request.content.data?.identity);
          void Notifications.clearLastNotificationResponseAsync();
        }
        void sync(true);
      })
      .catch(report);
    return () => {
      alive = false;
      clearInterval(interval);
      received.remove();
      tapped.remove();
      changed.remove();
      lifecycle.remove();
      previousCleanup.current = pause();
      // A new installation awaits the same promise and stays paused on failure.
      void previousCleanup.current.catch(() => {});
    };
  }, [options.api]);
  return {
    status,
    pushStatus,
    enable: () => controls.current.enable(),
    pause: () => controls.current.pause(),
    resume: () => controls.current.resume(),
  };
}
