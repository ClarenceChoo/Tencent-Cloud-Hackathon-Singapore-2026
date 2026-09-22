import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

afterEach(() => cleanup());

const session = {
  user: { id: 'user-1', name: 'Alex Tan', email: 'alex@example.test', role: 'owner' },
  patients: [{ id: 'patient-1', name: 'Mei Tan', timezone: 'Asia/Singapore' }],
  csrf_token: 'csrf-test-token',
};
const emptyDashboard = {
  patient: session.patients[0], devices: [], medication_plans: [], doses: [], notes: [], measurements: [],
  preventive_tasks: [], support_requests: [], followups: [], proposals: [], permissions: ['read:dashboard', 'write:care', 'manage:sharing', 'manage:devices'], access_grants: [],
};

function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('care record confirmation', () => {
  it('does not commit a health note until the user confirms the reviewed proposal', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method || 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.endsWith('/auth/session')) return json(session);
      if (url.endsWith('/dashboard')) return json(emptyDashboard);
      if (url.endsWith('/proposals') && method === 'POST') return json({ id: 'proposal-1', kind: 'health_note', payload: { wording: 'My knee aches after a walk.' }, readback: 'I will record knee discomfort after a walk. Is that right?', status: 'pending' }, 201);
      if (url.endsWith('/proposal-1/revise')) { const request = JSON.parse(String(init?.body)); return json({ id: 'proposal-2', kind: 'health_note', payload: request.payload, readback: 'I will record that my knee aches after a short walk. Is that right?', status: 'pending' }, 201); }
      if (url.endsWith('/proposal-2/confirm')) return json({ status: 'committed', record_type: 'health_note', record_id: 'note-1' });
      return json({ detail: 'Unexpected request' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: /care, together\./i });
    await user.click(await screen.findByRole('button', { name: /add a care note/i }));
    await user.type(screen.getByLabelText('What would you like recorded?'), 'My knee aches after a walk.');
    await user.click(screen.getByRole('button', { name: /review proposal/i }));
    await screen.findByRole('dialog');

    expect(calls.some(call => call.url.endsWith('/proposal-1/confirm'))).toBe(false);
    expect(screen.getByText(/I will record knee discomfort after a walk/i)).toBeTruthy();
    await user.clear(screen.getByLabelText('Wording'));
    await user.type(screen.getByLabelText('Wording'), 'My knee aches after a short walk.');
    const confirmButton = screen.getByRole('button', { name: /confirm and save/i });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(confirmButton);
    expect(calls.some(call => call.url.endsWith('/proposal-1/confirm'))).toBe(false);

    await user.click(screen.getByRole('button', { name: /review revised details/i }));
    expect(await screen.findByText(/I will record that my knee aches after a short walk/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /confirm and save/i }));
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/proposal-2/confirm'))).toBe(true));
    expect(calls.some(call => call.url.endsWith('/proposal-1/confirm'))).toBe(false);
    expect(await screen.findByText('Confirmed and saved.')).toBeTruthy();
  });
});
