import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CareActionInbox } from '../CareActionInbox';
import { buildCareActions } from '../careActions';
import type { Dashboard } from '../api';
import App from '../App';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const patient = { id: 'patient-1', name: 'Fictional Patient', timezone: 'Asia/Singapore' };
const session = { user: { id: 'viewer', name: 'Caregiver', email: 'caregiver@example.invalid', role: 'caregiver' }, patients: [patient], csrf_token: 'fixture' };
const data: Dashboard = { patient, devices: [], medication_plans: [], doses: [], notes: [], measurements: [], preventive_tasks: [], support_requests: [], followups: [], proposals: [], permissions: ['read:dashboard', 'ack:support'], access_grants: [], allowed_recipients: [], summaries: [] };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

it('has a useful empty state and no action buttons when no authorized rows exist', () => {
  render(<CareActionInbox items={buildCareActions(data, 'viewer', Date.now())} onOpen={vi.fn()}/>);
  expect(screen.getByRole('status').textContent).toMatch(/Nothing needs attention/);
  expect(screen.getByLabelText('0 permitted items')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

it('shows one source-specific button per row without granting read-only review or another recipient acknowledgement', () => {
  const onOpen = vi.fn();
  const items = buildCareActions({ ...data, proposals: [{ id: 'proposal', kind: 'health_note', payload: {}, readback: 'Private check', status: 'pending' }],
    support_requests: [{ id: 'request', recipient_user_id: 'other', status: 'open', request_text: 'Please help' }] }, 'viewer', Date.now());
  render(<CareActionInbox items={items} onOpen={onOpen}/>);
  expect(screen.getByLabelText('2 permitted items')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Review / })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Acknowledge / })).toBeNull();
  expect(screen.getByText('Review unavailable for this account')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open Support request: Please help' }));
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'support_request:request', action: 'open' }));
});

it('opens the exact support source and moves keyboard focus there', async () => {
  const withRequest = { ...data, support_requests: [{ id: 'request-1', recipient_user_id: 'viewer', status: 'open', request_text: 'Please help arrange a visit' }] };
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/auth/') ? json(session) : json(withRequest)));
  render(<App/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading', { name: /care timeline/i });
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open request Support request: Please help arrange a visit' }));
  await waitFor(() => expect(document.activeElement?.getAttribute('data-action-source')).toBe('support_request:request-1'));
  expect(screen.getByRole('heading', { name: 'Care' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy(); // source permission and recipient still govern writes
});

it.each([
  { key: 'followup:follow-1', patch: { followups: [{ id: 'follow-1', description: 'Check the appointment', resolution_state: 'open', check_at: '2026-11-01T02:00:00Z' }] }, button: 'Open Follow-up: Check the appointment' },
  { key: 'preventive_task:task-1', patch: { preventive_tasks: [{ id: 'task-1', description: 'Review care plan', state: 'due', due_date: '2026-11-01' }] }, button: 'Open Care-plan task: Review care plan' },
  { key: 'proposal:proposal-1', patch: { proposals: [{ id: 'proposal-1', kind: 'health_note', readback: 'Check old note', payload: {}, status: 'pending', expires_at: '2020-01-01T00:00:00Z' }] }, button: 'Open Proposal: Check old note' },
])('focuses $key when opening its source view', async ({ key, patch, button }) => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/auth/') ? json(session) : json({ ...data, ...patch })));
  render(<App/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading', { name: /care timeline/i });
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  fireEvent.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect(document.activeElement?.getAttribute('data-action-source')).toBe(key));
});

it('opens a permitted proposal in its existing review dialog', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/auth/') ? json(session) : json({ ...data, permissions: ['write:care'], proposals: [{ id: 'proposal-1', kind: 'health_note', readback: 'Check this note', payload: { wording: 'Fictional note' }, status: 'pending' }] })));
  render(<App/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading', { name: /care timeline/i });
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review Proposal: Check this note' }));
  const dialog = screen.getByRole('dialog', { name: 'Review before confirming' });
  expect(document.activeElement).toBe(dialog);
});

it('removes the previous care space immediately on patient switch and ignores its late refresh', async () => {
  const second = { id: 'patient-2', name: 'Second Patient', timezone: 'Asia/Singapore' };
  let finishOld!: (value: Response) => void;
  let oldCalls = 0;
  const firstData = { ...data, support_requests: [{ id: 'old', recipient_user_id: 'viewer', status: 'open', request_text: 'Old private request' }] };
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/')) return json({ ...session, patients: [patient, second] });
    if (url.includes('patient-2')) return json({ ...data, patient: second });
    oldCalls++;
    return oldCalls === 1 ? json(firstData) : new Promise<Response>(resolve => { finishOld = resolve; });
  }));
  render(<App/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading', { name: /care timeline/i });
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(screen.getAllByText('Old private request').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh care data' }));
  fireEvent.change(screen.getByLabelText('Choose patient profile'), { target: { value: 'patient-2' } });
  await screen.findByText('Nothing needs attention in this care space right now.');
  finishOld(json(firstData));
  await waitFor(() => expect(screen.queryAllByText('Old private request')).toHaveLength(0));
  expect(screen.getByLabelText('0 permitted items')).toBeTruthy();
});

it('rejects an old A response after switching A to B and back to A', async () => {
  const second = { id: 'patient-2', name: 'Second Patient', timezone: 'Asia/Singapore' };
  let finishOld!: (value: Response) => void;
  let aCalls = 0;
  const staleA = { ...data, support_requests: [{ id: 'stale', recipient_user_id: 'viewer', status: 'open', request_text: 'Stale A request' }] };
  const freshA = { ...data, support_requests: [{ id: 'fresh', recipient_user_id: 'viewer', status: 'open', request_text: 'Fresh A request' }] };
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/')) return json({ ...session, patients: [patient, second] });
    if (url.includes('patient-2')) return json({ ...data, patient: second });
    aCalls++;
    if (aCalls === 2) return new Promise<Response>(resolve => { finishOld = resolve; });
    return json(aCalls === 1 ? staleA : freshA);
  }));
  render(<App/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading', { name: /care timeline/i });
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh care data' }));
  fireEvent.change(screen.getByLabelText('Choose patient profile'), { target: { value: 'patient-2' } });
  await screen.findByText('Nothing needs attention in this care space right now.');
  fireEvent.change(screen.getByLabelText('Choose patient profile'), { target: { value: 'patient-1' } });
  await screen.findByRole('button', { name: 'Open request Support request: Fresh A request' });
  await act(async () => { finishOld(json(staleA)); });
  expect(screen.getByLabelText('1 permitted items')).toBeTruthy();
  expect(screen.queryAllByText('Stale A request')).toHaveLength(0);
});

it('keeps a newer same-patient dashboard when an older refresh completes last', async () => {
  let finishOld!: (value: Response) => void;
  let calls = 0;
  const stale = { ...data, support_requests: [{ id: 'stale', recipient_user_id: 'viewer', status: 'open', request_text: 'Stale request' }] };
  const fresh = { ...data, support_requests: [{ id: 'fresh', recipient_user_id: 'viewer', status: 'open', request_text: 'Fresh request' }] };
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/auth/')) return json(session);
    calls++;
    if (calls === 2) return new Promise<Response>(resolve => { finishOld = resolve; });
    return json(calls === 1 ? stale : fresh);
  }));
  render(<App/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading', { name: /care timeline/i });
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh care data' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh care data' }));
  await screen.findByRole('button', { name: 'Open request Support request: Fresh request' });
  await act(async () => { finishOld(json(stale)); });
  expect(screen.getByLabelText('1 permitted items')).toBeTruthy();
  expect(screen.queryAllByText('Stale request')).toHaveLength(0);
});

it('sends only one acknowledgement while repeated source clicks are pending', async () => {
  let finish!: (value: Response) => void;
  let posts = 0;
  const withRequest = { ...data, support_requests: [{ id: 'request-1', recipient_user_id: 'viewer', status: 'open', request_text: 'Please help arrange a visit' }] };
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.includes('/auth/')) return json(session);
    if (url.includes('/acknowledge') && options?.method === 'POST') { posts++; return new Promise<Response>(resolve => { finish = resolve; }); }
    return json(withRequest);
  }));
  render(<App/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading', { name: /care timeline/i });
  fireEvent.click(screen.getByRole('button', { name: 'Care' }));
  fireEvent.click(screen.getByRole('button', { name: /Requests & follow-ups/ }));
  const button = screen.getByRole('button', { name: 'Acknowledge' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(posts).toBe(1);
  finish(json({ status: 'acknowledged' }));
  await screen.findByText('Request acknowledged.');
});

it('does not let an old mutation callback repopulate the same care space after A to B to A', async () => {
  const second = { id: 'patient-2', name: 'Second Patient', timezone: 'Asia/Singapore' };
  let finishAck!: (value: Response) => void;
  let aReads = 0;
  const oldA = { ...data, support_requests: [{ id: 'old', recipient_user_id: 'viewer', status: 'open', request_text: 'Old assignment' }] };
  const freshA = { ...data, support_requests: [{ id: 'fresh', recipient_user_id: 'viewer', status: 'open', request_text: 'Fresh assignment' }] };
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.includes('/auth/')) return json({ ...session, patients: [patient, second] });
    if (url.includes('/acknowledge') && options?.method === 'POST') return new Promise<Response>(resolve => { finishAck = resolve; });
    if (url.includes('patient-2')) return json({ ...data, patient: second });
    aReads++;
    return json(aReads === 1 ? oldA : freshA);
  }));
  render(<App/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading', { name: /care timeline/i });
  fireEvent.click(screen.getByRole('button', { name: 'Care' }));
  fireEvent.click(screen.getByRole('button', { name: /Requests & follow-ups/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  fireEvent.change(screen.getByLabelText('Choose patient profile'), { target: { value: 'patient-2' } });
  await screen.findByRole('heading', { name: 'Care' });
  fireEvent.change(screen.getByLabelText('Choose patient profile'), { target: { value: 'patient-1' } });
  await screen.findByText('Fresh assignment');
  await act(async () => { finishAck(json({ status: 'acknowledged' })); });
  expect(screen.queryByText('Request acknowledged.')).toBeNull();
  expect(screen.queryAllByText('Old assignment')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(screen.getByLabelText('1 permitted items')).toBeTruthy();
});
