import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import type { LedgerEntry } from "./contracts";
const options = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
// Each value stays small. Eight indexes bound storage; failure stops playback.
const bucketCount = 8;
const entryKey = (command: string) => "parse.playback." + command;
export async function readPlayback(
  command: string,
): Promise<LedgerEntry | null> {
  if (!/^(cmd|checkin)_[a-f0-9]{32}$/.test(command))
    throw new Error("Invalid reminder identity.");
  const raw = await SecureStore.getItemAsync(entryKey(command), options);
  return raw ? JSON.parse(raw) : null;
}
export async function writePlayback(entry: LedgerEntry) {
  await readPlayback(entry.command);
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    entry.command,
  );
  const key =
    "parse.playback-index." + (parseInt(hash.slice(0, 2), 16) % bucketCount);
  const raw = await SecureStore.getItemAsync(key, options);
  const index: (readonly [string, number])[] = raw ? JSON.parse(raw) : [];
  const retained = [];
  for (const item of index) {
    if (item[1] < Date.now() - 86400000)
      await SecureStore.deleteItemAsync(entryKey(item[0]), options);
    else if (item[0] !== entry.command) retained.push(item);
  }
  if (retained.length >= 24)
    throw new Error(
      "Reminder history is full. Open Parse again later; automatic playback is paused.",
    );
  retained.push([entry.command, entry.expires] as const);
  await SecureStore.setItemAsync(key, JSON.stringify(retained), options);
  await SecureStore.setItemAsync(
    entryKey(entry.command),
    JSON.stringify(entry),
    options,
  );
}
export async function clearPlayback() {
  for (let b = 0; b < bucketCount; b++) {
    const key = "parse.playback-index." + b;
    const raw = await SecureStore.getItemAsync(key, options);
    const entries: (readonly [string, number])[] = raw ? JSON.parse(raw) : [];
    for (const [id] of entries)
      await SecureStore.deleteItemAsync(entryKey(id), options);
    await SecureStore.deleteItemAsync(key, options);
  }
}
