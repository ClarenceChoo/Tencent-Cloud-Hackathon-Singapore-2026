import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Crypto from "expo-crypto";
import { AudioModule } from "expo-audio";
import { PhoneApi, ApiError } from "./api";
import type { Home, Reminder, ReminderSchedule } from "./contracts";
import { ReminderDelivery } from "./reminderDelivery";
import { readPlayback, writePlayback } from "./reminderStorage";
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
  refresh: () => Promise<void>;
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
  const [pushStatus, setPushStatus] = useState(
    "Push updates are not configured for this build.",
  );
  const serial = useRef(new AlertSerialiser());
  const syncRef = useRef<() => Promise<void>>(async () => {});
  const coverage = useRef<ReminderSchedule | null>(null);
  const token = useRef<string | null>(null);
  const active = useRef(AppState.currentState === "active");
  const permission = useRef("unknown");
  const microphone = useRef("unknown");
  const busy = useRef(false);
  const playback = useRef<ReminderDelivery | null>(null);
  const cancelled = async (identity: string) => {
    await Notifications.cancelScheduledNotificationAsync(identity);
    await Notifications.dismissNotificationAsync(identity);
  };
  async function pause() {
    await serial.current.clear(async () => {
      await Notifications.cancelAllScheduledNotificationsAsync();
      await Notifications.dismissAllNotificationsAsync();
      if ((await Notifications.getAllScheduledNotificationsAsync()).length)
        throw new Error(
          "Some alerts remain scheduled. Keep this phone selected and try again.",
        );
      coverage.current = null;
    });
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
    permission.current =
      result.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
        ? "provisional"
        : result.status;
    if (Platform.OS === "android") {
      const channel =
        await Notifications.getNotificationChannelAsync("parse-care");
      if (channel?.importance === Notifications.AndroidImportance.NONE)
        permission.current = "denied";
    }
    microphone.current = (
      await AudioModule.getRecordingPermissionsAsync()
    ).status;
    return (
      permission.current === "granted" || permission.current === "provisional"
    );
  }
  async function sendPresence(api: PhoneApi) {
    await api.presence({
      lifecycle: active.current ? "foreground" : "background",
      microphone_permission: microphone.current,
      notification_permission: permission.current,
      schedule_revision: coverage.current?.revision || null,
      scheduled_until: coverage.current?.covered_until || null,
    });
  }
  async function enable() {
    try {
      const granted = await permissions(true);
      if (!granted) {
        setStatus(
          "Notifications are off. Enable them in phone Settings for background alerts.",
        );
        await pause();
        return;
      }
      serial.current.resume();
      const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
      if (projectId && /^[a-f0-9-]{36}$/i.test(projectId)) {
        try {
          token.current = (
            await Notifications.getExpoPushTokenAsync({ projectId })
          ).data;
          const result = await latest.current.api?.registerPush(token.current);
          setPushStatus(
            result?.push_configured
              ? "Push registration accepted. Delivery depends on phone settings and network access."
              : "Push token registered; the server push service is not enabled.",
          );
        } catch {
          setPushStatus(
            "Push registration failed. Local scheduled alerts can still work; try Enable alerts again.",
          );
        }
      }
      await syncRef.current();
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Could not enable alerts.",
      );
    }
  }
  useEffect(() => {
    const api = options.api;
    if (!api) return;
    let alive = true;
    serial.current.resume();
    playback.current = new ReminderDelivery({
      read: readPlayback,
      write: writePlayback,
      uuid: Crypto.randomUUID,
      current: (id) => api.currentReminder(id),
      ack: (id, key, stage) => api.ack(id, key, stage),
      cancelAlert: cancelled,
      play: (event, prepare, authorize) =>
        latest.current.voice.reminder(event, prepare, authorize),
      completed: (event) => {
        if (alive) latest.current.onReminder(event);
      },
    });
    async function sync() {
      if (
        !alive ||
        !active.current ||
        !latest.current.home ||
        busy.current ||
        serial.current.suspended
      )
        return;
      busy.current = true;
      try {
        const granted = await permissions();
        const schedule = await api!.schedule();
        if (!alive || serial.current.suspended) return;
        await serial.current.run(async (current) => {
          const desired = granted ? desiredAlerts(schedule, Date.now()) : [];
          let existing =
            await Notifications.getAllScheduledNotificationsAsync();
          if (coverage.current?.revision !== schedule.revision) {
            for (const entry of existing)
              await Notifications.cancelScheduledNotificationAsync(
                entry.identifier,
              );
            existing = [];
          }
          const desiredIds = new Set(desired.map((a) => a.id));
          for (const entry of existing)
            if (!desiredIds.has(entry.identifier))
              await Notifications.cancelScheduledNotificationAsync(
                entry.identifier,
              );
          for (const alert of desired) {
            if (!current() || !alive) return;
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
              void api!
                .notificationEvent(alert.id, Crypto.randomUUID(), "scheduled")
                .catch(() => {});
            }
          }
          if (!current() || !alive) return;
          coverage.current = granted ? schedule : null;
          setStatus(
            !granted
              ? "Notifications are off. Voice works while Parse is open."
              : schedule.active_companion.device_id !== schedule.device_id
                ? "This phone is not selected for reminders."
                : schedule.truncated
                  ? "Some alerts exceed the phone schedule limit. Reopen Parse regularly to refresh them."
                  : "Generic alerts scheduled for up to 24 hours. Focus and battery restrictions may delay them.",
          );
        });
        if (!alive || serial.current.suspended) return;
        await sendPresence(api!);
        if (
          latest.current.ready &&
          !latest.current.home?.current_proposal &&
          !(await loadPending())
        ) {
          const pending = await api!.pending();
          if (pending.active_companion.device_id !== schedule.device_id) return;
          for (const command of [...pending.commands, ...pending.checkins]) {
            if (
              !alive ||
              !active.current ||
              serial.current.suspended ||
              !latest.current.ready
            )
              break;
            const result = await playback.current!.deliver(command);
            if (result === "completed" || result === "busy") break;
          }
        }
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && [401, 403].includes(error.status))
          await pause();
        setStatus(
          error instanceof Error
            ? error.message
            : "Reminder connection unavailable. Previously scheduled alerts remain generic.",
        );
      } finally {
        busy.current = false;
      }
    }
    syncRef.current = sync;
    const refreshFromAlert = (identity: unknown) => {
      if (typeof identity === "string")
        void api
          .notificationEvent(identity, Crypto.randomUUID(), "opened")
          .catch(() => {});
      // Taps never play cached audio or confirm a dose. Refresh and poll current server commands.
      void latest.current
        .refresh()
        .then(sync)
        .catch(() => {});
    };
    const received = Notifications.addNotificationReceivedListener(
      (notification) => {
        const id = notification.request.content.data?.identity;
        if (typeof id === "string")
          void api
            .notificationEvent(id, Crypto.randomUUID(), "suppressed")
            .catch(() => {});
        void sync();
      },
    );
    const tapped = Notifications.addNotificationResponseReceivedListener(
      (response) =>
        refreshFromAlert(response.notification.request.content.data?.identity),
    );
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      refreshFromAlert(last.notification.request.content.data?.identity);
      void Notifications.clearLastNotificationResponseAsync();
    }
    const lifecycle = AppState.addEventListener("change", (state) => {
      active.current = state === "active";
      if (active.current)
        void latest.current
          .refresh()
          .then(sync)
          .catch(() => {});
      else void sendPresence(api).catch(() => {});
    });
    const interval = setInterval(() => {
      if (busy.current && active.current && !serial.current.suspended)
        void sendPresence(api).catch(() => {});
      void sync();
    }, 5000);
    void sync();
    return () => {
      alive = false;
      clearInterval(interval);
      received.remove();
      tapped.remove();
      lifecycle.remove();
    };
  }, [options.api]);
  return {
    status,
    pushStatus,
    enable,
    pause,
    resume: () => {
      serial.current.resume();
      void syncRef.current();
    },
  };
}
