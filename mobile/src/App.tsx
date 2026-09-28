import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ApiError, PhoneApi } from "./api";
import type { CareRow, Enrollment, Home, Installation } from "./contracts";
import {
  clearInstallation,
  loadInstallation,
  loadPending,
  newInstallation,
} from "./storage";
import * as Notifications from "expo-notifications";
import { useVoice } from "./useVoice";
import { useReminders } from "./useReminders";
import { CareOrigin, CareHistory } from "./CareOrigin";
import { useTalkMode } from "./useTalkMode";

const value = (row: CareRow, key: string) =>
  typeof row[key] === "string" ? (row[key] as string) : "";
function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[s.button, secondary && s.secondary, disabled && s.disabled]}
    >
      <Text style={[s.buttonText, secondary && s.secondaryText]}>{title}</Text>
    </Pressable>
  );
}
function Companion() {
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [restored, setRestored] = useState(false);
  const [service, setService] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [reminderContext, setReminderContext] = useState<{
    id: string;
    expires: number;
  } | null>(null);
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState("");
  const [connectionProblem, setConnectionProblem] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const retryConnection = useRef<(() => Promise<void>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState("");
  const [testingSpeaker, setTestingSpeaker] = useState(false);
  const [speakerMessage, setSpeakerMessage] = useState("");
  const [recoveryDetails, setRecoveryDetails] = useState<
    "checking" | "empty" | "pending" | "unreadable"
  >("empty");
  const [recoveryCheck, setRecoveryCheck] = useState(0);
  const speakerRequest = useRef<AbortController | null>(null);
  const [booting, setBooting] = useState(true);
  const interaction = useTalkMode();
  const { tapMode } = interaction;
  const [section, setSection] = useState("Today");
  const [accessProblem, setAccessProblem] = useState("");
  const [cleanupNeeded, setCleanupNeeded] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState("");
  const identityEpoch = useRef(0);
  const actionBusy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      identityEpoch.current++;
    };
  }, []);
  const transportApi = useMemo(
    () => (installation && !restored ? new PhoneApi(installation) : null),
    [installation, restored],
  );
  const api = accessProblem ? null : transportApi;
  const currentApi = useRef(api);
  currentApi.current = api;
  const denyRef = useRef<(source: PhoneApi, error: unknown) => Promise<void>>(
    async () => {},
  );
  const homeVersion = useRef(0);
  const showError = (err: unknown) =>
    setError(
      err instanceof Error
        ? err.message
        : "Parse could not connect. Please try again.",
    );
  const refresh = useCallback(async () => {
    if (api) {
      const version = ++homeVersion.current;
      try {
        const next = await api.home();
        if (
          !mounted.current ||
          api !== currentApi.current ||
          version !== homeVersion.current
        )
          return null;
        setHome(next);
        return next;
      } catch (err) {
        // Do not await a stop from inside a voice/recovery operation: stopping
        // drains that operation. Fence the UI immediately, then drain outside it.
        if (err instanceof ApiError && [401, 403].includes(err.status))
          void denyRef.current(api, err);
        throw err;
      }
    }
    return null;
  }, [api]);
  const voice = useVoice(
    api,
    home?.current_proposal?.context_id ||
      (reminderContext && reminderContext.expires > Date.now()
        ? reminderContext.id
        : null),
    refresh,
    !!home && !busy,
  );
  useEffect(() => {
    let current = true;
    if (!api || voice.phase !== "error") {
      setRecoveryDetails("empty");
      return;
    }
    setRecoveryDetails("checking");
    // A playback or permission error does not imply an unfinished recording.
    // Read the protected journal and ignore results from an earlier error/identity.
    void loadPending()
      .then((pending) => {
        if (current) setRecoveryDetails(pending ? "pending" : "empty");
      })
      .catch(() => {
        if (current) setRecoveryDetails("unreadable");
      });
    return () => {
      current = false;
    };
  }, [api, voice.phase, voice.message, recoveryCheck]);
  useEffect(() => {
    const cancel = () => speakerRequest.current?.abort();
    const state = AppState.addEventListener("change", (value) => {
      if (value !== "active") cancel();
    });
    const blur = AppState.addEventListener("blur", cancel);
    return () => {
      cancel();
      state.remove();
      blur.remove();
    };
  }, [api]);
  const reminders = useReminders({
    api,
    home,
    voice,
    refresh,
    ready:
      !busy &&
      ["idle", "error"].includes(voice.phase) &&
      (!reminderContext || reminderContext.expires <= Date.now()),
    onReminder: (event) =>
      setReminderContext({
        id: event.payload.context_id,
        expires: Date.parse(event.expires_at),
      }),
  });
  function startTalking() {
    if (
      !interaction.ready ||
      !currentApi.current ||
      actionBusy.current ||
      cleanupBusy
    )
      return;
    const started = voice.begin().catch(showError);
    setReminderContext(null);
    return started;
  }
  useEffect(() => {
    void loadInstallation()
      .then((saved) => {
        if (!mounted.current) return;
        setInstallation(saved.installation);
        setRestored(saved.restored);
        setService(saved.installation?.service || "");
      })
      .catch(showError)
      .finally(() => setBooting(false));
  }, []);
  useEffect(() => {
    if (!api) {
      retryConnection.current = null;
      setCheckingConnection(false);
      return;
    }
    let running = false;
    let alive = true;
    async function sync() {
      if (
        running ||
        !alive ||
        api !== currentApi.current ||
        AppState.currentState !== "active"
      )
        return;
      running = true;
      setCheckingConnection(true);
      try {
        let next: Enrollment;
        try {
          next = await api!.enrollment();
        } catch (err) {
          if (err instanceof ApiError && err.status === 401)
            next = await api!.enroll();
          else throw err;
        }
        if (!alive || api !== currentApi.current) return;
        setEnrollment(next);
        if (next.status === "paired") await refresh();
        if (alive && api === currentApi.current) setConnectionProblem(false);
      } catch (err) {
        if (alive && api === currentApi.current) {
          if (err instanceof ApiError && [401, 403].includes(err.status)) {
            await denyRef.current(api!, err);
          } else setConnectionProblem(true);
        }
      } finally {
        running = false;
        if (alive && api === currentApi.current) setCheckingConnection(false);
      }
    }
    retryConnection.current = sync;
    void sync();
    const timer = setInterval(() => {
      void sync();
    }, 5000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    return () => {
      alive = false;
      if (retryConnection.current === sync) retryConnection.current = null;
      clearInterval(timer);
      listener.remove();
    };
  }, [api, refresh]);
  async function action(
    work: (valid: () => boolean) => Promise<void>,
    message = "Updating Parse…",
  ) {
    if (
      actionBusy.current ||
      cleanupBusy ||
      (api && api !== currentApi.current)
    )
      return;
    actionBusy.current = true;
    const epoch = identityEpoch.current;
    const source = api;
    const valid = () => mounted.current && epoch === identityEpoch.current;
    setBusy(true);
    setBusyMessage(message);
    setError("");
    try {
      await work(valid);
    } catch (err) {
      if (valid()) {
        if (
          source &&
          err instanceof ApiError &&
          [401, 403].includes(err.status)
        )
          await denyRef.current(source, err);
        else showError(err);
      }
    } finally {
      actionBusy.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function connect() {
    await action(async (valid) => {
      const created = await newInstallation(
        service,
        Platform.OS === "ios" ? "ios" : "android",
      );
      if (!valid()) return;
      setInstallation(created);
      setRestored(false);
    }, "Connecting to Parse…");
  }
  async function stopLocalReminders(after?: () => Promise<void>) {
    await voice.stop(async () => {
      await reminders.pause();
      await Notifications.cancelAllScheduledNotificationsAsync();
      await Notifications.dismissAllNotificationsAsync();
      const remaining = await Notifications.getAllScheduledNotificationsAsync();
      if (remaining.length)
        throw new Error(
          "Some alerts are still scheduled. Keep this phone selected and try again.",
        );
      await after?.();
    });
  }
  const cleaning = useRef<Promise<void> | null>(null);
  async function cleanupDenied(source = transportApi) {
    if (cleaning.current) return cleaning.current;
    setCleanupBusy(true);
    cleaning.current = (async () => {
      try {
        await stopLocalReminders(async () => {
          if (source) {
            try {
              await source.quiesce();
            } catch (err) {
              if (!(err instanceof ApiError && err.status === 401)) throw err;
            }
          }
        });
        if (mounted.current) {
          setCleanupNeeded(false);
          setCleanupMessage(
            "Local audio and alerts are cleared. Start a new pairing to reconnect.",
          );
        }
      } catch (err) {
        if (mounted.current) {
          setCleanupNeeded(true);
          setCleanupMessage(
            err instanceof Error
              ? err.message
              : "Local cleanup needs another attempt.",
          );
        }
      } finally {
        cleaning.current = null;
        if (mounted.current) setCleanupBusy(false);
      }
    })();
    return cleaning.current;
  }
  denyRef.current = async (source, err) => {
    if (!mounted.current || source !== currentApi.current) return;
    // Remove care and block admission before any native/network cleanup await.
    currentApi.current = null;
    identityEpoch.current++;
    setAccessProblem(
      err instanceof ApiError && err.status === 403
        ? "This phone's access has been revoked."
        : "This phone can no longer access the care space.",
    );
    setHome(null);
    setEnrollment(null);
    setReminderContext(null);
    setError("");
    setCleanupNeeded(true);
    await cleanupDenied(source);
  };
  async function pauseReminders() {
    if (!api) return;
    await action(async (valid) => {
      await stopLocalReminders(async () => {
        await api.quiesce();
      });
      if (!valid()) return;
      await refresh();
      if (valid()) reminders.resume();
    }, "Stopping audio and clearing this phone's reminders…");
  }
  async function unpair() {
    await action(async (valid) => {
      const cleanupApi =
        api || (installation ? new PhoneApi(installation) : null);
      await stopLocalReminders(async () => {
        if (cleanupApi) {
          // A restored/revoked credential is used only for local removal and
          // restricted server cleanup, never to resume access to care records.
          try {
            await cleanupApi.quiesce();
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 401)) throw err;
          }
          try {
            await cleanupApi.revoke();
          } catch (err) {
            if (!(err instanceof ApiError && [401, 403].includes(err.status)))
              throw err;
          }
        }
      });
      if (!valid()) return;
      await clearInstallation();
      if (!valid()) return;
      identityEpoch.current++;
      currentApi.current = null;
      setInstallation(null);
      setEnrollment(null);
      setHome(null);
      setRestored(false);
      setAccessProblem("");
      setCleanupNeeded(false);
      setCleanupMessage("");
      setReminderContext(null);
      setConnectionProblem(false);
    }, "Stopping audio and removing this phone's access…");
  }
  async function confirm() {
    const proposal = home?.current_proposal;
    if (!proposal || !api) return;
    await action(async (valid) => {
      await voice.stop();
      if (!valid()) return;
      await api.confirm(proposal.id, proposal.context_id);
      if (!valid()) return;
      await refresh();
      if (!valid()) return;
      try {
        const reply = await api.speech(proposal.id, proposal.context_id);
        if (valid()) await voice.speak(reply);
      } catch (err) {
        if (err instanceof ApiError && [401, 403].includes(err.status))
          throw err;
        if (valid())
          setError("Saved. Spoken confirmation is currently unavailable.");
      }
    }, "Saving your confirmed update…");
  }
  async function cancel() {
    const proposal = home?.current_proposal;
    if (!proposal || !api) return;
    await action(async (valid) => {
      await voice.stop();
      if (!valid()) return;
      await api.cancel(proposal.id, proposal.context_id);
      if (valid()) await refresh();
    }, "Cancelling this unsaved update…");
  }
  async function hearReadback() {
    const proposal = home?.current_proposal;
    if (!proposal || !api) return;
    await action(async (valid) => {
      await voice.stop();
      if (!valid()) return;
      const reply = await api.speech(proposal.id, proposal.context_id);
      if (valid()) await voice.speak(reply);
    }, "Checking the current read-back…");
  }
  async function openExternal(settings = false) {
    const address = installation?.service;
    await action(async (valid) => {
      await voice.stop();
      if (!valid()) return;
      if (settings) await Linking.openSettings();
      else if (address) await Linking.openURL(address);
    }, "Stopping audio before opening the next screen…");
  }
  async function testSpeaker() {
    if (!api) return;
    await action(async (valid) => {
      const controller = new AbortController();
      speakerRequest.current = controller;
      setTestingSpeaker(true);
      setSpeakerMessage("Preparing the speaker test…");
      try {
        await voice.stop();
        if (!valid() || controller.signal.aborted) return;
        const reply = await api.testSpeaker(controller.signal);
        if (!valid() || controller.signal.aborted) return;
        setSpeakerMessage(
          reply.payload.simulated
            ? "Simulated audio test. This does not verify live speech."
            : "Listen for the test message. Use your phone's media volume buttons to adjust it.",
        );
        await voice.speak(reply);
      } catch (err) {
        if (!controller.signal.aborted) {
          setSpeakerMessage(
            "The speaker test could not start. Check your connection and try again.",
          );
          throw err;
        }
      } finally {
        if (speakerRequest.current === controller)
          speakerRequest.current = null;
        if (valid()) {
          setTestingSpeaker(false);
          if (controller.signal.aborted)
            setSpeakerMessage("Speaker test stopped.");
        }
      }
    }, "Preparing the speaker test…");
  }
  async function stopSpeakerTest() {
    speakerRequest.current?.abort();
    await voice.stop().catch(showError);
  }
  const isRecording =
    voice.phase === "recording" || voice.phase === "preparing";
  const previousMode = useRef(tapMode);
  useEffect(() => {
    if (previousMode.current !== tapMode && isRecording)
      void voice.stop().catch(showError);
    previousMode.current = tapMode;
  }, [tapMode, isRecording]);
  const canTalk =
    !!home &&
    interaction.ready &&
    ["configured", "simulated"].includes(home.voice.voice_service) &&
    !busy &&
    ["idle", "error", "recording", "preparing"].includes(voice.phase);
  return (
    <SafeAreaView style={s.safe}>
      <ScrollView
        contentContainerStyle={s.page}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.brandRow}>
          <Text style={s.brand}>parse</Text>
          <Text style={s.small}>YOUR CARE COMPANION</Text>
        </View>
        {connectionProblem &&
          !accessProblem &&
          !restored &&
          (home || enrollment?.status === "awaiting_approval") && (
            <View accessibilityRole="alert" style={s.notice}>
              <Text style={s.heading}>Cannot refresh Parse</Text>
              <Text style={s.body}>
                {home
                  ? "Showing previously loaded care details. Recent changes may be missing."
                  : "Parse cannot check the owner's approval right now."}{" "}
                Check your internet connection. Parse will try again while this
                screen is open.
              </Text>
              <Button
                title={
                  checkingConnection
                    ? "Checking connection…"
                    : "Retry connection"
                }
                disabled={busy || checkingConnection}
                onPress={() => {
                  void retryConnection.current?.();
                }}
              />
            </View>
          )}
        {booting ? (
          <ActivityIndicator accessibilityLabel="Loading your pairing" />
        ) : !home ? (
          <>
            <Text style={s.title}>A familiar voice.{"\n"}One care space.</Text>
            <Text style={s.body}>
              Speak about your day, hear a read-back, and choose what to save or
              share.
            </Text>
            {accessProblem ? (
              <View style={s.card} accessibilityRole="alert">
                <Text style={s.heading}>Phone access stopped</Text>
                <Text style={s.body}>{accessProblem}</Text>
                <Text style={s.body}>
                  {cleanupBusy
                    ? "Stopping local audio and alerts…"
                    : cleanupMessage}
                </Text>
                {cleanupNeeded && (
                  <Button
                    title="Retry local cleanup"
                    secondary
                    disabled={busy || cleanupBusy}
                    onPress={() => {
                      void cleanupDenied();
                    }}
                  />
                )}
                <Button
                  title="Start a new pairing"
                  disabled={busy || cleanupBusy || cleanupNeeded}
                  onPress={() => {
                    void unpair();
                  }}
                />
              </View>
            ) : restored ? (
              <View style={s.card}>
                <Text style={s.heading}>
                  Pairing from an earlier installation
                </Text>
                <Text style={s.body}>
                  Ask your care-space owner to revoke the old phone in Settings.
                  Start a new pairing to give this installation its own
                  identity.
                </Text>
                <Button
                  title="Start a new pairing"
                  disabled={busy}
                  onPress={() => {
                    void unpair();
                  }}
                />
              </View>
            ) : enrollment?.status === "awaiting_approval" ? (
              <View style={s.card}>
                <Text style={s.heading}>Connect this phone</Text>
                <Text style={s.body}>
                  In the Parse dashboard, open Settings, choose Parse phone app,
                  and enter this code for the correct person.
                </Text>
                <Text
                  selectable
                  accessibilityLabel={"Pairing code " + enrollment.code}
                  style={s.code}
                >
                  {enrollment.code}
                </Text>
                <Text style={s.body}>
                  Expires{" "}
                  {enrollment.expires_at
                    ? new Date(enrollment.expires_at).toLocaleTimeString()
                    : "soon"}
                  . Waiting for the owner’s approval.
                </Text>
                <Button
                  title="Restart pairing"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void unpair();
                  }}
                />
              </View>
            ) : installation ? (
              <View style={s.card} accessibilityLiveRegion="polite">
                <Text style={s.heading}>
                  {connectionProblem
                    ? "Cannot reach Parse"
                    : "Connecting to Parse"}
                </Text>
                <Text style={s.body}>
                  {connectionProblem
                    ? "Your saved connection is still on this phone. Parse cannot check your access or load your care details right now."
                    : "Checking this phone's access and loading your care details…"}
                </Text>
                {connectionProblem && (
                  <Text style={s.body}>
                    Check your internet connection. Parse will try again while
                    this screen is open, or you can retry below.
                  </Text>
                )}
                <Button
                  title={
                    checkingConnection
                      ? "Checking connection…"
                      : "Retry connection"
                  }
                  disabled={busy || checkingConnection}
                  onPress={() => {
                    void retryConnection.current?.();
                  }}
                />
                <Button
                  title="Start a new pairing"
                  secondary
                  disabled={busy || checkingConnection}
                  onPress={() => {
                    void unpair();
                  }}
                />
              </View>
            ) : (
              <View style={s.card}>
                <Text style={s.heading}>Connect to Parse</Text>
                <Text style={s.body}>
                  Use the HTTPS address supplied by your care-space owner. Your
                  private pairing credential stays on this phone.
                </Text>
                <Text style={s.label}>Service address</Text>
                <TextInput
                  accessibilityLabel="Parse HTTPS service address"
                  style={s.input}
                  value={service}
                  onChangeText={setService}
                  placeholder="https://parse.example.org"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <Button
                  title={busy ? "Connecting…" : "Get pairing code"}
                  disabled={busy}
                  onPress={() => {
                    void connect();
                  }}
                />
              </View>
            )}
          </>
        ) : (
          <>
            <Text style={s.small}>
              HELLO, {home.patient.preferred_name || home.patient.name}
            </Text>
            <Text style={s.title}>How are you{"\n"}feeling today?</Text>
            <Text style={s.body}>
              Your microphone turns on only when you choose to speak. Parse
              checks the details with you before saving.
            </Text>
            {home.voice.voice_service !== "configured" && (
              <View style={s.notice}>
                <Text style={s.body}>
                  {home.voice.voice_service === "simulated"
                    ? "Test speech is enabled on this server. These responses are simulated."
                    : "Speech services are not ready on this server. Your care details are still available below."}
                </Text>
              </View>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                isRecording
                  ? tapMode
                    ? "Recording. Tap to send."
                    : "Recording. Release to send."
                  : tapMode
                    ? "Tap to start recording"
                    : "Hold to talk"
              }
              accessibilityState={{
                disabled: !canTalk,
                busy: voice.phase === "preparing",
              }}
              accessibilityHint={
                tapMode
                  ? "Activate once to start. Activate again to send, or choose Cancel recording."
                  : "Hold while speaking, then release to send. You can enable tap mode below."
              }
              disabled={!canTalk}
              onPressIn={() => {
                if (!tapMode) void startTalking();
              }}
              onPressOut={() => {
                if (!tapMode) void voice.finish().catch(showError);
              }}
              onPress={() => {
                if (tapMode) {
                  if (isRecording) void voice.finish().catch(showError);
                  else void startTalking();
                }
              }}
              style={[
                s.talk,
                isRecording && s.recording,
                !canTalk && s.disabled,
              ]}
            >
              <Text accessible={false} style={s.talkIcon}>
                {isRecording ? "●" : "◉"}
              </Text>
              <Text style={s.talkText}>
                {voice.phase === "preparing"
                  ? "Getting ready…"
                  : isRecording
                    ? tapMode
                      ? "Tap to finish"
                      : "Release to finish"
                    : tapMode
                      ? "Tap to talk"
                      : "Hold to talk"}
              </Text>
            </Pressable>
            <Text
              testID="voice-feedback"
              accessibilityLiveRegion="polite"
              style={s.voiceMessage}
            >
              {busy && voice.phase !== "speaking"
                ? busyMessage
                : tapMode && voice.phase === "recording"
                  ? "Listening. Tap to send, or choose Cancel recording."
                  : voice.message}
            </Text>
            <View style={s.setting}>
              <Text style={[s.body, s.settingLabel]}>
                Tap to start and stop
              </Text>
              <Switch
                accessibilityLabel="Use tap instead of hold to record"
                value={tapMode}
                onValueChange={(enabled) => {
                  if (!isRecording) void interaction.choose(enabled);
                }}
                disabled={
                  isRecording || !interaction.ready || interaction.screenReader
                }
                style={s.switch}
              />
            </View>
            {interaction.screenReader && (
              <Text style={s.caption}>
                Tap mode is enabled while your screen reader is on.
              </Text>
            )}
            {!!interaction.message && (
              <Text accessibilityLiveRegion="polite" style={s.caption}>
                {interaction.message}
              </Text>
            )}
            {!["idle", "error"].includes(voice.phase) && (
              <Button
                title={
                  voice.phase === "cleanup_required"
                    ? "Retry stop"
                    : isRecording
                      ? "Cancel recording"
                      : "Stop"
                }
                secondary
                onPress={() => {
                  void stopSpeakerTest();
                }}
              />
            )}
            {voice.phase === "error" && recoveryDetails === "pending" && (
              <>
                <Button
                  title="Recover response"
                  disabled={busy}
                  onPress={() => {
                    void voice.recover().catch(showError);
                  }}
                />
                <Button
                  title="Discard unfinished recording"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void voice.discard().catch(showError);
                  }}
                />
              </>
            )}
            {voice.phase === "error" && recoveryDetails === "unreadable" && (
              <View style={s.notice}>
                <Text style={s.body}>
                  Saved recovery details could not be read. Check them again, or
                  discard those details. Discarding does not undo care already
                  saved.
                </Text>
                <Button
                  title="Check recovery details"
                  disabled={busy}
                  onPress={() => setRecoveryCheck((value) => value + 1)}
                />
                <Button
                  title="Discard unreadable recovery data"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void voice.discard().catch(showError);
                  }}
                />
              </View>
            )}
            {voice.lastReply && (
              <Button
                title="Repeat spoken reply"
                disabled={!["idle", "error"].includes(voice.phase)}
                secondary
                onPress={() => {
                  void voice.repeat();
                }}
              />
            )}
            {home.current_proposal && (
              <View style={s.card}>
                <Text style={s.small}>REVIEW BEFORE SAVING</Text>
                <Text style={s.heading}>Have I got that right?</Text>
                <Text style={s.body}>{home.current_proposal.readback}</Text>
                <Button
                  title="Hear this read-back"
                  secondary
                  disabled={busy || isRecording}
                  onPress={() => {
                    void hearReadback();
                  }}
                />
                <Text style={s.caption}>
                  This is not saved yet. To change a detail, use the talk button
                  and say the correction.
                </Text>
                <Button
                  title="Confirm and save"
                  disabled={busy || isRecording}
                  onPress={() => {
                    void confirm();
                  }}
                />
                <Button
                  title="Cancel this update"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void cancel();
                  }}
                />
              </View>
            )}
            <View style={s.tabs}>
              {["Today", "Medicines", "Care", "Settings"].map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: section === item }}
                  onPress={() => setSection(item)}
                  style={[s.tab, section === item && s.selectedTab]}
                >
                  <Text style={s.tabText}>{item}</Text>
                </Pressable>
              ))}
            </View>
            {section === "Today" && (
              <>
                <Text style={s.heading}>Recent care</Text>
                {home.notes.length ? (
                  home.notes.map((note) => (
                    <View key={note.id} style={s.entry}>
                      <Text style={s.caption}>
                        {new Date(value(note, "created_at")).toLocaleString()}
                      </Text>
                      <Text style={s.body}>{value(note, "wording")}</Text>
                      {value(note, "occurrence_text") ? (
                        <Text style={s.caption}>
                          Reported time: {value(note, "occurrence_text")}
                        </Text>
                      ) : null}
                      <CareOrigin row={note} />
                    </View>
                  ))
                ) : (
                  <Text style={s.body}>
                    Your confirmed notes will appear here.
                  </Text>
                )}
                {home.measurements.map((row) => (
                  <View key={row.id} style={s.entry}>
                    <Text style={s.heading}>
                      {String(row.systolic)}/{String(row.diastolic)}{" "}
                      {value(row, "unit")}
                    </Text>
                    <Text style={s.body}>
                      {value(row, "source_description")}
                    </Text>
                    <Text style={s.caption}>
                      Reported time:{" "}
                      {value(row, "occurrence_text") ||
                        value(row, "occurred_at") ||
                        "Not recorded"}
                    </Text>
                    <Text style={s.caption}>
                      Reporter:{" "}
                      {value(row, "reporting_actor") || "Not recorded"}
                    </Text>
                    <CareOrigin row={row} />
                  </View>
                ))}
              </>
            )}
            {section === "Medicines" && (
              <>
                <Text style={s.heading}>Your checked plan</Text>
                {home.medication_plan?.medicines.map((medicine) => (
                  <View key={medicine.id} style={s.card}>
                    <Text style={s.heading}>{value(medicine, "name")}</Text>
                    <Text style={s.body}>
                      {value(medicine, "instructions")}
                    </Text>
                    <Text style={s.body}>
                      {value(medicine, "reviewed_reference")}
                    </Text>
                    <Text style={s.caption}>
                      Source: {value(medicine, "reference_source")}
                    </Text>
                  </View>
                ))}
                <Text style={s.body}>
                  Use the talk button to ask about a medicine or report a
                  particular scheduled dose. Parse will read back the report
                  before saving it.
                </Text>
                {home.doses.map((dose) => (
                  <View key={dose.id} style={s.entry}>
                    <Text style={s.heading}>
                      {value(dose, "medicine_name")}
                    </Text>
                    <Text style={s.body}>
                      {new Date(value(dose, "scheduled_at")).toLocaleString()}
                    </Text>
                    <Text style={s.caption}>
                      {value(dose, "report_state").replaceAll("_", " ")}
                    </Text>
                    {dose.report_time ? (
                      <>
                        <CareOrigin row={dose} />
                        <CareHistory row={dose} />
                      </>
                    ) : null}
                  </View>
                ))}
              </>
            )}
            {section === "Care" && (
              <>
                <Text style={s.heading}>Care and follow-ups</Text>
                {home.preventive_tasks.map((task) => (
                  <View key={task.id} style={s.entry}>
                    <Text style={s.body}>{value(task, "description")}</Text>
                    <Text style={s.caption}>
                      {value(task, "state")} · Due {value(task, "due_date")}
                    </Text>
                    {task.appointment_date ? (
                      <Text style={s.caption}>
                        Appointment: {value(task, "appointment_date")}
                      </Text>
                    ) : null}
                    {task.completion_date ? (
                      <Text style={s.caption}>
                        Completed: {value(task, "completion_date")}
                      </Text>
                    ) : null}
                    <Text style={s.caption}>
                      Care-plan source:{" "}
                      {value(task, "source") || "Not recorded"}
                    </Text>
                    <CareOrigin row={task} />
                    <CareHistory row={task} />
                  </View>
                ))}
                {home.support_requests.map((request) => (
                  <View key={request.id} style={s.entry}>
                    <Text style={s.body}>{value(request, "request_text")}</Text>
                    <Text style={s.caption}>
                      {value(request, "status")}
                      {request.outcome ? " · " + value(request, "outcome") : ""}
                    </Text>
                    {request.barrier_text ? (
                      <Text style={s.body}>
                        Reported barrier: {value(request, "barrier_text")}
                      </Text>
                    ) : null}
                    {request.calling_route ? (
                      <Text style={s.body}>
                        Calling route: {value(request, "calling_route")}. Parse
                        does not dispatch help.
                      </Text>
                    ) : null}
                    <CareOrigin row={request} prefix="Request recorded" />
                  </View>
                ))}
                {home.followups.map((followup) => (
                  <View key={followup.id} style={s.entry}>
                    <Text style={s.body}>
                      {new Date(value(followup, "check_at")).toLocaleString()}
                    </Text>
                    <Text style={s.caption}>
                      {value(followup, "resolution_state")} ·{" "}
                      {value(followup, "reported_outcome")}
                    </Text>
                    <CareOrigin row={followup} prefix="Follow-up created" />
                    <CareHistory row={followup} />
                  </View>
                ))}
                <Text style={s.body}>
                  Speak to request support, report a reading from your blood
                  pressure monitor, or update an appointment.
                </Text>
                <Button
                  title="Review visit summaries in dashboard"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void openExternal();
                  }}
                />
              </>
            )}
            {section === "Settings" && (
              <View style={s.card}>
                <Text style={s.heading}>This phone</Text>
                <Text style={s.body}>{installation?.service}</Text>
                <Text style={s.body}>
                  Test the sound before speaking. Use your phone's media volume
                  buttons; sound may play through connected headphones.
                </Text>
                <Button
                  title="Test speaker"
                  secondary
                  disabled={
                    busy ||
                    !["idle", "error"].includes(voice.phase) ||
                    !["configured", "simulated"].includes(
                      home.voice.voice_service,
                    )
                  }
                  onPress={() => {
                    void testSpeaker();
                  }}
                />
                {testingSpeaker && (
                  <Button
                    title="Stop speaker test"
                    secondary
                    onPress={() => {
                      void stopSpeakerTest();
                    }}
                  />
                )}
                {!!speakerMessage && (
                  <Text accessibilityLiveRegion="polite" style={s.body}>
                    {speakerMessage}
                  </Text>
                )}
                {voice.phase === "error" &&
                  voice.lastReply?.payload.status === "speaker_check" && (
                    <Text accessibilityLiveRegion="polite" style={s.body}>
                      {voice.message}
                    </Text>
                  )}
                {!["configured", "simulated"].includes(
                  home.voice.voice_service,
                ) && (
                  <Text style={s.caption}>
                    The speaker test needs the speech service to be configured.
                  </Text>
                )}
                <Text style={s.caption}>
                  Paired to {home.patient.name}. A paired phone is not a measure
                  of wellbeing.
                </Text>
                <Text style={s.body}>
                  {home.active_companion.device_id === home.device_id
                    ? "This phone is selected for reminders. Pause it here before choosing another companion in the dashboard."
                    : "This phone is not selected for reminders. The care-space owner can change the selection in the dashboard."}
                </Text>
                <Button
                  title="Pause reminders"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void pauseReminders();
                  }}
                />
                <Text style={s.body}>{reminders.status}</Text>
                <Text style={s.caption}>{reminders.pushStatus}</Text>
                <Text style={s.body}>
                  Alerts contain only a generic prompt to open Parse. Enable
                  notifications to receive them while the app is closed.
                </Text>
                <Button
                  title="Enable alerts"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void reminders.enable();
                  }}
                />
                <Text style={s.caption}>
                  Reminder playback never means medication was taken.
                </Text>
                <Button
                  title="Open phone permission settings"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void openExternal(true);
                  }}
                />
                <Button
                  title="Open care dashboard"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void openExternal();
                  }}
                />
                <Button
                  title="Unpair this phone"
                  secondary
                  disabled={busy}
                  onPress={() =>
                    Alert.alert(
                      "Unpair this phone?",
                      "Its access will be revoked. Your saved care records stay in Parse.",
                      [
                        { text: "Keep paired", style: "cancel" },
                        {
                          text: "Unpair",
                          style: "destructive",
                          onPress: () => {
                            void unpair();
                          },
                        },
                      ],
                    )
                  }
                />
              </View>
            )}
          </>
        )}
        {!!error && (
          <View accessibilityRole="alert" style={s.notice}>
            <Text style={s.body}>{error}</Text>
          </View>
        )}
        <Text style={s.footer}>Small moments. A clearer picture of care.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <Companion />
    </SafeAreaProvider>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F7F3EA" },
  page: { padding: 24, paddingBottom: 50, gap: 18 },
  brandRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 18,
  },
  brand: {
    fontSize: 36,
    fontWeight: "700",
    color: "#A24F3D",
    letterSpacing: -2,
  },
  small: {
    fontSize: 12,
    letterSpacing: 1.6,
    color: "#78695E",
    fontWeight: "700",
    flexShrink: 1,
  },
  title: {
    fontSize: 39,
    lineHeight: 46,
    color: "#322C27",
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  body: { fontSize: 18, lineHeight: 28, color: "#50473E" },
  heading: {
    fontSize: 23,
    lineHeight: 30,
    color: "#322C27",
    fontWeight: "600",
  },
  caption: { fontSize: 18, lineHeight: 26, color: "#756C60" },
  label: { fontSize: 18, color: "#322C27" },
  card: {
    backgroundColor: "#FFFDFA",
    borderRadius: 18,
    padding: 22,
    gap: 16,
    borderWidth: 1,
    borderColor: "#E3DBCF",
  },
  input: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: "#B9AA99",
    borderRadius: 9,
    padding: 14,
    fontSize: 18,
    color: "#322C27",
    backgroundColor: "#FFF",
  },
  button: {
    minHeight: 54,
    backgroundColor: "#A24F3D",
    padding: 15,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 18, fontWeight: "600", color: "#FFF" },
  secondary: { backgroundColor: "#ECE4D8" },
  secondaryText: { color: "#564237" },
  disabled: { opacity: 0.5 },
  code: {
    fontSize: 30,
    letterSpacing: 2,
    fontWeight: "700",
    color: "#A24F3D",
    textAlign: "center",
  },
  notice: { backgroundColor: "#F0E5D2", padding: 18, borderRadius: 12 },
  talk: {
    minHeight: 206,
    padding: 24,
    width: "100%",
    borderRadius: 28,
    backgroundColor: "#A24F3D",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    marginTop: 8,
  },
  recording: { backgroundColor: "#733327" },
  talkIcon: { fontSize: 44, color: "#FFF" },
  talkText: {
    fontSize: 26,
    fontWeight: "600",
    color: "#FFF",
    textAlign: "center",
    flexShrink: 1,
  },
  voiceMessage: {
    fontSize: 18,
    lineHeight: 27,
    textAlign: "center",
    color: "#50473E",
  },
  setting: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  settingLabel: { flexShrink: 1 },
  switch: { minWidth: 48, minHeight: 48 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 20 },
  tab: {
    minHeight: 48,
    minWidth: 48,
    paddingVertical: 12,
    paddingHorizontal: 15,
    justifyContent: "center",
    borderRadius: 30,
    borderWidth: 1,
    borderColor: "#D6CCBD",
  },
  selectedTab: { backgroundColor: "#E8DDCE" },
  tabText: { fontSize: 18, color: "#514438" },
  entry: {
    borderLeftWidth: 2,
    borderLeftColor: "#D0B5A1",
    paddingLeft: 20,
    paddingVertical: 9,
    gap: 8,
  },
  footer: {
    fontSize: 14,
    color: "#85796B",
    marginTop: 22,
    textAlign: "center",
  },
});
