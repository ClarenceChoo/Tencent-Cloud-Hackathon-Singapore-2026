import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows confirmed medication reports by report time without inventing reports for scheduled doses', async () => {
  const patient = { id: 'patient-1', name: 'Fictional Mei', timezone: 'Asia/Singapore' };
  const session = { user: { id: 'owner', name: 'Fictional owner', role: 'owner' }, patients: [patient], csrf_token: 'test' };
  const dashboard = {
    patient, devices: [], medication_plans: [], notes: [], measurements: [], preventive_tasks: [],
    support_requests: [], followups: [], proposals: [], permissions: ['*'], access_grants: [],
    allowed_recipients: [], summaries: [],
    doses: [
      { id: 'future', medicine_name: 'Unreported future medicine', scheduled_at: '2030-01-10T00:00:00Z', report_state: 'unconfirmed', report_time: null },
      { id: 'older', medicine_name: 'Earlier report', scheduled_at: '2030-01-09T00:00:00Z', report_state: 'reported_not_yet', report_time: '2026-01-01T00:00:00Z' },
      { id: 'newer', medicine_name: 'Later report', scheduled_at: '2026-01-01T00:00:00Z', report_state: 'reported_taken', report_time: '2026-01-02T00:00:00Z' },
    ],
  };
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith('/auth/session') ? session : dashboard), { headers: { 'Content-Type': 'application/json' } })));
  render(<App />);
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: /care, together/i });
  await user.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: /^Timeline$/ }));
  expect(screen.queryByText(/Unreported future medicine/)).toBeNull();
  const headings = screen.getAllByRole('heading', { level: 3 }).map(node => node.textContent);
  expect(headings).toEqual(['Later report · Reported Taken', 'Earlier report · Reported Not Yet']);
});
