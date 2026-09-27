import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { Installation, PendingTurn } from "./contracts";
import { serviceAddress } from "./validation";
import { PendingTurnJournal } from "./turnRecovery";

const options = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
const marker = () => new File(Paths.document, "parse-installation-v1");
export async function loadInstallation(): Promise<{
  installation: Installation | null;
  restored: boolean;
}> {
  const raw = await SecureStore.getItemAsync("parse.installation", options);
  if (!raw) return { installation: null, restored: false };
  const installation = JSON.parse(raw) as Installation;
  if (
    installation.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(installation.credential)
  )
    throw new Error(
      "Saved pairing could not be read. Ask the care-space owner to revoke this phone and pair it again.",
    );
  serviceAddress(installation.service);
  return { installation, restored: !marker().exists };
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
  const { clearPlayback } = await import("./reminderStorage");
  await clearPlayback();
  await SecureStore.deleteItemAsync("parse.installation", options);
  await savePending(null);
  if (marker().exists) marker().delete();
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
  for (const entry of new Directory(Paths.cache).list()) {
    if (entry instanceof File && /^(recording-|parse-reply-)/.test(entry.name))
      entry.delete();
  }
}
