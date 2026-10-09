import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AskParse } from '../AskParse';
import App from '../App';
import type { Dashboard } from '../api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const answer = (kind: string, items: unknown[], truncated = false) => ({
  kind, generated_at: '2026-05-02T00:00:00Z', timezone: 'Asia/Singapore',
  date_basis: kind === 'medication_reports' ? 'scheduled_local_date' : 'recorded_at',
  local_date: kind === 'medication_reports' ? '2026-05-01' : null, items, truncated,
});
const reading = { source_type: 'measurement', source_id: 'reading-1', source_version: 1,
  recorded_at: '2026-05-01T00:00:00Z', occurred_at: null, systolic: 121, diastolic: 79,
  unit: 'mmHg', source_description: 'Fictional cuff' };

it('offers only three presets and requires a scheduled date for medicines', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _options?: RequestInit) => json(answer('medication_reports', [])));
  vi.stubGlobal('fetch', fetcher);
  render(<AskParse patientId="patient-a" timezone="Asia/Singapore"/>);
  const question = screen.getByLabelText('Question') as HTMLSelectElement;
  expect(question.options).toHaveLength(3);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.change(question, { target: { value: 'medication_reports' } });
  const date = screen.getByLabelText('Scheduled date in Asia/Singapore') as HTMLInputElement;
  fireEvent.change(date, { target: { value: '2026-05-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('No doses are scheduled for this date in the records you can view.');
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ kind: 'medication_reports', local_date: '2026-05-01' });
  expect(screen.getByText('Scheduled on 2026-05-01 in Asia/Singapore.')).toBeTruthy();
});

it('keeps forbidden, empty, unknown occurrence, and truncated results distinct', async () => {
  let status = 403;
  vi.stubGlobal('fetch', vi.fn(async () => status === 403 ? json({ detail: 'forbidden' }, 403) :
    json(answer('latest_reading', status === 204 ? [] : [reading], status === 206))));
  render(<AskParse patientId="patient-a" timezone="Asia/Singapore"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('You do not have permission to view this category.');
  expect(screen.queryByText(/No confirmed blood-pressure/)).toBeNull();
  status = 204;
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('No confirmed blood-pressure reading is available to you.');
  status = 206;
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('Occurred: Unknown');
  expect(screen.getByText(/Showing the first 50 permitted results/)).toBeTruthy();
});

it('revalidates source details and shows changed or unavailable evidence', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes('query-sources') ?
    json({ ...reading, systolic: 119, diastolic: 77 }) : json(answer('latest_reading', [reading])));
  vi.stubGlobal('fetch', fetcher);
  const onOpenSource = vi.fn();
  render(<AskParse patientId="patient-a" timezone="Asia/Singapore" onOpenSource={onOpenSource}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('121/79 mmHg');
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  await screen.findByText('119/77 mmHg');
  expect(screen.queryByText('121/79 mmHg')).toBeNull();
  expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ systolic: 119 }));
  expect(fetcher.mock.calls.some(call => String(call[0]).includes('/query-sources/measurement/reading-1'))).toBe(true);
  fetcher.mockImplementation(async (input: RequestInfo | URL) => String(input).includes('query-sources') ?
    json({ detail: 'missing' }, 404) : json(answer('latest_reading', [reading])));
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('121/79 mmHg');
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  await screen.findByText(/source is no longer available here/);
  expect(screen.queryByLabelText('Current source detail')).toBeNull();
  expect(screen.queryByText('121/79 mmHg')).toBeNull();
});

it('clears answer facts when source category access is revoked', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('query-sources') ?
    json({ detail: 'forbidden' }, 403) : json(answer('latest_reading', [reading]))));
  render(<AskParse patientId="patient-a" timezone="Asia/Singapore"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('121/79 mmHg');
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  await screen.findByText('Access to this category was removed.');
  expect(screen.queryByText('121/79 mmHg')).toBeNull();
  expect(screen.queryByText('1 source shown.')).toBeNull();
});

it('expires the active session on a source 401 without showing old facts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('query-sources') ?
    json({ detail: 'expired' }, 401) : json(answer('latest_reading', [reading]))));
  const onSessionExpired = vi.fn();
  render(<AskParse patientId="patient-a" timezone="Asia/Singapore" onSessionExpired={onSessionExpired}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('121/79 mmHg');
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  await screen.findByText('Your session has expired. Sign in again.');
  expect(onSessionExpired).toHaveBeenCalledOnce();
  expect(screen.queryByText('121/79 mmHg')).toBeNull();
});

it('discards a late answer and source after patient or session changes', async () => {
  let finishA!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('patient-a')) return new Promise<Response>(resolve => { finishA = resolve; });
    return Promise.resolve(json(answer('latest_reading', [])));
  }));
  const { rerender } = render(<AskParse patientId="patient-a" timezone="Asia/Singapore" sessionKey="session-1"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  rerender(<AskParse patientId="patient-b" timezone="Asia/Singapore" sessionKey="session-1"/>);
  finishA(json(answer('latest_reading', [reading])));
  await waitFor(() => expect(screen.queryByText('121/79 mmHg')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('No confirmed blood-pressure reading is available to you.');
  rerender(<AskParse patientId="patient-a" timezone="Asia/Singapore" sessionKey="session-2"/>);
  expect(screen.queryByText('No confirmed blood-pressure reading is available to you.')).toBeNull();
});

it('discards a late source after switching patients', async () => {
  let finishSource!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).includes('query-sources') ?
    new Promise<Response>(resolve => { finishSource = resolve; }) :
    Promise.resolve(json(answer('latest_reading', [reading])))));
  const { rerender } = render(<AskParse patientId="patient-a" timezone="Asia/Singapore"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('121/79 mmHg');
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  rerender(<AskParse patientId="patient-b" timezone="Asia/Singapore"/>);
  finishSource(json({ ...reading, systolic: 999 }));
  await waitFor(() => expect(screen.queryByText('999/79 mmHg')).toBeNull());
  expect(screen.queryByLabelText('Current source detail')).toBeNull();
});

it('clears a visible answer when refreshed evidence or permissions change', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(answer('latest_reading', [reading]))));
  const { rerender } = render(<AskParse patientId="patient-a" timezone="Asia/Singapore" evidenceRevision="revision-1"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('121/79 mmHg');
  rerender(<AskParse patientId="patient-a" timezone="Asia/Singapore" evidenceRevision="revision-2"/>);
  await waitFor(() => expect(screen.queryByText('121/79 mmHg')).toBeNull());
  expect(screen.queryByText('1 source shown.')).toBeNull();
});

it('uses fictional preview results without any network request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<AskParse patientId="sample-patient" timezone="Asia/Singapore" preview/>);
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('122/78 mmHg');
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  await screen.findByText('Fictional source');
  expect(fetcher).not.toHaveBeenCalled();
});

it('opens a freshly revalidated reading in the existing timeline and focuses its row', async () => {
  const patient = { id: 'patient-a', name: 'Fictional Patient', timezone: 'Asia/Singapore' };
  const session = { user: { id: 'viewer', name: 'Owner', email: 'owner@example.invalid', role: 'owner' },
    patients: [patient], csrf_token: 'session-token' };
  const dashboard: Dashboard = { patient, devices: [], medication_plans: [], doses: [], notes: [],
    measurements: [{ id: 'reading-1', measurement_type: 'blood_pressure', systolic: 121,
      diastolic: 79, unit: 'mmHg', created_at: '2026-05-01T00:00:00Z', occurred_at: null }],
    preventive_tasks: [], support_requests: [], followups: [], proposals: [], permissions: ['*'],
    access_grants: [], allowed_recipients: [], summaries: [] };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/session')) return json(session);
    if (url.includes('/query-sources/')) return json(reading);
    if (url.endsWith('/queries')) return json(answer('latest_reading', [reading]));
    return json(dashboard);
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('scrollTo', vi.fn());
  render(<App/>);
  await screen.findByRole('heading', { name: 'Today’s care' });
  fireEvent.click(screen.getByRole('button', { name: 'Check records' }));
  fireEvent.click(screen.getByRole('button', { name: 'Find answer' }));
  await screen.findByText('121/79 mmHg');
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  await waitFor(() => expect(document.activeElement?.getAttribute('data-action-source')).toBe('measurement:reading-1'));
  expect(fetcher.mock.calls.some(call => String(call[0]).includes('/query-sources/measurement/reading-1'))).toBe(true);
  expect(fetcher.mock.calls.filter(call => String(call[0]).includes('/dashboard')).length).toBeGreaterThanOrEqual(2);
});
