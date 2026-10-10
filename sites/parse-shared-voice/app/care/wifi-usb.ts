// Provisioning uses only the explicitly selected USB port. No network or storage.
export type WifiDeviceStatus = {
  protocol: 1; firmware: 'parse-wifi-1'; state: string;
  requestId?: string; roomId?: string; code?: string; message?: string; errorCode?: string;
};
export interface WifiSerialPort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: {baudRate: number; bufferSize: number}): Promise<void>;
  close(): Promise<void>;
}
export interface WifiSerialAccess {requestPort(): Promise<WifiSerialPort>}
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TOKEN = /^[a-f0-9]{64}$/;

export function hotspotError(ssid: string, password: string): string | null {
  if (!ssid || new TextEncoder().encode(ssid).length > 32 || /[\x00-\x1f\x7f]/.test(ssid)) return 'Enter the hotspot name exactly as shown on your iPhone (up to 32 bytes).';
  if (!/^[\x20-\x7e]{8,63}$/.test(password)) return 'Use the iPhone hotspot password: 8–63 English letters, numbers, or symbols.';
  return null;
}
export function pairingDetails(path: string): {roomId: string; token: string} {
  const url = new URL(path, 'https://pairing.invalid');
  const roomId = url.searchParams.get('room') ?? '';
  const token = new URLSearchParams(url.hash.slice(1)).get('pair') ?? '';
  if (!ID.test(roomId) || !TOKEN.test(token)) throw new Error('Parse could not prepare this pairing. Start setup again.');
  return {roomId, token};
}
export function parseWifiStatus(line: string): WifiDeviceStatus | null {
  if (!line.startsWith('PARSE_WIFI_STATUS ') || line.length > 2048) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(line.slice(18)); } catch { return null; }
  if (!value || value.protocol !== 1 || value.firmware !== 'parse-wifi-1' || typeof value.state !== 'string' || !/^[a-z_]{1,40}$/.test(value.state)) return null;
  const result: WifiDeviceStatus = {protocol: 1, firmware: 'parse-wifi-1', state: value.state};
  if (typeof value.requestId === 'string' && ID.test(value.requestId)) result.requestId = value.requestId;
  if (typeof value.roomId === 'string' && ID.test(value.roomId)) result.roomId = value.roomId;
  if (typeof value.code === 'string' && /^\d{6}$/.test(value.code)) result.code = value.code;
  if (typeof value.message === 'string') result.message = value.message.slice(0, 200);
  if (typeof value.errorCode === 'string' && /^[a-z_]{1,60}$/.test(value.errorCode)) result.errorCode = value.errorCode;
  return result;
}

export class WifiUsbSession {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pending = new Map<string, {resolve: (value: WifiDeviceStatus)=>void; reject: (error: Error)=>void; timer: ReturnType<typeof setTimeout>}>();
  private closed = false;
  private verified = false;
  private readTask: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private constructor(private port: WifiSerialPort, private onStatus: (value: WifiDeviceStatus)=>void, private onClose: ()=>void) {}
  static async connect(access: WifiSerialAccess, onStatus: (value: WifiDeviceStatus)=>void, onClose: ()=>void): Promise<WifiUsbSession> {
    const port = await access.requestPort();
    await port.open({baudRate: 115200, bufferSize: 4096});
    const session = new WifiUsbSession(port, onStatus, onClose);
    try {
      if (!port.readable || !port.writable) throw new Error('The selected USB port is not ready. Reconnect the board and try again.');
      session.reader = port.readable.getReader();
      session.writer = port.writable.getWriter();
      session.readTask = session.readLoop();
      // Some USB bridges reset the board on open. Recheck through its startup.
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await session.command({command: 'wifi_status'}, 4000); session.verified = true; return session; }
        catch { if (session.closed) break; }
      }
      throw new Error('This board did not identify itself as Parse Wi-Fi firmware. Install the Wi-Fi firmware first, then reconnect. No hotspot details were sent.');
    } catch (error) { await session.close(); throw error; }
  }
  async configure(ssid: string, password: string, pairing?: {roomId: string; token: string}): Promise<WifiDeviceStatus> {
    const problem = hotspotError(ssid, password); if (problem) throw new Error(problem);
    if (!this.verified) throw new Error('Connect and identify the Parse board first.');
    if (pairing && (!ID.test(pairing.roomId) || !TOKEN.test(pairing.token))) throw new Error('The pairing invitation is invalid. Start setup again.');
    const payload: Record<string, string> = pairing ? {command: 'wifi_setup', ssid, password, room_id: pairing.roomId, pairing_token: pairing.token} : {command: 'wifi_network', ssid, password};
    const result = await this.command(payload, 12000);
    if (result.state === 'error') throw new Error('The board could not save these settings. Check the hotspot details and try again.');
    return result;
  }
  async status(): Promise<WifiDeviceStatus> { return this.command({command: 'wifi_status'}, 4000); }
  private async command(payload: Record<string, string>, timeoutMs: number): Promise<WifiDeviceStatus> {
    if (this.closed || !this.writer) throw new Error('The USB connection is closed. Reconnect the board.');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('The board did not acknowledge the request. Reconnect USB and check its status before retrying.')); }, timeoutMs);
      this.pending.set(requestId, {resolve, reject, timer});
      void this.writer!.write(new TextEncoder().encode(JSON.stringify({...payload, requestId}) + '\n')).catch(() => {
        clearTimeout(timer); this.pending.delete(requestId); reject(new Error('USB was interrupted. Reconnect the board and check its status.'));
      });
    });
  }
  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder(); let line = ''; let oversized = false;
    try {
      while (!this.closed && this.reader) {
        const {value, done} = await this.reader.read(); if (done) break;
        for (const char of decoder.decode(value, {stream: true})) {
          if (char === '\n') {
            const status = oversized ? null : parseWifiStatus(line.replace(/\r$/, ''));
            line = ''; oversized = false;
            if (status) {
              if (status.requestId) { const wait = this.pending.get(status.requestId); if (wait) { clearTimeout(wait.timer); this.pending.delete(status.requestId); wait.resolve(status); } }
              this.onStatus(status);
            }
          } else if (line.length < 2048 && !oversized) line += char;
          else { oversized = true; line = ''; }
        }
      }
    } catch { /* A disconnected USB device has no trustworthy provider detail. */ }
    finally {
      this.closed = true;
      for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(new Error('USB disconnected. Keep the ESP32 powered to stay on Wi-Fi.')); }
      this.pending.clear(); this.onClose();
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.reader?.cancel().catch(() => {});
      await this.readTask;
      this.reader?.releaseLock(); this.reader = null;
      try { this.writer?.releaseLock(); } catch { /* Detached device. */ } this.writer = null;
      await this.port.close().catch(() => {});
    })();
    return this.closing;
  }
}
