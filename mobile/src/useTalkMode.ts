import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { loadTapMode, saveTapMode } from "./storage";

/** Screen-reader activation is a tap; never interpret its brief press as a hold. */
export function useTalkMode() {
  const [preferredTap, setPreferredTap] = useState(false);
  const [screenReader, setScreenReader] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  const revision = useRef(0);
  useEffect(() => {
    alive.current = true;
    let current = true;
    let readerChanged = false;
    const listener = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      (enabled) => {
        readerChanged = true;
        if (current) setScreenReader(enabled);
      },
    );
    void Promise.all([loadTapMode(), AccessibilityInfo.isScreenReaderEnabled()])
      .then(([saved, reader]) => {
        if (!current) return;
        setPreferredTap(saved ?? false);
        if (!readerChanged) setScreenReader(reader);
      })
      .catch(() => {
        if (current) {
          setPreferredTap(true);
          setMessage(
            "Using tap to start and stop. Your saved interaction setting could not be checked.",
          );
        }
      })
      .finally(() => {
        if (current) setReady(true);
      });
    return () => {
      current = false;
      alive.current = false;
      listener.remove();
    };
  }, []);
  async function choose(tap: boolean) {
    if (!ready || screenReader) return;
    const version = ++revision.current;
    setPreferredTap(tap);
    setMessage("");
    try {
      await saveTapMode(tap);
    } catch {
      if (alive.current && version === revision.current)
        setMessage(
          "This choice works now, but could not be saved for next time.",
        );
    }
  }
  return {
    tapMode: screenReader || preferredTap,
    ready,
    screenReader,
    message,
    choose,
  };
}
