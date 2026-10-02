import { expect, it } from 'vitest';
import { buildCareActions } from '../careActions';
import type { Dashboard } from '../api';

const now = Date.parse('2026-10-01T16:30:00Z'); // October 2 in Singapore
const data = (patch: Partial<Dashboard> = {}): Dashboard => ({
  patient: { id: 'patient', name: 'Patient', timezone: 'Asia/Singapore' }, devices: [], medication_plans: [], doses: [], notes: [], measurements: [],
  preventive_tasks: [], support_requests: [], followups: [], proposals: [], permissions: ['write:care', 'ack:support'], access_grants: [], allowed_recipients: [], summaries: [], ...patch,
});

it('keeps overlapping IDs from separate sources and excludes unreported doses', () => {
  const dashboard = data({
    doses: [{ id: 'same', report_state: 'unconfirmed', scheduled_at: '2026-10-01T02:00:00Z' }],
    proposals: [{ id: 'same', kind: 'health_note', payload: {}, readback: 'Check note', status: 'pending' }],
    support_requests: [{ id: 'same', request_text: 'Please call', status: 'open', recipient_user_id: 'viewer' }],
    followups: [{ id: 'same', description: 'Check again', resolution_state: 'open' }],
    preventive_tasks: [{ id: 'same', description: 'Care task', state: 'due', due_date: '2026-10-02' }],
  });
  expect(buildCareActions(dashboard, 'viewer', now).map(item => item.key)).toEqual([
    'proposal:same', 'support_request:same', 'preventive_task:same', 'followup:same',
  ]);
});

it('uses the patient-local date for date-only tasks around midnight', () => {
  const dashboard = data({ preventive_tasks: [
    { id: 'later', state: 'planned', due_date: '2026-10-03' },
    { id: 'today', state: 'due', due_date: '2026-10-02' },
    { id: 'earlier', state: 'due', due_date: '2026-10-01' },
  ] });
  const items = buildCareActions(dashboard, 'viewer', now);
  expect(items.map(item => item.sourceId)).toEqual(['earlier', 'today', 'later']);
  expect(items[1].dateOnly).toBe('2026-10-02');
  expect(items.map(item => item.overdue)).toEqual([true, false, false]);
});

it('makes read-only and non-recipient records navigation-only, and expired proposals unconfirmable', () => {
  const dashboard = data({
    permissions: ['read:dashboard'],
    proposals: [{ id: 'expired', kind: 'health_note', payload: {}, readback: 'Old note', status: 'pending', expires_at: '2026-10-01T00:00:00Z' }],
    support_requests: [{ id: 'someone-else', status: 'open', recipient_user_id: 'other', request_text: 'Private assignment' }],
    followups: [{ id: 'f', resolution_state: 'open' }],
  });
  expect(buildCareActions(dashboard, 'viewer', now).map(item => item.action)).toEqual(['open', 'open', 'open']);
});

it('drops completed and unsupported records and sorts undated items after known dates', () => {
  const dashboard = data({
    proposals: [{ id: 'done', kind: 'health_note', payload: {}, readback: '', status: 'committed' }],
    support_requests: [{ id: 'resolved', status: 'resolved', recipient_user_id: 'viewer' }],
    followups: [{ id: 'resolved', resolution_state: 'resolved' }, { id: 'unknown', resolution_state: 'open' }, { id: 'soon', resolution_state: 'open', check_at: '2026-10-02T00:00:00Z' }],
    preventive_tasks: [{ id: 'completed', state: 'completed' }, { id: 'undated', state: 'planned' }],
  });
  expect(buildCareActions(dashboard, 'viewer', now).map(item => item.key)).toEqual(['followup:soon', 'followup:unknown', 'preventive_task:undated']);
});
