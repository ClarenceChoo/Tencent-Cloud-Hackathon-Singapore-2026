import type { ActivityFilters, ActivityItem, ActivityPage, Dashboard, Session } from './api';

export const uiPreview = import.meta.env.VITE_UI_PREVIEW === 'true';
export const previewOnlyMessage = 'UI demo only: fictional sample data. This action is not saved or shared.';

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const time = (offset: number, hour: number) => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00+08:00`;
const patient = {
  id: 'sample-patient', name: 'Maya Tan (sample)', preferred_name: 'Maya', timezone: 'Asia/Singapore',
  language: 'en', daily_check_in_enabled: true, daily_check_in_local_time: '09:00', calling_route: null,
};

export function previewSession(): Session {
  return { user: { id: 'sample-caregiver', name: 'Alex Tan (sample)', email: 'sample@example.invalid', role: 'caregiver' }, patients: [patient], csrf_token: '' };
}

export function previewActivity(filters: ActivityFilters): ActivityPage {
  const items: ActivityItem[] = [
    { id: 'sample-log-note', record_id: 'sample-note', recorded_at: time(-1, 17), event: 'Care note confirmed', category: 'notes', summary: 'Enjoyed a short walk in the garden and felt comfortable afterward.', status: 'confirmed', source: 'Sample care dashboard' },
    { id: 'sample-log-dose', record_id: 'sample-dose-1', recorded_at: time(0, 9), event: 'Medication report confirmed', category: 'medications', summary: 'Sample daily medicine: reported taken.', status: 'confirmed', source: 'Sample care dashboard' },
    { id: 'sample-log-request', record_id: 'sample-request', recorded_at: time(-1, 11), event: 'Support request confirmed', category: 'support', summary: 'Could someone help arrange a ride to the appointment?', status: 'confirmed', source: 'Sample care dashboard' },
    { id: 'sample-log-reading', record_id: 'sample-reading', recorded_at: time(-2, 9), event: 'Blood-pressure reading confirmed', category: 'readings', summary: '122 / 78 mmHg, sample home monitor.', status: 'confirmed', source: 'Sample care dashboard' },
  ];
  const dateOf = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: patient.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  const search = (filters.search || '').toLowerCase();
  return { items: items.filter(item => (!filters.category || filters.category === 'all' || item.category === filters.category) &&
    (!filters.start || dateOf(item.recorded_at) >= filters.start) && (!filters.end || dateOf(item.recorded_at) <= filters.end) &&
    `${item.event} ${item.summary} ${item.source}`.toLowerCase().includes(search)).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at)),
    next_cursor: null, timezone: patient.timezone };
}

/** Fresh in-memory fixture on every read. It contains no real patient or service data. */
export function previewDashboard(): Dashboard {
  const note = { id: 'sample-note', wording: 'Enjoyed a short walk in the garden and felt comfortable afterward.', confirmed_at: time(-1, 17), occurred_at: time(-1, 16), version: 1, source: 'Sample caregiver report' };
  const reading = { id: 'sample-reading', systolic: 122, diastolic: 78, unit: 'mmHg', occurred_at: time(-2, 9), source_description: 'Sample home monitor', reporting_actor: 'caregiver', version: 1 };
  return {
    patient: { ...patient },
    permissions: ['read:dashboard', 'write:care', 'manage:sharing', 'manage:profile'],
    devices: [], active_companion: null,
    device_setup: { service_address: null, voice_service: 'unconfigured', live_voice_verified: false, scheduler_enabled: false },
    medication_plans: [{ id: 'sample-plan', active: true, version: 1, timezone: patient.timezone, source: 'Fictional sample plan', medicines: [{ id: 'sample-medicine', name: 'Sample daily medicine', instructions: 'One tablet after breakfast (fictional example)' }], schedule: [{ medicine_id: 'sample-medicine', local_time: '09:00' }] }],
    doses: [
      { id: 'sample-dose-1', medicine_name: 'Sample daily medicine', instructions: 'One tablet after breakfast (fictional example)', plan_version: 1, scheduled_at: time(0, 9), report_time: time(0, 9), report_state: 'reported_taken' },
      { id: 'sample-dose-2', medicine_name: 'Sample daily medicine', instructions: 'One tablet after breakfast (fictional example)', plan_version: 1, scheduled_at: time(1, 9), report_state: 'unconfirmed' },
    ],
    notes: [note],
    measurements: [reading, { id: 'sample-reading-older', systolic: 119, diastolic: 76, unit: 'mmHg', occurred_at: time(-5, 9), source_description: 'Sample home monitor', reporting_actor: 'caregiver', version: 1 }],
    preventive_tasks: [{ id: 'sample-task', task_type: 'Follow-up visit', description: 'Review the care plan at a routine appointment.', state: 'arranged', due_date: day(14), appointment_date: day(14), source: 'Fictional care plan', version: 1 }],
    support_requests: [{ id: 'sample-request', request_text: 'Could someone help arrange a ride to the appointment?', status: 'open', created_at: time(-1, 11), requester_name: patient.name, recipient_name: 'Alex Tan (sample)', recipient_user_id: 'sample-caregiver', version: 1 }],
    followups: [{ id: 'sample-followup', description: 'Check that transport is arranged', related_type: 'support_request', check_at: time(7, 10), resolution_state: 'open', version: 1 }],
    proposals: [],
    access_grants: [{ id: 'sample-grant', relationship: 'family', user: { id: 'sample-caregiver', name: 'Alex Tan (sample)', email: 'sample@example.invalid' }, scopes: ['read:dashboard', 'read:notes'] }],
    allowed_recipients: [{ id: 'sample-caregiver', name: 'Alex Tan (sample)', relationship: 'family' }],
    summaries: [{ id: 'sample-summary', start_date: day(-7), end_date: day(0), reviewed: true, status: 'reviewed', sections: [{ title: 'Recent care', items: [{ text: 'Maya enjoyed a short walk in the garden.', source_id: 'sample-note' }, { text: 'A sample blood pressure reading was reported.', source_id: 'sample-reading' }] }], sources: [{ id: 'sample-note', type: 'Care note', version: 1 }, { id: 'sample-reading', type: 'Blood pressure reading', version: 1 }] }],
  };
}
