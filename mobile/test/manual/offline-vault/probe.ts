/* Fictional G1 primitive probe. Never import from the production companion. */
import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';

const keyName = 'parse.vault.probe.key.v1';
const options: SecureStore.SecureStoreOptions = {
  keychainService: 'sg.parse.vaultprobe', requireAuthentication: true,
  authenticationPrompt: 'Unlock the fictional Parse vault probe',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const directory = () => new Directory(Paths.document, 'parse-vault-probe-v1');
const encode = (value: string) => Uint8Array.from([...value].map(character => character.charCodeAt(0)));
type Identity = { installation: string; turnKey: string };
export type Checkpoint = 'temporary_write' | 'audio_rename' | 'journal_commit';

function nativeOnly() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') throw new Error('Native device required');
}
function identity(): Identity {
  nativeOnly();
  const value = JSON.parse(new File(directory(), 'identity.json').textSync()) as Identity;
  if (!value.installation || !value.turnKey) throw new Error('Probe not prepared');
  return value;
}
async function key() {
  const stored = await SecureStore.getItemAsync(keyName, options);
  if (!stored) throw new Error('Probe key unavailable; do not generate a replacement for existing bytes');
  return Crypto.AESEncryptionKey.import(stored, 'base64');
}

function syntheticWav() {
  const bytes = new Uint8Array(44 + 32000);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => bytes.set(encode(value), at);
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, 32000, true);
  for (let frame = 0; frame < 16000; frame++)
    view.setInt16(44 + frame * 2, Math.round(500 * Math.sin(2 * Math.PI * 440 * frame / 16000)), true);
  return bytes;
}
const audioAad = (value: Identity) => encode(`probe-v1:${value.installation}:${value.turnKey}:audio`);
const journalAad = (value: Identity) => encode(`probe-v1:${value.installation}:${value.turnKey}:journal`);

export async function clearProbe() {
  nativeOnly();
  await SecureStore.deleteItemAsync(keyName, options);
  const dir = directory();
  if (dir.exists) dir.delete(); // This separate app's exact probe directory only.
}
export async function prepareProbe() {
  await clearProbe();
  const dir = directory(); dir.create({ intermediates: true, idempotent: true });
  const generated = await Crypto.AESEncryptionKey.generate();
  await SecureStore.setItemAsync(keyName, await generated.encoded('base64'), options);
  const opaque = new File(dir, 'identity.json'); opaque.create();
  opaque.write(JSON.stringify({ installation: Crypto.randomUUID(), turnKey: Crypto.randomUUID() }));
}

export async function writeCheckpoint(checkpoint: Checkpoint) {
  const value = identity(); const encryptionKey = await key();
  const sealed = await Crypto.aesEncryptAsync(syntheticWav(), encryptionKey, { additionalData: audioAad(value) });
  const pending = new File(directory(), 'audio.pending'); pending.create({ overwrite: true });
  pending.write(await sealed.combined());
  if (checkpoint === 'temporary_write') return;
  await pending.move(new File(directory(), 'audio.sealed'), { overwrite: true });
  if (checkpoint === 'audio_rename') return;
  const journal = await Crypto.aesEncryptAsync(encode(JSON.stringify({
    ...value, fictional: true, capturedAt: new Date().toISOString(), wording: 'Fictional private note',
  })), encryptionKey, { additionalData: journalAad(value) });
  const journalPending = new File(directory(), 'journal.pending'); journalPending.create({ overwrite: true });
  journalPending.write(await journal.combined());
  await journalPending.move(new File(directory(), 'journal.sealed'), { overwrite: true });
}

export async function inspectProbe() {
  const value = identity();
  const audio = new File(directory(), 'audio.sealed'); const journal = new File(directory(), 'journal.sealed');
  const observation = { audioExists: audio.exists, journalExists: journal.exists,
    temporaryExists: new File(directory(), 'audio.pending').exists, readablePair: false };
  if (!audio.exists || !journal.exists) return observation;
  const encryptionKey = await key();
  const decodedAudio = await Crypto.aesDecryptAsync(Crypto.AESSealedData.fromCombined(await audio.bytes()),
    encryptionKey, { additionalData: audioAad(value) });
  const decodedJournal = await Crypto.aesDecryptAsync(Crypto.AESSealedData.fromCombined(await journal.bytes()),
    encryptionKey, { additionalData: journalAad(value) });
  observation.readablePair = decodedAudio.length === 32044 && decodedJournal.length > 0;
  // Never return plaintext, ciphertext, credentials or key bytes to the UI/report.
  return observation;
}

export async function integrityProbe() {
  const value = identity(); const encryptionKey = await key();
  const bytes = await new File(directory(), 'audio.sealed').bytes();
  const altered = new Uint8Array(bytes); altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  let tamperRejected = false; let wrongIdentityRejected = false;
  try { await Crypto.aesDecryptAsync(Crypto.AESSealedData.fromCombined(altered), encryptionKey,
    { additionalData: audioAad(value) }); } catch { tamperRejected = true; }
  try { await Crypto.aesDecryptAsync(Crypto.AESSealedData.fromCombined(bytes), encryptionKey,
    { additionalData: audioAad({ ...value, installation: 'different-fictional-installation' }) }); }
  catch { wrongIdentityRejected = true; }
  return { tamperRejected, wrongIdentityRejected };
}
