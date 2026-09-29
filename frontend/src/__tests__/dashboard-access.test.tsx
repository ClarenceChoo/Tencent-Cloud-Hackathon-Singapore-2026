import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const patient = { id: 'p', name: 'Fictional Mei', timezone: 'Asia/Singapore' };
const session = { user: { id: 'caregiver', name: 'Fictional caregiver', role: 'caregiver' }, patients: [patient], csrf_token: 'fixture' };
const note = { id: 'note', wording: 'A previously shared phone note', created_at: '2026-09-27T01:00:00Z' };
const data = { patient, notes: [note], devices: [], medication_plans: [], doses: [], measurements: [], preventive_tasks: [], support_requests: [], followups: [], proposals: [], permissions: ['read:dashboard'], access_grants: [], allowed_recipients: [], summaries: [] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function setup() {
  let poll!: () => Promise<void>;
  let dashboard = async (): Promise<Response> => response(data);
  vi.spyOn(window, 'setInterval').mockImplementation((handler) => { poll = handler as typeof poll; return 99; });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/auth/') ? response(session) : dashboard()));
  render(<App/>);
  await screen.findByRole('heading', { name: note.wording });
  return { poll: () => act(async () => { await poll(); }), setDashboard: (next: typeof dashboard) => { dashboard = next; } };
}

it.each([401, 403])('clears an open care view on HTTP %s instead of retaining denied records', async status => {
  const app = await setup();
  app.setDashboard(async () => response({ detail: 'No longer authorized' }, status));
  await app.poll();
  expect(screen.getByRole('heading', { name: 'Sign in to your care space' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: note.wording })).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(status === 401 ? /session ended/ : /access.*changed/);
});

it('keeps the last confirmed view through a temporary failure, labels it and recovers', async () => {
  const app = await setup();
  app.setDashboard(async () => response({ detail: 'Temporary outage' }, 503));
  await app.poll();
  expect(screen.getByRole('heading', { name: note.wording })).toBeTruthy();
  expect(screen.getByText(/Showing the last loaded care information/)).toBeTruthy();
  app.setDashboard(async () => response({ ...data, notes: [] }));
  await app.poll();
  expect(screen.queryByRole('heading', { name: note.wording })).toBeNull();
  expect(screen.queryByText(/Showing the last loaded care information/)).toBeNull();
});

it('does not restore a late manual refresh after access loss and another sign-in', async () => {
  const app = await setup();
  let finish!: (value: Response) => void;
  app.setDashboard(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh care data' }));
  app.setDashboard(async () => response({ detail: 'Revoked' }, 403));
  await app.poll();
  app.setDashboard(async () => response({ ...data, notes: [] }));
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'another@careloop.invalid' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fictional-password' } });
  fireEvent.submit(screen.getByLabelText('Email address').closest('form')!);
  await screen.findByRole('heading', { name: /care timeline/i });
  await act(async () => { finish(response(data)); });
  expect(screen.queryByRole('heading', { name: note.wording })).toBeNull();
});
