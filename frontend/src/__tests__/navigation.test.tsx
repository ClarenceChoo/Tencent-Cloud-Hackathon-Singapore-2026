import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const patient = { id: 'p', name: 'Mei', timezone: 'Asia/Singapore' };
async function setup(permissions = ['*']) {
  const session = { user: { id: 'owner', name: 'Alex', role: 'owner' }, patients: [patient], csrf_token: 'fixture' };
  const dashboard = { patient, permissions, devices: [], access_grants: [], allowed_recipients: [], summaries: [],
    notes: [], measurements: [], doses: [], medication_plans: [], preventive_tasks: [], support_requests: [], followups: [], proposals: [] };
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes('/auth/') ? session : dashboard), { headers: { 'Content-Type': 'application/json' } })));
  render(<App/>);
  await screen.findByText('Nothing needs attention in this care space right now.');
}

it('has five primary destinations, separate settings, and quieter empty statistics', async () => {
  await setup();
  const nav = within(screen.getByRole('navigation', { name: 'Main navigation' }));
  expect(nav.getAllByRole('button').map(button => button.textContent)).toEqual(['Today', 'Timeline', 'Medications', 'Care', 'Log']);
  expect(nav.queryByRole('button', { name: 'Settings' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Companion connection: Connect' })).toBeTruthy();
  expect(screen.queryByText('Confirmed notes')).toBeNull();
  expect(screen.queryByText('Open support requests')).toBeNull();
  expect(screen.getByText('More care details').closest('details')?.open).toBe(false);
});

it('opens connection separately while Settings retains preferences and sharing', async () => {
  await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));
  fireEvent.click(screen.getByRole('button', { name: 'Companion connection: Connect' }));
  expect(screen.getByRole('heading', { name: 'Companion connection' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Pair your companion' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Reminder companion' })).toBeTruthy();
  expect(screen.queryByLabelText('Preferred name')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add entry' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Back to care space/ }));
  expect(screen.getByRole('heading', { name: 'Mei’s care timeline' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(screen.getByLabelText('Preferred name')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Pair your companion' })).toBeNull();
});

it('keeps connection setup read-only for caregivers', async () => {
  await setup(['read:dashboard']);
  fireEvent.click(screen.getByRole('button', { name: 'Companion connection: Connect' }));
  expect(screen.getByText('The care-space owner manages device pairing and access.')).toBeTruthy();
  expect(screen.queryByLabelText('One-use device code')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save reminder companion' })).toBeNull();
});

it('keeps record questions and summaries accessible as secondary actions', async () => {
  await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check records' }));
  expect(screen.getByRole('button', { name: 'Find answer' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Back to Today/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare summary' }));
  expect(screen.getByLabelText('Summary purpose')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Back to Timeline/ }));
  expect(screen.getByRole('heading', { name: 'Mei’s care timeline' })).toBeTruthy();
});

it('puts tasks and requests under Care without exposing summary management to a read-only caregiver', async () => {
  await setup(['read:dashboard']);
  fireEvent.click(screen.getByRole('button', { name: 'Care' }));
  expect(screen.getByRole('heading', { name: 'Preventive care and follow-ups' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Requests & follow-ups' }));
  expect(screen.getByRole('heading', { name: 'Follow up together' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Care' }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));
  expect(screen.queryByRole('button', { name: 'Prepare summary' })).toBeNull();
});
