import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';

const patient = { id: 'patient_1', name: 'Fictional Mei', timezone: 'Asia/Singapore' };
const session = { user: { id: 'owner_1', name: 'Owner', email: 'owner@example.invalid', role: 'owner' }, patients: [patient], csrf_token: 'fixture' };
const dashboard = { patient, permissions: ['manage:sharing', 'read:dashboard'], devices: [], medication_plans: [], doses: [], notes: [], measurements: [], preventive_tasks: [], support_requests: [], followups: [], proposals: [], access_grants: [], allowed_recipients: [], summaries: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const creates: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  let currentDashboard: Record<string, unknown> = dashboard;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return json(session);
    if (url.endsWith('/dashboard')) return json(currentDashboard);
    if (url.endsWith('/summaries') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); creates.push(body);
      return json({ id: `summary_${creates.length}`, patient_id: patient.id, start_date: body.start_date, end_date: body.end_date,
        purpose: body.purpose || 'doctor_visit', template_version: 1, status: 'draft', created_at: '2026-10-02T08:00:00Z',
        reviewed_at: null, invalidated_at: null, sources: [{ id: 'note_1', type: 'health_note', version: 1 }],
        sections: [{ title: 'Reported concerns in the selected period', items: [{ text: 'Fictional confirmed report', source_id: 'note_1' }] }],
        questions: (body.questions || []).map((text: string) => ({ text, author_display_name: 'Owner', authored_at: '2026-10-02T08:00:00Z' })) }, 201);
    }
    if (url.includes('/summaries/') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); reviews.push(body);
      return json({ id: url.split('/').at(-1), patient_id: patient.id, start_date: '2026-10-01', end_date: '2026-10-02',
        purpose: creates.at(-1)?.purpose || 'doctor_visit', template_version: 1, status: 'reviewed',
        created_at: '2026-10-02T08:00:00Z', reviewed_at: '2026-10-02T09:00:00Z', invalidated_at: null,
        sections: body.sections, sources: [{ id: 'note_1', type: 'health_note', version: 1 }],
        questions: (body.questions || []).map((text: string) => ({ text, author_display_name: 'Owner', authored_at: '2026-10-02T09:00:00Z' })) });
    }
    return json({ detail: 'Unexpected request' }, 404);
  });
  vi.stubGlobal('fetch', fetch); vi.stubGlobal('scrollTo', vi.fn());
  render(<App />);
  return { creates, reviews, setDashboard: (value: Record<string, unknown>) => { currentDashboard = value; } };
}

async function openSummary() {
  fireEvent.click(await screen.findByRole('button', { name: 'Visit summary' }));
  await screen.findByLabelText('Summary purpose');
}

it('creates a new purpose draft with questions that remain separate from reports', async () => {
  const calls = setup();
  await openSummary();
  fireEvent.change(screen.getByLabelText('Summary purpose'), { target: { value: 'family_handoff' } });
  fireEvent.change(screen.getByLabelText('Questions to discuss'), { target: { value: 'Was there an unrecorded fall?' } });
  fireEvent.click(screen.getByRole('button', { name: /Prepare draft/i }));
  await waitFor(() => expect(calls.creates).toHaveLength(1));
  expect(calls.creates[0].purpose).toBe('family_handoff');
  expect(calls.creates[0].questions).toEqual(['Was there an unrecorded fall?']);
  expect(screen.getByText('Fictional confirmed report')).toBeTruthy();
  expect(screen.getAllByText(/Was there an unrecorded fall/).length).toBeGreaterThan(0);
  expect((screen.getByRole('button', { name: /Share read-only/i }) as HTMLButtonElement).disabled).toBe(true);
});

it('requires another explicit review after editing a question or changing purpose', async () => {
  const calls = setup();
  await openSummary();
  fireEvent.click(screen.getByRole('button', { name: /Prepare draft/i }));
  await screen.findByText('Fictional confirmed report');
  fireEvent.click(screen.getByRole('button', { name: /Save review/i }));
  await waitFor(() => expect(calls.reviews).toHaveLength(1));
  await waitFor(() => expect((screen.getByRole('button', { name: /Share read-only/i }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Questions to discuss'), { target: { value: 'What should we ask?' } });
  expect((screen.getByRole('button', { name: /Share read-only/i }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /Save review/i }));
  await waitFor(() => expect(calls.reviews).toHaveLength(2));
  expect(calls.reviews[1].questions).toEqual(['What should we ask?']);
  fireEvent.change(screen.getByLabelText('Summary purpose'), { target: { value: 'weekly_review' } });
  expect((screen.getByRole('button', { name: /Share read-only/i }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /Prepare a fresh draft/i }));
  await waitFor(() => expect(calls.creates).toHaveLength(2));
  expect(calls.creates[1].purpose).toBe('weekly_review');
});

it.each([false, true])('clears local care and print state when a previously visible summary is unavailable (missing=%s)', async missing => {
  const calls = setup();
  await openSummary();
  fireEvent.change(screen.getByLabelText('Questions to discuss'), { target: { value: 'Private question' } });
  fireEvent.click(screen.getByRole('button', { name: /Prepare draft/i }));
  await screen.findByText('Fictional confirmed report');
  fireEvent.click(screen.getByRole('button', { name: /Save review/i }));
  await screen.findByRole('button', { name: 'Print / Save as PDF' });
  calls.setDashboard({ ...dashboard, summaries: missing ? [] : [{ id: 'summary_1', patient_id: patient.id, status: 'reviewed',
    reviewed_at: '2026-10-02T09:00:00Z', invalidated_at: null, source_access_current: false,
    sections: [], sources: [], questions: [] }] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh care data' }));
  await waitFor(() => expect(screen.queryByText('Fictional confirmed report')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Print / Save as PDF' })).toBeNull();
  expect(screen.getByLabelText('Questions to discuss')).toHaveProperty('value', '');
  expect(screen.getByText(/Summary access or a source record changed/)).toBeTruthy();
});
