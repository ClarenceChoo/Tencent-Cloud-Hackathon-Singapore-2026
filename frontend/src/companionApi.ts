import type { Enrollment, Home, Proposal, Receipt, TurnEvent, TurnStatus, Reminder } from '../../mobile/src/contracts';
import type { CaptureIntent } from './carePurpose';

export type { Enrollment, Home, Proposal, Receipt, TurnEvent, TurnStatus, Reminder };
export class CompanionApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

let csrf = '';
export function setCompanionCsrf(value: string) { csrf = value; }
const json = (body: unknown) => JSON.stringify(body);
async function request<T>(path: string, init: RequestInit = {}, timeout = 30000): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) abort();
  const timer = window.setTimeout(abort, timeout);
  const headers = new Headers(init.headers);
  headers.set('X-Parse-Web', '1');
  if (init.method && init.method !== 'GET' && init.method !== 'HEAD' && csrf) headers.set('X-CSRF-Token', csrf);
  try {
    const response = await fetch('/v1/web' + path, { ...init, headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      let message = `Parse could not complete this request (${response.status}).`;
      try { const value = await response.json(); if (typeof value.detail === 'string') message = value.detail; } catch { /* no JSON error */ }
      throw new CompanionApiError(message, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}

export function webAudioPath(path: string): string {
  const match = /^\/v1\/(?:device|web)\/audio\/(audio_[a-f0-9]{32})$/.exec(path);
  if (!match) throw new Error('The spoken reply address is invalid.');
  return '/v1/web/audio/' + match[1];
}

export function wavDuration(bytes: Uint8Array): number {
  if (bytes.length < 44 || bytes.length > 768 * 1024) throw new Error('Spoken reply exceeds its size limits.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Spoken reply is not WAV audio.');
  let format = false, data = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true), end = at + 8 + size;
    if (end > bytes.length) throw new Error('Spoken reply is incomplete.');
    if (tag(at) === 'fmt ') format = size >= 16 && view.getUint16(at + 8, true) === 1 && view.getUint16(at + 10, true) === 1 && view.getUint32(at + 12, true) === 16000 && view.getUint16(at + 22, true) === 16;
    if (tag(at) === 'data') data += size;
    at = end + size % 2;
  }
  const duration = data / 32000;
  if (!format || data % 2 || duration < 0.3 || duration > 20) throw new Error('Spoken reply has an invalid format or length.');
  return duration;
}

export async function fetchWebAudio(path: string, signal: AbortSignal, method: 'GET' | 'HEAD' = 'GET'): Promise<{ blob: Blob; duration: number } | void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = window.setTimeout(abort, method === 'HEAD' ? 5000 : 30000);
  try {
    const response = await fetch(webAudioPath(path), { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'X-Parse-Web': '1' }, signal: controller.signal });
    if (!response.ok) throw new CompanionApiError('This spoken reply is no longer available. Check the current care details.', response.status);
    if (method === 'HEAD') return;
    const length = Number(response.headers.get('Content-Length'));
    if (length > 768 * 1024) throw new Error('Spoken reply exceeds its size limit.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Spoken reply is missing.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (signal.aborted) throw new Error('Spoken reply was interrupted.');
        if (part.done) break;
        size += part.value.length;
        if (size > 768 * 1024) throw new Error('Spoken reply exceeds its size limit.');
        chunks.push(part.value);
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return { blob: new Blob([bytes], { type: 'audio/wav' }), duration: wavDuration(bytes) };
  } finally { window.clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

export const companionApi = {
  session: () => request<{ has_installation: boolean; csrf_token: string }>('/session'),
  enroll: () => request<Enrollment & { csrf_token?: string }>('/enrollments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ display_name: 'Parse browser' }) }),
  enrollment: () => request<Enrollment>('/enrollments/current'),
  home: () => request<Home>('/home'),
  presence: (lifecycle: 'foreground' | 'background', microphone: 'granted' | 'denied' | 'undetermined' | 'unknown') => request<{server_time: string}>('/presence', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json({ lifecycle, microphone_permission: microphone, notification_permission: 'undetermined' }),
  }),
  upload: (bytes: Blob, key: string, context: string | null, signal: AbortSignal, captureIntent: CaptureIntent | null = null) => request<Receipt>('/turns', { method: 'POST', body: bytes, signal, headers: { 'Content-Type': bytes.type, 'Idempotency-Key': key, ...(context ? { 'X-Context-Id': context } : {}), ...(!context && captureIntent ? { 'X-Care-Intent': captureIntent } : {}) } }),
  receipt: (key: string, signal?: AbortSignal) => request<Receipt>('/turn-receipts/' + encodeURIComponent(key), { signal }),
  turn: (id: string, signal?: AbortSignal) => request<TurnStatus>('/turns/' + encodeURIComponent(id), { signal }),
  confirm: (proposal: Proposal) => request<{ status: string; record_type?: string; record_id?: string }>('/proposals/' + encodeURIComponent(proposal.id) + '/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ context_id: proposal.context_id, confirmed: true }) }),
  cancel: (proposal: Proposal) => request<unknown>('/proposals/' + encodeURIComponent(proposal.id) + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ context_id: proposal.context_id }) }),
  revise: (proposal: Proposal, payload: Record<string, unknown>) => request<Proposal>('/proposals/' + encodeURIComponent(proposal.id) + '/revise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ context_id: proposal.context_id, payload }) }),
  speech: (proposal: Proposal) => request<TurnEvent>('/proposals/' + encodeURIComponent(proposal.id) + '/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ context_id: proposal.context_id }) }),
  speaker: (signal?: AbortSignal) => request<TurnEvent>('/speaker-check', { method: 'POST', signal }),
  pending: () => request<{ active_companion: Home['active_companion']; commands: Reminder[]; checkins: Reminder[] }>('/pending-commands'),
  reminder: (id: string) => request<Reminder>('/reminders/' + encodeURIComponent(id)),
  ack: (command: string, id: string, stage: string) => request<unknown>('/acks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ command_id: command, ack_id: id, stage }) }),
  quiesce: () => request<unknown>('/quiesce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ playback_stopped: true, local_alerts_cleared: true }) }),
  revoke: () => request<unknown>('/installation', { method: 'DELETE' }),
};
