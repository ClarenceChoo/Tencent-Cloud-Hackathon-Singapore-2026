import assert from "node:assert/strict";
import test from "node:test";
import { audioPath, serviceAddress, wavDuration } from "../src/validation";

test("credentials are sent only to an HTTPS origin and authenticated audio path", () => {
  assert.equal(
    serviceAddress("https://parse.example.org/"),
    "https://parse.example.org",
  );
  for (const value of [
    "http://parse.example.org",
    "https://user:secret@parse.example.org",
    "https://parse.example.org/private",
    "https://parse.example.org/?token=secret",
    "https://parse.example.org/#fragment",
  ])
    assert.throws(() => serviceAddress(value));
  assert.equal(
    audioPath("/v1/device/audio/audio_" + "a".repeat(32)),
    "/v1/device/audio/audio_" + "a".repeat(32),
  );
  for (const path of [
    "https://other.example/audio",
    "//other.example/audio",
    "/v1/device/audio/../settings",
    "/v1/device/audio/audio_" + "a".repeat(32) + "?token=x",
  ])
    assert.throws(() => audioPath(path));
});
function wav(seconds: number, rate = 16000) {
  const bytes = new Uint8Array(44 + Math.round(seconds * rate) * 2);
  const view = new DataView(bytes.buffer);
  function text(offset: number, value: string) {
    for (let i = 0; i < value.length; i++)
      bytes[offset + i] = value.charCodeAt(i);
  }
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes.length - 44, true);
  return bytes;
}
test("speech assets are validated before native playback", () => {
  assert.equal(wavDuration(wav(0.5)), 0.5);
  assert.equal(wavDuration(wav(20)), 20);
  for (const bytes of [
    wav(0.1),
    wav(20.1),
    wav(1, 44100),
    wav(1).slice(0, 60),
    new Uint8Array(44),
  ])
    assert.throws(() => wavDuration(bytes));
});
