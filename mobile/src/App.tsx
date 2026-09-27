import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
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
  newInstallation,
} from "./storage";
import * as Notifications from "expo-notifications";
import { useVoice } from "./useVoice";

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
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [tapMode, setTapMode] = useState(false);
  const [section, setSection] = useState("Today");
  const api = useMemo(
    () => (installation && !restored ? new PhoneApi(installation) : null),
    [installation, restored],
  );
  const showError = (err: unknown) =>
    setError(
      err instanceof Error
        ? err.message
        : "Parse could not connect. Please try again.",
    );
  const refresh = useCallback(async () => {
    if (api) {
      const next = await api.home();
      setHome(next);
    }
  }, [api]);
  const voice = useVoice(
    api,
    home?.current_proposal?.context_id || null,
    refresh,
  );
  useEffect(() => {
    void loadInstallation()
      .then((saved) => {
        setInstallation(saved.installation);
        setRestored(saved.restored);
        setService(saved.installation?.service || "");
      })
      .catch(showError)
      .finally(() => setBooting(false));
  }, []);
  useEffect(() => {
    if (!api) return;
    let running = false;
    let alive = true;
    async function sync() {
      if (running || AppState.currentState !== "active") return;
      running = true;
      try {
        let next: Enrollment;
        try {
          next = await api!.enrollment();
        } catch (err) {
          if (err instanceof ApiError && err.status === 401)
            next = await api!.enroll();
          else throw err;
        }
        if (!alive) return;
        setEnrollment(next);
        if (next.status === "paired") await refresh();
        setError("");
      } catch (err) {
        if (alive) {
          if (err instanceof ApiError && [401, 403].includes(err.status)) {
            await stopLocalReminders(async () => {
              await api!.quiesce();
            });
            setHome(null);
            setEnrollment(null);
          }
          showError(err);
        }
      } finally {
        running = false;
      }
    }
    void sync();
    const timer = setInterval(() => {
      void sync();
    }, 5000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      listener.remove();
    };
  }, [api, refresh]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      setInstallation(
        await newInstallation(
          service,
          Platform.OS === "ios" ? "ios" : "android",
        ),
      );
      setRestored(false);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }
  async function stopLocalReminders(after?: () => Promise<void>) {
    await voice.stop(async () => {
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
  async function pauseReminders() {
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      await stopLocalReminders(async () => {
        await api.quiesce();
      });
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }
  async function unpair() {
    setBusy(true);
    setError("");
    try {
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
      await clearInstallation();
      setInstallation(null);
      setEnrollment(null);
      setHome(null);
      setRestored(false);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    const proposal = home?.current_proposal;
    if (!proposal || !api) return;
    setBusy(true);
    setError("");
    try {
      await voice.stop();
      await api.confirm(proposal.id, proposal.context_id);
      await refresh();
      try {
        await voice.speak(await api.speech(proposal.id, proposal.context_id));
      } catch {
        setError("Saved. Spoken confirmation is currently unavailable.");
      }
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    const proposal = home?.current_proposal;
    if (!proposal || !api) return;
    setBusy(true);
    setError("");
    try {
      await voice.stop();
      await api.cancel(proposal.id, proposal.context_id);
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }
  const isRecording =
    voice.phase === "recording" || voice.phase === "preparing";
  const canTalk =
    !!home &&
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
        {booting ? (
          <ActivityIndicator accessibilityLabel="Loading your pairing" />
        ) : !home ? (
          <>
            <Text style={s.title}>A familiar voice.{"\n"}One care space.</Text>
            <Text style={s.body}>
              Speak about your day, hear a read-back, and choose what to save or
              share.
            </Text>
            {restored ? (
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
                  editable={!installation}
                />
                <Button
                  title={
                    busy
                      ? "Connecting…"
                      : installation
                        ? "Retry pairing"
                        : "Get pairing code"
                  }
                  disabled={busy}
                  onPress={() => {
                    if (installation && api)
                      void api.enroll().then(setEnrollment).catch(showError);
                    else void connect();
                  }}
                />
                {installation && (
                  <Button
                    title="Start a new pairing"
                    secondary
                    onPress={() => {
                      void unpair();
                    }}
                  />
                )}
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
                  ? "Recording. Release or tap to stop."
                  : tapMode
                    ? "Tap to start recording"
                    : "Hold to talk"
              }
              accessibilityState={{
                disabled: !canTalk,
                busy: voice.phase === "preparing",
              }}
              disabled={!canTalk}
              onPressIn={() => {
                if (!tapMode) void voice.begin();
              }}
              onPressOut={() => {
                if (!tapMode) void voice.finish().catch(showError);
              }}
              onPress={() => {
                if (tapMode) {
                  if (isRecording) void voice.finish().catch(showError);
                  else void voice.begin();
                }
              }}
              style={[
                s.talk,
                isRecording && s.recording,
                !canTalk && s.disabled,
              ]}
            >
              <Text style={s.talkIcon}>{isRecording ? "●" : "◉"}</Text>
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
            <Text accessibilityLiveRegion="polite" style={s.voiceMessage}>
              {voice.message}
            </Text>
            <View style={s.setting}>
              <Text style={s.body}>Tap to start and stop</Text>
              <Switch
                accessibilityLabel="Use tap instead of hold to record"
                value={tapMode}
                onValueChange={setTapMode}
                disabled={isRecording}
              />
            </View>
            {!["idle", "error"].includes(voice.phase) && (
              <Button
                title={isRecording ? "Cancel recording" : "Stop"}
                secondary
                onPress={() => {
                  void voice.stop().catch(showError);
                }}
              />
            )}
            {voice.phase === "error" && (
              <>
                <Button
                  title="Recover response"
                  onPress={() => {
                    void voice.recover().catch(showError);
                  }}
                />
                <Button
                  title="Discard unfinished recording"
                  secondary
                  onPress={() => {
                    void voice.discard().catch(showError);
                  }}
                />
              </>
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
                    void voice.stop().catch(showError);
                    void api!
                      .speech(
                        home.current_proposal!.id,
                        home.current_proposal!.context_id,
                      )
                      .then(voice.speak)
                      .catch(showError);
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
                      {value(task, "state")} · {value(task, "due_date")}
                    </Text>
                  </View>
                ))}
                {home.support_requests.map((request) => (
                  <View key={request.id} style={s.entry}>
                    <Text style={s.body}>{value(request, "request_text")}</Text>
                    <Text style={s.caption}>
                      {value(request, "status")}
                      {request.outcome ? " · " + value(request, "outcome") : ""}
                    </Text>
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
                  </View>
                ))}
                <Text style={s.body}>
                  Speak to request support, report a reading from your blood
                  pressure monitor, or update an appointment.
                </Text>
                <Button
                  title="Review visit summaries in dashboard"
                  secondary
                  onPress={() => {
                    void voice.stop().catch(showError);
                    void Linking.openURL(installation!.service);
                  }}
                />
              </>
            )}
            {section === "Settings" && (
              <View style={s.card}>
                <Text style={s.heading}>This phone</Text>
                <Text style={s.body}>{installation?.service}</Text>
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
                <Text style={s.body}>
                  Native reminder alerts are still being implemented. This
                  development build does not yet replace background reminders.
                </Text>
                <Button
                  title="Open phone permission settings"
                  secondary
                  onPress={() => {
                    void voice.stop().catch(showError);
                    void Linking.openSettings();
                  }}
                />
                <Button
                  title="Open care dashboard"
                  secondary
                  onPress={() => {
                    void voice.stop().catch(showError);
                    void Linking.openURL(installation!.service);
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
      <Companion />
    </SafeAreaProvider>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F7F3EA" },
  page: { padding: 24, paddingBottom: 50, gap: 18 },
  brandRow: {
    flexDirection: "row",
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
  caption: { fontSize: 16, lineHeight: 24, color: "#756C60" },
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
    height: 206,
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
  talkText: { fontSize: 26, fontWeight: "600", color: "#FFF" },
  voiceMessage: {
    fontSize: 18,
    lineHeight: 27,
    textAlign: "center",
    color: "#50473E",
  },
  setting: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 20 },
  tab: {
    minHeight: 48,
    paddingHorizontal: 15,
    justifyContent: "center",
    borderRadius: 30,
    borderWidth: 1,
    borderColor: "#D6CCBD",
  },
  selectedTab: { backgroundColor: "#E8DDCE" },
  tabText: { fontSize: 17, color: "#514438" },
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
