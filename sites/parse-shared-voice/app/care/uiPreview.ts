import type { Dashboard, Session } from './api';

export const uiPreview = false;
export const previewOnlyMessage = 'Preview only. Changes are not saved.';

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const time = (offset: number, hour: number) => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00+08:00`;
const patient = {
  id: 'sample-patient', name: 'Maya Tan', preferred_name: 'Maya', timezone: 'Asia/Singapore',
  language: 'en', daily_check_in_enabled: true, daily_check_in_local_time: '09:00', calling_route: null,
};

export function previewSession(): Session {
  return { user: { id: 'sample-caregiver', name: 'Alex Tan', email: 'sample@example.invalid', role: 'caregiver' }, patients: [patient], csrf_token: '' };
}

/** Fresh in-memory fixture on every read. It contains no real patient or service data. */
export function previewDashboard(): Dashboard {
  const note = { id: 'sample-note', wording: 'Enjoyed a short walk in the garden and felt comfortable afterward.', confirmed_at: time(-1, 17), occurred_at: time(-1, 16), version: 1, source: 'Caregiver report' };
  const reading = { id: 'sample-reading', systolic: 122, diastolic: 78, unit: 'mmHg', occurred_at: time(-2, 9), created_at: time(-2, 9), source_description: 'Home monitor', reporting_actor: 'caregiver', version: 1 };
  return {
    patient: { ...patient },
    permissions: ['read:dashboard', 'write:care', 'manage:sharing', 'manage:profile'],
    devices: [], active_companion: null,
    device_setup: { service_address: null, voice_service: 'unconfigured', live_voice_verified: false, scheduler_enabled: false },
    medication_plans: [{ id: 'sample-plan', active: true, version: 1, timezone: patient.timezone, source: 'Entered medication plan', medicines: [{ id: 'sample-medicine', name: 'Daily medicine', instructions: 'One tablet after breakfast' }], schedule: [{ medicine_id: 'sample-medicine', local_time: '09:00' }] }],
    doses: [
      { id: 'sample-dose-1', medicine_id:'sample-medicine', medicine_name: 'Daily medicine', instructions: 'One tablet after breakfast', plan_version: 1, scheduled_at: time(0, 9), report_time: time(0, 9), report_state: 'reported_taken' },
      { id: 'sample-dose-2', medicine_id:'sample-medicine', medicine_name: 'Daily medicine', instructions: 'One tablet after breakfast', plan_version: 1, scheduled_at: time(1, 9), report_state: 'unconfirmed' },
    ],
    notes: [note],
    measurements: [reading, { id: 'sample-reading-older', systolic: 119, diastolic: 76, unit: 'mmHg', occurred_at: time(-5, 9), created_at: time(-5, 9), source_description: 'Home monitor', reporting_actor: 'caregiver', version: 1 }],
    preventive_tasks: [{ id: 'sample-task', task_type: 'Follow-up visit', description: 'Review the care plan at a routine appointment.', state: 'arranged', due_date: day(14), appointment_date: day(14), source: 'Entered care plan', version: 1 }],
    support_requests: [{ id: 'sample-request', request_text: 'Could someone help arrange a ride to the appointment?', status: 'open', created_at: time(-1, 11), requester_name: patient.name, recipient_name: 'Alex Tan', recipient_user_id: 'sample-caregiver', version: 1 }],
    followups: [{ id: 'sample-followup', description: 'Check that transport is arranged', related_type: 'support_request', check_at: time(7, 10), resolution_state: 'open', version: 1 }],
    proposals: [],
    access_grants: [{ id: 'sample-grant', relationship: 'family', user: { id: 'sample-caregiver', name: 'Alex Tan', email: 'sample@example.invalid' }, scopes: ['read:dashboard', 'read:notes'] }],
    allowed_recipients: [{ id: 'sample-caregiver', name: 'Alex Tan', relationship: 'family' }],
    summaries: [{ id: 'sample-summary', start_date: day(-7), end_date: day(0), reviewed: true, status: 'reviewed', sections: [{ title: 'Recent care', items: [{ text: 'Maya enjoyed a short walk in the garden.', source_id: 'sample-note' }, { text: 'A blood pressure reading was reported.', source_id: 'sample-reading' }] }], sources: [{ id: 'sample-note', type: 'Care note', version: 1 }, { id: 'sample-reading', type: 'Blood pressure reading', version: 1 }] }],
  };
}
