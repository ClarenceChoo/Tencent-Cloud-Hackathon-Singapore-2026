import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { Installation, PendingTurn } from "./contracts";
import { serviceAddress } from "./validation";
import { PendingTurnJournal } from "./turnRecovery";
import { clearPlayback, hasPlaybackHistory } from "./reminderStorage";

const options = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
let preferenceWrite = Promise.resolve();
export async function loadTapMode(): Promise<boolean | null> {
  await preferenceWrite;
  const value = await SecureStore.getItemAsync(
    "parse.interaction-mode",
    options,
  );
  return value === "tap" ? true : value === "hold" ? false : null;
}
export function saveTapMode(tap: boolean): Promise<void> {
  const next = preferenceWrite.then(() =>
    SecureStore.setItemAsync(
      "parse.interaction-mode",
      tap ? "tap" : "hold",
      options,
    ),
  );
  preferenceWrite = next.catch(() => {});
  return next;
}
const marker = () => new File(Paths.document, "parse-installation-v1");
const resetMarker = () => new File(Paths.document, "parse-reset-required-v1");
class SavedPairingProblem extends Error {}
export async function loadInstallation(): Promise<{
  installation: Installation | null;
  restored: boolean;
}> {
  try {
    if (resetMarker().exists)
      throw new SavedPairingProblem(
        "The previous reset did not finish. Reset this phone again to clear its remaining local data.",
      );
    const raw = await SecureStore.getItemAsync("parse.installation", options);
    if (!raw) {
      if (
        marker().exists ||
        (await SecureStore.getItemAsync("parse.pending-turn", options)) ||
        (await hasPlaybackHistory())
      )
        throw new SavedPairingProblem(
          "This phone's pairing is missing, but local records from an earlier pairing remain.",
        );
      return { installation: null, restored: false };
    }
    try {
      const installation = JSON.parse(raw) as Installation;
      if (
        !installation ||
        installation.version !== 1 ||
        typeof installation.credential !== "string" ||
        !/^[a-f0-9]{64}$/.test(installation.credential) ||
        typeof installation.enrollmentKey !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          installation.enrollmentKey,
        ) ||
        !["ios", "android"].includes(installation.platform) ||
        typeof installation.displayName !== "string" ||
        !installation.displayName.trim() ||
        installation.displayName.length > 120 ||
        typeof installation.service !== "string"
      )
        throw new Error();
      serviceAddress(installation.service);
      return { installation, restored: !marker().exists };
    } catch {
      throw new SavedPairingProblem(
        "The saved pairing is incomplete or unreadable. Retry before choosing to reset this phone.",
      );
    }
  } catch (err) {
    if (err instanceof SavedPairingProblem) throw err;
    throw new SavedPairingProblem(
      "Parse could not read this phone's protected pairing. Unlock the phone and try again. Your pairing has not been replaced.",
    );
  }
}
export async function newInstallation(
  service: string,
  platform: "ios" | "android",
): Promise<Installation> {
  const credential = Array.from(await Crypto.getRandomBytesAsync(32), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const installation: Installation = {
    version: 1,
    service: serviceAddress(service),
    credential,
    enrollmentKey: Crypto.randomUUID(),
    platform,
    displayName: platform === "ios" ? "Parse iPhone" : "Parse Android",
  };
  await SecureStore.setItemAsync(
    "parse.installation",
    JSON.stringify(installation),
    options,
  );
  marker().write("v1");
  return installation;
}
export async function clearInstallation() {
  // A killed or failed reset must not reopen the old identity with a partially
  // erased playback ledger. Remove this barrier only after every delete succeeds.
  resetMarker().write("v1");
  await clearPlayback();
  await savePending(null);
  await SecureStore.deleteItemAsync("parse.installation", options);
  if (marker().exists) marker().delete();
  resetMarker().delete();
}
const pendingJournal = new PendingTurnJournal({
  read: async () => {
    const raw = await SecureStore.getItemAsync("parse.pending-turn", options);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as PendingTurn;
      if (
        !/^[a-f0-9-]{36}$/i.test(value.key) ||
        !Number.isFinite(value.createdAt) ||
        (value.turnId !== undefined &&
          !/^turn_[a-f0-9]{32}$/.test(value.turnId)) ||
        !(value.context === null || typeof value.context === "string")
      )
        throw new Error();
      return value;
    } catch {
      throw new Error(
        "The unfinished recording could not be read. Discard it before recording again.",
      );
    }
  },
  write: async (value) => {
    if (value)
      await SecureStore.setItemAsync(
        "parse.pending-turn",
        JSON.stringify(value),
        options,
      );
    else await SecureStore.deleteItemAsync("parse.pending-turn", options);
  },
});
export const savePending = (value: PendingTurn | null) =>
  pendingJournal.write(value);
export const retainPending = (value: PendingTurn) =>
  pendingJournal.replace(value.key, value);
export const clearPending = (key: string) => pendingJournal.replace(key, null);
export async function loadPending(): Promise<PendingTurn | null> {
  return pendingJournal.read();
}
export function removeAudio(uri: string | null) {
  if (!uri || !uri.startsWith(Paths.cache.uri)) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}
export function sweepAudio() {
  // The pinned native recorders use Audio on Android and ExpoAudio on iOS.
  // Keep this bounded to our recorder locations and owned filename prefixes.
  const directories = [
    new Directory(Paths.cache),
    new Directory(Paths.cache, "Audio"),
    new Directory(Paths.cache, "ExpoAudio"),
  ];
  for (const directory of directories) {
    if (!directory.exists) continue;
    for (const entry of directory.list()) {
      if (
        entry instanceof File &&
        /^(recording-|parse-reply-)/.test(entry.name)
      )
        entry.delete();
    }
  }
}
