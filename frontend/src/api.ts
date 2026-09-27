export type User = { id: string; name: string; email: string; role: string };
export type Patient = { id: string; name: string; timezone: string; preferred_name?: string; language?: string; daily_check_in_enabled?: boolean; daily_check_in_local_time?: string | null; calling_route?: string | null };
export type Session = { user: User; patients: Patient[]; csrf_token: string };
export type Proposal = { id: string; kind: string; payload: Record<string, unknown>; readback: string; status: string; expires_at?: string };
export type Row = Record<string, unknown> & { id?: string };
export type DeviceSetupStatus = {
  service_address: string | null;
  voice_service: 'unconfigured' | 'configured' | 'simulated' | 'invalid_configuration';
  live_voice_verified: boolean;
  scheduler_enabled: boolean;
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
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(`/v1${path}`, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      const detail = data.detail ?? data.message;
      if (typeof detail === 'string') message = detail;
      else if (Array.isArray(detail)) message = detail.map(item => {
        const location = Array.isArray(item?.loc) ? item.loc.filter((part: unknown) => part !== 'body').join(' → ') : '';
        const reason = typeof item?.msg === 'string' ? item.msg : JSON.stringify(item);
        return location ? `${location}: ${reason}` : reason;
      }).join('; ');
      else if (detail != null) message = JSON.stringify(detail);
    } catch { /* response had no JSON body */ }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const api = {
  login: (email: string, password: string) => request<Session>('/auth/login', json('POST', { email, password })),
  session: () => request<Session>('/auth/session'),
  logout: () => request<void>('/auth/logout', json('POST')),
  dashboard: (patientId: string) => request<Dashboard>(`/app/patients/${encodeURIComponent(patientId)}/dashboard`),
  updateProfile: (patientId: string, payload: Record<string, unknown>) => request<Row>(`/app/patients/${encodeURIComponent(patientId)}/profile`, json('PUT', payload)),
  createProposal: (patientId: string, kind: string, payload: Record<string, unknown>) => request<Proposal>(`/app/patients/${encodeURIComponent(patientId)}/proposals`, json('POST', { kind, payload })),
  reviseProposal: (id: string, payload: Record<string, unknown>) => request<Proposal>(`/app/proposals/${encodeURIComponent(id)}/revise`, json('POST', { payload })),
  confirmProposal: (id: string) => request<{ status: string; record_type: string; record_id: string }>(`/app/proposals/${encodeURIComponent(id)}/confirm`, json('POST', { confirmed: true })),
  acknowledge: (id: string) => request<void>(`/app/support-requests/${encodeURIComponent(id)}/acknowledge`, json('POST')),
  resolve: (id: string, outcome: string) => request<void>(`/app/support-requests/${encodeURIComponent(id)}/resolve`, json('POST', { outcome })),
  claimDevice: (code: string, patientId: string) => request<Row>('/app/devices/claim', json('POST', { code, patient_id: patientId })),
  approvePhone: (code: string, patientId: string) => request<Row>('/app/phone-enrollments/approve', json('POST', { code, patient_id: patientId })),
  selectCompanion: (patientId:string, deviceId:string|null, generation:number, poweredOff:boolean) => request(`/app/patients/${encodeURIComponent(patientId)}/active-companion`, json('PUT', {device_id:deviceId, expected_generation:generation, other_pendants_powered_off:poweredOff})),
  revokeDevice: (id: string) => request<void>(`/app/devices/${encodeURIComponent(id)}/revoke`, json('POST')),
  createSummary: (patientId: string, startDate: string, endDate: string) => request<Row>(`/app/patients/${encodeURIComponent(patientId)}/summaries`, json('POST', { start_date: startDate, end_date: endDate })),
  updateSummary: (id: string, payload: Record<string, unknown>) => request<Row>(`/app/summaries/${encodeURIComponent(id)}`, json('PUT', payload)),
  shareSummary: (id: string) => request<Row>(`/app/summaries/${encodeURIComponent(id)}/share`, json('POST', { expires_in_seconds: 3600 })),
  revokeSummaryShare: (id: string) => request<void>(`/app/summaries/${encodeURIComponent(id)}/revoke`, json('POST')),
  grant: (patientId: string, userId: string, scopes: string[]) => request<Row>(`/app/patients/${encodeURIComponent(patientId)}/grants`, json('POST', { user_id: userId, scopes, expires_at: null })),
  revokeGrant: (id: string) => request<void>(`/app/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setNoteSharing: (noteId: string, userIds: string[]) => request<Row>(`/app/notes/${encodeURIComponent(noteId)}/sharing`, { method: 'PUT', body: JSON.stringify({ user_ids: userIds }) }),
  deleteNote: (noteId: string) => request<void>(`/app/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' }),
  sharedSummary: (token: string) => request<Row>(`/shared/summaries/${encodeURIComponent(token)}`),
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
