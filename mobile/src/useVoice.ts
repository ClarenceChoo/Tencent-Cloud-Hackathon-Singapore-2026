import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  AudioModule,
  createAudioPlayer,
  RecordingPresets,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
} from "expo-audio";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { File, Paths } from "expo-file-system";
import { ApiError, PhoneApi } from "./api";
import {
  loadPending,
  removeAudio,
  savePending,
  retainPending,
  clearPending,
  sweepAudio,
} from "./storage";
import { Operations } from "./operations";
import { wavDuration } from "./validation";
import { resolveAcceptedTurn, RecoveryInterrupted } from "./turnRecovery";
import type { Home, PendingTurn, TurnEvent, Reminder } from "./contracts";

type Phase =
  | "idle"
  | "preparing"
  | "preparing_reply"
  | "recording"
  | "sending"
  | "waiting"
  | "speaking"
  | "error"
  | "cleanup_required";
export function useVoice(
  api: PhoneApi | null,
  context: string | null,
  onComplete: () => Promise<Home | null>,
  recoveryEnabled = false,
) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState(
    "Hold the talk button, speak, then release.",
  );
  const [lastReply, setLastReply] = useState<TurnEvent | null>(null);
  const operations = useRef(new Operations());
  const refreshRef = useRef(onComplete);
  refreshRef.current = onComplete;
  const recoveryAllowed = useRef(recoveryEnabled);
  recoveryAllowed.current = recoveryEnabled;
  const recoveryClaim = useRef(false);
  const recoverRef = useRef<(automatic?: boolean) => Promise<void>>(
    async () => {},
  );
  const retryAt = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;
  const phaseRef = useRef<Phase>("idle");
  const cancelled = useRef(false);
  const capturedContext = useRef<string | null>(null);
  const intent = useRef(false);
  const active = useRef(AppState.currentState === "active");
  const job = useRef<AbortController | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interrupted = useRef<() => void>(() => {});
  const finishRef = useRef<(cancel?: boolean) => Promise<void>>(async () => {});
  const recorder = useAudioRecorder(
    {
      ...RecordingPresets.HIGH_QUALITY,
      numberOfChannels: 1,
      sampleRate: 16000,
      bitRate: 64000,
      directory: "cache",
    },
    (status) => {
      if (
        (status.hasError ||
          status.mediaServicesDidReset ||
          status.isFinished) &&
        phaseRef.current === "recording"
      )
        interrupted.current();
    },
  );
  function move(value: Phase) {
    phaseRef.current = value;
    setPhase(value);
  }
  const fail = (error: unknown) => {
    move("error");
    setMessage(
      error instanceof Error
        ? error.message
        : "The connection was interrupted. Check the current care details before trying again.",
    );
  };

  async function play(
    event: TurnEvent,
    controller: AbortController,
    authorize?: () => Promise<void>,
    validate?: () => Promise<unknown>,
  ) {
    const check = () => {
      if (
        !api ||
        api !== apiRef.current ||
        operations.current.closed ||
        controller.signal.aborted ||
        !active.current
      )
        throw new Error(
          "Speech interrupted. Tap Repeat to hear a current reply.",
        );
      const expiry = Date.parse(event.expires_at);
      if (!Number.isFinite(expiry) || expiry <= Date.now())
        throw new Error(
          "This spoken reply has expired. Check the current care details.",
        );
    };
    check();
    const paths = event.payload.audio_paths;
    if (!paths?.length || paths.length > 20)
      throw new Error(
        "The spoken reply must contain between one and twenty parts.",
      );
    let seconds = 0,
      authorised = false;
    move("preparing_reply");
    await setIsAudioActiveAsync(true);
    check();
    await setAudioModeAsync({
      allowsRecording: false,
      shouldPlayInBackground: false,
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
    });
    check();
    for (const path of paths) {
      if (validate) await validate();
      check();
      const bytes = await api!.audio(path, controller.signal);
      check();
      const duration = wavDuration(bytes);
      seconds += duration;
      if (seconds > 120)
        throw new Error("The spoken reply exceeds two minutes.");
      const file = new File(
        Paths.cache,
        "parse-reply-" + Crypto.randomUUID() + ".wav",
      );
      let player: ReturnType<typeof createAudioPlayer> | undefined;
      let cleanPlayback = () => {};
      let pendingStart: Promise<void> | null = null;
      try {
        file.write(bytes);
        player = createAudioPlayer(file.uri, { updateInterval: 100 });
        const nativePlayer = player;
        await new Promise<void>((resolve, reject) => {
          let starting = false,
            started = false,
            hasPlayed = false,
            disposed = false,
            checking = false;
          const stop = () =>
            reject(
              new Error("Speech interrupted. Tap Repeat when you are ready."),
            );
          const timeout = setTimeout(
            () => reject(new Error("Speech playback did not complete.")),
            (duration + 8) * 1000,
          );
          const current = async () => {
            await api!.validateAudio(path, controller.signal);
            if (validate) await validate();
            check();
          };
          const launch = () => {
            if (starting || disposed) return;
            starting = true;
            pendingStart = (async () => {
              try {
                // Native loading may take time. Revalidate the downloaded clip at
                // readiness, then obtain any reminder start authorization.
                await current();
                if (disposed) return;
                if (!authorised && authorize) {
                  await authorize();
                  authorised = true;
                }
                check();
                if (disposed) return;
                started = true;
                move("speaking");
                nativePlayer.play();
              } catch (error) {
                if (!disposed) reject(error);
              }
            })();
          };
          const subscription = nativePlayer.addListener(
            "playbackStatusUpdate",
            (status) => {
              if (disposed) return;
              if (status.error || status.mediaServicesDidReset) {
                reject(new Error("Speech playback was interrupted."));
                return;
              }
              if (status.didJustFinish && started) {
                resolve();
                return;
              }
              if (status.playing) hasPlayed = true;
              if (
                hasPlayed &&
                status.isLoaded &&
                !status.playing &&
                !status.isBuffering
              ) {
                reject(new Error("Speech playback was interrupted."));
                return;
              }
              if (status.isLoaded) void launch();
            },
          );
          // Revalidate during playback as well. A failed check stops audio;
          // polling is not a guarantee of instantaneous remote cancellation.
          const monitor = setInterval(() => {
            if (!started || checking || disposed) return;
            checking = true;
            void current()
              .catch((error) => {
                if (!disposed) reject(error);
              })
              .finally(() => {
                checking = false;
              });
          }, 1000);
          cleanPlayback = () => {
            disposed = true;
            clearTimeout(timeout);
            clearInterval(monitor);
            subscription.remove();
            controller.signal.removeEventListener("abort", stop);
          };
          controller.signal.addEventListener("abort", stop, { once: true });
          if (controller.signal.aborted) stop();
          else if (nativePlayer.isLoaded) void launch();
        });
        check();
      } finally {
        try {
          try {
            cleanPlayback();
          } finally {
            try {
              player?.pause();
            } finally {
              try {
                player?.release();
              } finally {
                removeAudio(file.uri);
              }
            }
          }
        } finally {
          // Stop sound immediately, but drain any admitted ledger/start ACK
          // before a handoff or unpair can attest cleanup and clear storage.
          await pendingStart;
        }
      }
    }
    move("idle");
  }

  async function reconcile(
    pending: PendingTurn,
    controller: AbortController,
    playReply = true,
  ) {
    if (!api) return;
    const result = await resolveAcceptedTurn(
      pending,
      {
        receipt: (key, signal) => api.receipt(key, signal),
        turn: (id, signal) => api.turn(id, signal),
        retain: retainPending,
        clear: clearPending,
        refresh: () => refreshRef.current(),
        current: () =>
          api === apiRef.current &&
          active.current &&
          !operations.current.closed,
        received: () => {
          move("waiting");
          setMessage(
            "Your recording was received. Parse is preparing a response.",
          );
        },
      },
      controller.signal,
    );
    if (
      controller.signal.aborted ||
      !active.current ||
      operations.current.closed ||
      api !== apiRef.current
    )
      throw new RecoveryInterrupted();
    if (result.kind === "receipt_unknown") {
      retryAt.current = Date.now() + 15000;
      throw new Error(
        "The recording's receipt is still unknown. Parse will check again while open. You can also Recover response or discard it; no new recording has been sent.",
      );
    }
    if (result.kind === "processing") {
      retryAt.current = Date.now() + 15000;
      throw new Error(
        "Parse is still processing this recording. It will check again while open; nothing new has been confirmed.",
      );
    }
    if (result.kind === "failed") throw new Error(result.message);
    setLastReply(result.playable ? result.event : null);
    if (result.stale) {
      move("idle");
      setMessage(
        "That read-back changed. Review the current details before confirming.",
      );
      return;
    }
    const text =
      result.event.payload.spoken_text ||
      "Response received. Review the current care details.";
    setMessage(
      !result.playable
        ? text + " The audio has expired; check the current details."
        : playReply
          ? text
          : text + " Response recovered. Tap Repeat spoken reply to hear it.",
    );
    if (result.playable && playReply) await play(result.event, controller);
    else move("idle");
  }

  async function recover(automatic = false) {
    if (
      !api ||
      api !== apiRef.current ||
      operations.current.closed ||
      !active.current ||
      recoveryClaim.current ||
      !["idle", "error"].includes(phaseRef.current) ||
      (automatic && (!recoveryAllowed.current || Date.now() < retryAt.current))
    )
      return;
    // Claim before SecureStore/HTTP awaits so a talk press or another resume cannot
    // admit a second operation while recovery is loading its identifiers.
    recoveryClaim.current = true;
    const controller = new AbortController();
    job.current = controller;
    try {
      const pending = await loadPending();
      if (
        !pending ||
        controller.signal.aborted ||
        operations.current.closed ||
        !active.current
      )
        return;
      move("waiting");
      setMessage(
        "Checking the unfinished recording. Nothing is being recorded.",
      );
      await reconcile(pending, controller, !automatic);
    } catch (error) {
      retryAt.current = Date.now() + 15000;
      if (api === apiRef.current)
        fail(controller.signal.aborted ? new RecoveryInterrupted() : error);
    } finally {
      recoveryClaim.current = false;
      if (job.current === controller) job.current = null;
    }
  }
  recoverRef.current = (automatic) =>
    operations.current.run(() => recover(automatic)).then(() => {});
  useEffect(() => {
    if (!api || !recoveryEnabled) return;
    const recoverNow = () => {
      void recoverRef.current(true).catch(fail);
    };
    const timer = setInterval(recoverNow, 5000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        retryAt.current = 0;
        recoverNow();
      }
    });
    recoverNow();
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [api, recoveryEnabled]);

  async function begin() {
    if (
      !api ||
      api !== apiRef.current ||
      operations.current.closed ||
      recoveryClaim.current ||
      !active.current ||
      !["idle", "error"].includes(phaseRef.current)
    )
      return;
    cancelled.current = false;
    capturedContext.current = context;
    intent.current = true;
    move("preparing");
    const stillWanted = () =>
      intent.current &&
      active.current &&
      api === apiRef.current &&
      !operations.current.closed;
    try {
      if (await loadPending()) {
        move("idle");
        intent.current = false;
        await recover();
        return;
      }
      if (!stillWanted()) {
        move("idle");
        return;
      }
      setMessage("Parse uses the microphone only for this recording.");
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted)
        throw new Error(
          "Microphone access is off. Enable it in your phone settings to speak to Parse.",
        );
      if (!stillWanted()) {
        move("idle");
        return;
      }
      await setIsAudioActiveAsync(true);
      await setAudioModeAsync({
        allowsRecording: true,
        shouldPlayInBackground: false,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
      });
      if (!stillWanted()) {
        await setAudioModeAsync({ allowsRecording: false });
        move("idle");
        return;
      }
      await recorder.prepareToRecordAsync();
      if (!stillWanted()) {
        await recorder.stop();
        removeAudio(recorder.uri);
        await setAudioModeAsync({ allowsRecording: false });
        move("idle");
        return;
      }
      recorder.record({ forDuration: 19.5 });
      move("recording");
      setMessage("Listening. Release to send, or choose Cancel.");
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
        () => {},
      );
      limit.current = setTimeout(() => {
        void finishRef.current(false);
      }, 19000);
    } catch (error) {
      intent.current = false;
      await recorder.stop().catch(() => {});
      await setIsAudioActiveAsync(false).catch(() => {});
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      removeAudio(recorder.uri);
      fail(error);
    }
  }

  async function finish(cancel = false) {
    intent.current = false;
    if (cancel) cancelled.current = true;
    if (limit.current) {
      clearTimeout(limit.current);
      limit.current = null;
    }
    if (phaseRef.current === "preparing") return;
    if (phaseRef.current !== "recording") {
      if (cancel) job.current?.abort();
      return;
    }
    move("sending");
    let duration = 0;
    try {
      duration = recorder.getStatus().durationMillis;
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
    } catch (error) {
      await setIsAudioActiveAsync(false).catch(() => {});
      removeAudio(recorder.uri);
      fail(error);
      return;
    }
    const uri = recorder.uri;
    if (
      cancel ||
      cancelled.current ||
      !active.current ||
      api !== apiRef.current ||
      operations.current.closed
    ) {
      removeAudio(uri);
      move("idle");
      setMessage("Recording cancelled.");
      return;
    }
    if (!uri || !Number.isFinite(duration) || duration < 300) {
      removeAudio(uri);
      fail(new Error("Please speak for at least a moment before releasing."));
      return;
    }
    const controller = new AbortController();
    job.current = controller;
    const pending: PendingTurn = {
      key: Crypto.randomUUID(),
      context: capturedContext.current,
      createdAt: Date.now(),
    };
    let accepted = false;
    const expiry = setTimeout(() => {
      controller.abort();
      removeAudio(uri);
    }, 60000);
    try {
      await savePending(pending);
      setMessage("Sending your recording. Nothing has been confirmed yet.");
      const receipt = await api!.upload(
        uri,
        pending.key,
        pending.context,
        controller.signal,
      );
      removeAudio(uri);
      clearTimeout(expiry);
      accepted = true;
      if (!(await retainPending({ ...pending, turnId: receipt.turn_id })))
        throw new RecoveryInterrupted();
      await reconcile({ ...pending, turnId: receipt.turn_id }, controller);
    } catch (error) {
      removeAudio(uri);
      if (
        !accepted &&
        error instanceof ApiError &&
        [400, 401, 403, 409, 413, 422, 503].includes(error.status)
      )
        await clearPending(pending.key);
      retryAt.current = Date.now() + 15000;
      fail(error);
    } finally {
      clearTimeout(expiry);
      removeAudio(uri);
    }
  }
  finishRef.current = async (cancel) => {
    await operations.current.run(() => finish(cancel));
  };
  interrupted.current = () => {
    void operations.current.run(() => finish(true)).catch(fail);
  };
  useEffect(() => {
    active.current = AppState.currentState === "active";
    sweepAudio();
    const change = AppState.addEventListener("change", (state) => {
      active.current = state === "active";
      if (!active.current) {
        intent.current = false;
        job.current?.abort();
        void finishRef.current(true).catch(fail);
      }
    });
    const blur = AppState.addEventListener("blur", () => {
      active.current = false;
      intent.current = false;
      job.current?.abort();
      void finishRef.current(true).catch(fail);
    });
    const focus = AppState.addEventListener("focus", () => {
      active.current = AppState.currentState === "active";
      retryAt.current = 0;
      void recoverRef.current(true).catch(fail);
    });
    return () => {
      active.current = false;
      change.remove();
      blur.remove();
      focus.remove();
      intent.current = false;
      job.current?.abort();
      void finishRef.current(true).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (phase !== "recording") return;
    let live = true,
      checking = false,
      permissionCheckedAt = 0;
    const timer = setInterval(() => {
      if (!live || phaseRef.current !== "recording") return;
      try {
        const status = recorder.getStatus();
        if (!status.isRecording || status.mediaServicesDidReset) {
          interrupted.current();
          return;
        }
      } catch {
        interrupted.current();
        return;
      }
      if (!checking && Date.now() - permissionCheckedAt >= 1000) {
        checking = true;
        permissionCheckedAt = Date.now();
        void AudioModule.getRecordingPermissionsAsync()
          .then((permission) => {
            if (live && phaseRef.current === "recording" && !permission.granted)
              interrupted.current();
          })
          .catch(() => {
            if (live) interrupted.current();
          })
          .finally(() => {
            checking = false;
          });
      }
    }, 200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [phase, recorder]);

  async function repeat() {
    if (
      operations.current.closed ||
      recoveryClaim.current ||
      !lastReply ||
      !active.current ||
      !["idle", "error"].includes(phaseRef.current)
    )
      return;
    const controller = new AbortController();
    job.current = controller;
    move("speaking");
    try {
      await play(lastReply, controller);
    } catch (error) {
      fail(error);
    }
  }
  const stop = (after?: () => Promise<void>) =>
    operations.current
      .stop(
        async () => {
          intent.current = false;
          cancelled.current = true;
          job.current?.abort();
          await setIsAudioActiveAsync(false);
          await finish(true);
        },
        async () => {
          // A permission/prepare call may have been resolving during interruption.
          // Disable audio again only after every admitted operation has settled.
          await setIsAudioActiveAsync(false);
          await setAudioModeAsync({ allowsRecording: false });
          if (recorder.getStatus().isRecording)
            throw new Error(
              "Recording has not stopped. Keep this phone selected and try again.",
            );
          sweepAudio();
          await after?.();
          move("idle");
          setMessage("Stopped. You can speak when you are ready.");
        },
      )
      .catch((error) => {
        move("cleanup_required");
        setMessage(
          "Audio cleanup did not finish. Choose Retry stop before speaking again.",
        );
        throw error;
      });
  useEffect(
    () => () => {
      // Identity changes and unmounts cancel even if a permission/prepare await
      // is still pending. The stop barrier drains it before any new admission.
      void stop().catch(() => {});
    },
    [api],
  );
  return {
    phase,
    message,
    begin: () => operations.current.run(begin),
    finish: (cancel = false) => operations.current.run(() => finish(cancel)),
    recover: () => operations.current.run(recover),
    repeat: () => operations.current.run(repeat),
    lastReply,
    speak: (event: TurnEvent) =>
      operations.current.run(async () => {
        if (
          api !== apiRef.current ||
          recoveryClaim.current ||
          !active.current ||
          !["idle", "error"].includes(phaseRef.current)
        )
          return;
        move("speaking");
        const controller = new AbortController();
        job.current?.abort();
        job.current = controller;
        setLastReply(event);
        setMessage(event.payload.spoken_text || "");
        try {
          await play(event, controller);
        } catch (error) {
          fail(error);
        }
      }),
    reminder: (
      event: Reminder,
      prepare: () => Promise<void>,
      authorize: () => Promise<void>,
    ): Promise<"completed" | "busy"> => {
      if (
        !api ||
        api !== apiRef.current ||
        operations.current.closed ||
        recoveryClaim.current ||
        !active.current ||
        !["idle", "error"].includes(phaseRef.current)
      )
        return Promise.resolve("busy");
      move("preparing_reply");
      return operations.current
        .run(async () => {
          const controller = new AbortController();
          job.current = controller;
          let checking = false;
          const check = () => api.currentReminder(event.payload.command_id);
          const monitor = setInterval(() => {
            if (checking) return;
            checking = true;
            void check()
              .catch(() => controller.abort())
              .finally(() => {
                checking = false;
              });
          }, 1000);
          try {
            await prepare();
            setMessage(
              "A scheduled care reminder. Listening does not record a dose taken.",
            );
            await play(event, controller, authorize, check);
            if (controller.signal.aborted)
              throw new Error("The reminder was interrupted.");
            setLastReply(event);
            return "completed" as const;
          } catch (error) {
            fail(error);
            throw error;
          } finally {
            clearInterval(monitor);
          }
        })
        .then((result) => result || "busy");
    },
    discard: async () => {
      await stop(async () => {
        await savePending(null);
      });
      setLastReply(null);
      setMessage(
        "Recovery stopped. This does not undo a recording already received by Parse. Check current care details before recording it again.",
      );
    },
    stop,
  };
}
