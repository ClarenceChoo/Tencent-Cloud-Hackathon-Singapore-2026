export function serviceAddress(value: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new Error(
      "Use the HTTPS service address supplied by your care-space owner, without a path or login details.",
    );
  }
  return url.origin;
}
export function audioPath(path: string): string {
  if (!/^\/v1\/device\/audio\/audio_[a-f0-9]{32}$/.test(path))
    throw new Error("The reply audio address is invalid.");
  return path;
}
export function wavDuration(bytes: Uint8Array): number {
  if (bytes.length > 768 * 1024 || bytes.length < 44)
    throw new Error("Reply audio exceeds its size limits.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, count: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + count));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE")
    throw new Error("Reply audio is not WAV.");
  let validFormat = false;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > bytes.length) throw new Error("Reply audio is truncated.");
    if (text(offset, 4) === "fmt ") {
      validFormat =
        size >= 16 &&
        view.getUint16(offset + 8, true) === 1 &&
        view.getUint16(offset + 10, true) === 1 &&
        view.getUint32(offset + 12, true) === 16000 &&
        view.getUint16(offset + 22, true) === 16;
    }
    if (text(offset, 4) === "data") dataSize += size;
    offset = end + (size % 2);
  }
  const duration = dataSize / 32000;
  if (!validFormat || duration < 0.3 || duration > 20 || dataSize % 2)
    throw new Error("Reply audio format or duration is invalid.");
  return duration;
}
