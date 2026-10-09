import { previewDashboard, previewOnlyMessage, previewSession, uiPreview } from './uiPreview';

export type User = { id: string; name: string; email: string; role: string };
export type Patient = { id: string; name: string; timezone: string; preferred_name?: string; language?: string; daily_check_in_enabled?: boolean; daily_check_in_local_time?: string | null; calling_route?: string | null };
export type Session = { user: User; patients: Patient[]; csrf_token: string };
export type Proposal = { id: string; kind: string; payload: Record<string, unknown>; readback: string; status: string; expires_at?: string };
export type VoiceInterpretation = {proposal?:Proposal;spoken_text:string;function_name:string;intent?:'clarify'|'chat'|'proposal'|'confirm'|'explain'|'support_status'|'followup_status'};
export type CareQueryKind = 'latest_reading' | 'open_support' | 'medication_reports';
export type CareQuerySourceType = 'measurement' | 'support_request' | 'dose';
export type CareQueryItem = {
  source_type: CareQuerySourceType; source_id: string; source_version: number | null;
  recorded_at: string | null; occurred_at: string | null;
  provenance?: Record<string, unknown> | null;
  [key: string]: unknown;
};
export type CareQueryResponse = {
  kind: CareQueryKind; generated_at: string; timezone: string;
  date_basis: 'recorded_at' | 'scheduled_local_date'; local_date: string | null;
  items: CareQueryItem[]; truncated: boolean;
};
export type Row = Record<string, unknown> & { id?: string };
export type ActivityItem = { id: string; recorded_at: string; event: string; category: string; summary: string; status: string; source: string; record_id: string };
export type ActivityPage = { items: ActivityItem[]; next_cursor: string | null; timezone: string };
export type ActivityFilters = { category?: string; search?: string; start?: string; end?: string; cursor?: string };
export type SummaryPurpose = 'doctor_visit' | 'family_handoff' | 'weekly_review';
export type VocabularyTerm = { canonical: string; aliases: string[]; category: 'medicine' | 'person' | 'other' };
export type VocabularyView = { version: number; terms: VocabularyTerm[]; reviewed_by_user_id: string | null; reviewed_at: string | null };
export type VocabularySuggestion = VocabularyTerm;
export type DeviceSetupStatus = {
  service_address: string | null;
  voice_service: 'unconfigured' | 'configured' | 'simulated' | 'invalid_configuration';
  live_voice_verified: boolean;
  scheduler_enabled: boolean;
};
export type PairingInvitation = {
  id: string; expires_at: string; status: 'waiting' | 'scanned' | 'paired';
  url?: string; display_name?: string; code?: string;
};
export type Dashboard = {
  patient: Patient & Record<string, unknown>;
  devices: Row[]; medication_plans: Row[]; doses: Row[]; notes: Row[]; measurements: Row[];
  preventive_tasks: Row[]; support_requests: Row[]; followups: Row[]; proposals: Proposal[]; permissions: string[]; access_grants: Row[]; allowed_recipients: Row[]; summaries: Row[];
  device_setup?: DeviceSetupStatus;
  active_companion?: {device_id:string|null;generation:number;changed_at?:string|null}|null;
};

let csrfToken = '';
export function setCsrf(token: string) { csrfToken = token; }
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (uiPreview) {
    if ((!options.method || options.method === 'GET') && path === '/auth/session') return previewSession() as T;
    if ((!options.method || options.method === 'GET') && path === '/app/patients/sample-patient/dashboard') return previewDashboard() as T;
    throw new ApiError(previewOnlyMessage, 400);
  }
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(`/v1${path}`, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json() as {detail?: unknown; message?: unknown};
      const detail = data.detail ?? data.message;
      if (typeof detail === 'string') message = detail;
      else if (Array.isArray(detail)) message = detail.map(item => {
        const location = Array.isArray(item?.loc) ? item.loc.filter((part: unknown) => part !== 'body').join(' → ') : '';
        const reason = typeof item?.msg === 'string' ? item.msg : JSON.stringify(item);
        return location ? `${location}: ${reason}` : reason;
      }).join('; ');
      else if (detail != null) message = JSON.stringify(detail);
    } catch { /* response had no JSON body */ }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const api = {
  interpretVoice: (patientId: string, recordingId: string) => request<VoiceInterpretation>(`/app/patients/${encodeURIComponent(patientId)}/voice-interpretation`, json('POST', {recording_id: recordingId})),
  login: (email: string, password: string) => request<Session>('/auth/login', json('POST', { email, password })),
  session: () => request<Session>('/auth/session'),
  logout: () => request<void>('/auth/logout', json('POST')),
  dashboard: (patientId: string) => request<Dashboard>(`/app/patients/${encodeURIComponent(patientId)}/dashboard`),
  activity: (patientId: string, filters: ActivityFilters = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => Boolean(value)));
    return request<ActivityPage>(`/app/patients/${encodeURIComponent(patientId)}/activity?${query}`, {signal, cache: 'no-store'});
  },
  vocabulary: (patientId: string) => request<VocabularyView>(`/app/patients/${encodeURIComponent(patientId)}/vocabulary`, { cache: 'no-store' }),
  vocabularySuggestions: (patientId: string) => request<{ suggestions: VocabularySuggestion[] }>(`/app/patients/${encodeURIComponent(patientId)}/vocabulary/suggestions`, { cache: 'no-store' }),
  updateVocabulary: (patientId: string, expectedVersion: number, terms: VocabularyTerm[]) =>
    request<VocabularyView>(`/app/patients/${encodeURIComponent(patientId)}/vocabulary`, json('PUT', { expected_version: expectedVersion, terms })),
  careQuery: (patientId: string, kind: CareQueryKind, localDate?: string, signal?: AbortSignal) =>
    request<CareQueryResponse>(`/app/patients/${encodeURIComponent(patientId)}/queries`,
      { ...json('POST', { kind, ...(kind === 'medication_reports' ? { local_date: localDate } : {}) }), signal, cache: 'no-store' }),
  careQuerySource: (patientId: string, kind: CareQuerySourceType, sourceId: string, signal?: AbortSignal) =>
    request<CareQueryItem>(`/app/patients/${encodeURIComponent(patientId)}/query-sources/${encodeURIComponent(kind)}/${encodeURIComponent(sourceId)}`,
      { signal, cache: 'no-store' }),
  updateProfile: (patientId: string, payload: Record<string, unknown>) => request<Row>(`/app/patients/${encodeURIComponent(patientId)}/profile`, json('PUT', payload)),
  createProposal: (patientId: string, kind: string, payload: Record<string, unknown>) => request<Proposal>(`/app/patients/${encodeURIComponent(patientId)}/proposals`, json('POST', { kind, payload })),
  reviseProposal: (id: string, payload: Record<string, unknown>) => request<Proposal>(`/app/proposals/${encodeURIComponent(id)}/revise`, json('POST', { payload })),
  confirmProposal: (id: string) => request<{ status: string; record_type: string; record_id: string }>(`/app/proposals/${encodeURIComponent(id)}/confirm`, json('POST', { confirmed: true })),
  acknowledge: (id: string) => request<void>(`/app/support-requests/${encodeURIComponent(id)}/acknowledge`, json('POST')),
  resolve: (id: string, outcome: string) => request<void>(`/app/support-requests/${encodeURIComponent(id)}/resolve`, json('POST', { outcome })),
  claimDevice: (code: string, patientId: string) => request<Row>('/app/devices/claim', json('POST', { code, patient_id: patientId })),
  approvePhone: (code: string, patientId: string) => request<Row>('/app/phone-enrollments/approve', json('POST', { code, patient_id: patientId })),
  createPairingInvitation: (patientId: string) => request<PairingInvitation>(`/app/patients/${encodeURIComponent(patientId)}/pairing-invitations`, json('POST')),
  pairingInvitation: (patientId: string, id: string) => request<PairingInvitation>(`/app/patients/${encodeURIComponent(patientId)}/pairing-invitations/${encodeURIComponent(id)}`, {cache:'no-store'}),
  cancelPairingInvitation: (patientId: string, id: string) => request<void>(`/app/patients/${encodeURIComponent(patientId)}/pairing-invitations/${encodeURIComponent(id)}`, json('DELETE')),
  selectCompanion: (patientId:string, deviceId:string|null, generation:number, poweredOff:boolean) => request(`/app/patients/${encodeURIComponent(patientId)}/active-companion`, json('PUT', {device_id:deviceId, expected_generation:generation, other_pendants_powered_off:poweredOff})),
  revokeDevice: (id: string) => request<void>(`/app/devices/${encodeURIComponent(id)}/revoke`, json('POST')),
  releaseRemovedPhone: (id:string,generation:number) => request(`/app/devices/${encodeURIComponent(id)}/release-removed-phone`, json('POST', {expected_generation:generation,app_removed_or_reset:true})),
  createSummary: (patientId: string, startDate: string, endDate: string, purpose: SummaryPurpose = 'doctor_visit', questions: string[] = []) =>
    request<Row>(`/app/patients/${encodeURIComponent(patientId)}/summaries`, json('POST',
      { start_date: startDate, end_date: endDate, purpose, questions })),
  updateSummary: (id: string, payload: Record<string, unknown>) => request<Row>(`/app/summaries/${encodeURIComponent(id)}`, json('PUT', payload)),
  shareSummary: (id: string) => request<Row>(`/app/summaries/${encodeURIComponent(id)}/share`, json('POST', { expires_in_seconds: 3600 })),
  revokeSummaryShare: (id: string) => request<void>(`/app/summaries/${encodeURIComponent(id)}/revoke`, json('POST')),
  printSummary: (id: string, signal?: AbortSignal) => request<Row>(`/app/summaries/${encodeURIComponent(id)}/print`,
    { signal, cache: 'no-store' }),
  grant: (patientId: string, userId: string, scopes: string[]) => request<Row>(`/app/patients/${encodeURIComponent(patientId)}/grants`, json('POST', { user_id: userId, scopes, expires_at: null })),
  revokeGrant: (id: string) => request<void>(`/app/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setNoteSharing: (noteId: string, userIds: string[]) => request<Row>(`/app/notes/${encodeURIComponent(noteId)}/sharing`, { method: 'PUT', body: JSON.stringify({ user_ids: userIds }) }),
  deleteNote: (noteId: string) => request<void>(`/app/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' }),
  sharedSummary: (token: string, signal?: AbortSignal) => request<Row>(`/shared/summaries/${encodeURIComponent(token)}`, { signal, cache: 'no-store' }),
  createMedicationPlan: (patientId: string, payload: Record<string, unknown>) => request<Row>(`/app/patients/${encodeURIComponent(patientId)}/medication-plans`, json('POST', payload)),
};

export const arr = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
export const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
export const val = (row: Row, ...keys: string[]): unknown => { for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key]; return null; };
export const label = (row: Row, ...keys: string[]): string => str(val(row, ...keys), '');
export function localDay(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export const niceDate = (v: unknown, fallback = 'Date not provided') => {
  const s = str(v); if (!s) return fallback;
  const d = new Date(s); if (Number.isNaN(d.valueOf())) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return d.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
