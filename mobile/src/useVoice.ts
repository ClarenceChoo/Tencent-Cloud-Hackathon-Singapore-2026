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
import { loadPending, removeAudio, savePending, sweepAudio } from "./storage";
import { wavDuration } from "./validation";
import type { PendingTurn, TurnEvent } from "./contracts";

type Phase =
  | "idle"
  | "preparing"
  | "recording"
  | "sending"
  | "waiting"
  | "speaking"
  | "error";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function useVoice(
  api: PhoneApi | null,
  context: string | null,
  onComplete: () => Promise<void>,
) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState(
    "Hold the talk button, speak, then release.",
  );
  const [lastReply, setLastReply] = useState<TurnEvent | null>(null);
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

  async function play(event: TurnEvent, controller: AbortController) {
    if (!api || !event.payload.audio_paths?.length) return;
    if (event.payload.audio_paths.length > 20)
      throw new Error("The spoken reply contains too many parts.");
    let seconds = 0;
    await setIsAudioActiveAsync(true);
    await setAudioModeAsync({
      allowsRecording: false,
      shouldPlayInBackground: false,
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
    });
    move("speaking");
    for (const path of event.payload.audio_paths) {
      if (controller.signal.aborted || !active.current)
        throw new Error(
          "Speech interrupted. Tap Repeat to hear a current reply.",
        );
      if (Date.parse(event.expires_at) <= Date.now())
        throw new Error(
          "This spoken reply has expired. Check the current care details.",
        );
      const bytes = await api.audio(path, controller.signal);
      const duration = wavDuration(bytes);
      seconds += duration;
      if (seconds > 120 || controller.signal.aborted)
        throw new Error("The spoken reply was stopped.");
      const file = new File(
        Paths.cache,
        "parse-reply-" + Crypto.randomUUID() + ".wav",
      );
      file.write(bytes);
      const player = createAudioPlayer(file.uri, { updateInterval: 100 });
      let cleanPlayback = () => {};
      try {
        await new Promise<void>((resolve, reject) => {
          let started = false;
          let hasPlayed = false;
          const stop = () =>
            reject(
              new Error("Speech interrupted. Tap Repeat when you are ready."),
            );
          const timeout = setTimeout(
            () => reject(new Error("Speech playback did not complete.")),
            (duration + 8) * 1000,
          );
          const subscription = player.addListener(
            "playbackStatusUpdate",
            (status) => {
              if (status.error || status.mediaServicesDidReset) {
                reject(new Error("Speech playback was interrupted."));
                return;
              }
              if (status.didJustFinish) {
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
              if (status.isLoaded && !started) {
                started = true;
                player.play();
              }
            },
          );
          controller.signal.addEventListener("abort", stop, { once: true });
          if (controller.signal.aborted) stop();
          const cleanup = () => {
            clearTimeout(timeout);
            subscription.remove();
            controller.signal.removeEventListener("abort", stop);
          };
          // Completion cleanup is owned by the surrounding promise's finalizer.
          cleanPlayback = cleanup;
          if (player.isLoaded) {
            started = true;
            player.play();
          }
        });
      } finally {
        cleanPlayback();
        player.pause();
        player.release();
        removeAudio(file.uri);
      }
    }
    move("idle");
  }

  async function reconcile(pending: PendingTurn, controller: AbortController) {
    if (!api) return;
    let turnId = pending.turnId;
    if (!turnId) {
      const receipt = await api.receipt(pending.key);
      turnId = receipt.turn_id;
      await savePending({ ...pending, turnId });
    }
    move("waiting");
    setMessage("Your recording was received. Parse is preparing a response.");
    for (
      let count = 0;
      count < 90 && active.current && !controller.signal.aborted;
      count++
    ) {
      const result = await api.turn(turnId, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === "failed") {
        await savePending(null);
        throw new Error(
          result.error ||
            "Speech could not be processed. No new confirmation was made.",
        );
      }
      if (result.event) {
        await savePending(null);
        setLastReply(result.event);
        setMessage(
          result.event.payload.spoken_text ||
            "Response received. Review the current care details.",
        );
        await onComplete();
        if (!controller.signal.aborted) await play(result.event, controller);
        return;
      }
      await wait(700);
    }
    move("error");
    setMessage(
      "The result is still unknown. Tap Recover response to check the same recording.",
    );
  }

  async function recover() {
    if (
      !api ||
      !active.current ||
      !["idle", "error"].includes(phaseRef.current)
    )
      return;
    const pending = await loadPending();
    if (!pending) return;
    const controller = new AbortController();
    job.current = controller;
    try {
      await reconcile(pending, controller);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        fail(
          new Error(
            "No receipt found yet. Recover again, or discard this unfinished recording before trying a new one.",
          ),
        );
      else fail(error);
    }
  }

  async function begin() {
    if (
      !api ||
      !active.current ||
      !["idle", "error"].includes(phaseRef.current)
    )
      return;
    cancelled.current = false;
    capturedContext.current = context;
    intent.current = true;
    move("preparing");
    try {
      if (await loadPending()) {
        move("idle");
        intent.current = false;
        await recover();
        return;
      }
      setMessage("Parse uses the microphone only for this recording.");
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted)
        throw new Error(
          "Microphone access is off. Enable it in your phone settings to speak to Parse.",
        );
      if (!intent.current || !active.current) {
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
      await recorder.prepareToRecordAsync();
      if (!intent.current || !active.current) {
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
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
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
    const duration = recorder.getStatus().durationMillis;
    try {
      await recorder.stop();
    } catch (error) {
      await setIsAudioActiveAsync(false);
      removeAudio(recorder.uri);
      fail(error);
      return;
    } finally {
      await setAudioModeAsync({ allowsRecording: false });
    }
    const uri = recorder.uri;
    if (cancel || cancelled.current || !active.current) {
      removeAudio(uri);
      move("idle");
      setMessage("Recording cancelled.");
      return;
    }
    if (!uri || duration < 300) {
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
      await savePending({ ...pending, turnId: receipt.turn_id });
      await reconcile({ ...pending, turnId: receipt.turn_id }, controller);
    } catch (error) {
      removeAudio(uri);
      if (
        error instanceof ApiError &&
        [400, 401, 403, 409, 413, 422, 503].includes(error.status)
      )
        await savePending(null);
      fail(error);
    } finally {
      clearTimeout(expiry);
      removeAudio(uri);
    }
  }
  finishRef.current = finish;
  interrupted.current = () => {
    void finish(true).catch(fail);
  };
  useEffect(() => {
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
      intent.current = false;
      job.current?.abort();
      void finishRef.current(true).catch(fail);
    });
    return () => {
      change.remove();
      blur.remove();
      intent.current = false;
      job.current?.abort();
      void finishRef.current(true).catch(() => {});
    };
  }, []);
  async function repeat() {
    if (
      !lastReply ||
      !active.current ||
      !["idle", "error"].includes(phaseRef.current)
    )
      return;
    const controller = new AbortController();
    job.current = controller;
    try {
      await play(lastReply, controller);
    } catch (error) {
      fail(error);
    }
  }
  return {
    phase,
    message,
    begin,
    finish,
    recover,
    repeat,
    lastReply,
    speak: async (event: TurnEvent) => {
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
    },
    discard: async () => {
      job.current?.abort();
      await savePending(null);
      move("idle");
      setMessage(
        "Unfinished recording discarded. Saved care records are unchanged.",
      );
    },
    stop: () => {
      job.current?.abort();
      void finish(true).catch(fail);
    },
  };
}
