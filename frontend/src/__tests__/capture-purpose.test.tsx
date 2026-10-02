import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Companion from '../Companion';
import type { Home } from '../companionApi';

const api = vi.hoisted(() => ({ session: vi.fn(), enrollment: vi.fn(), home: vi.fn(), pending: vi.fn(), speaker: vi.fn(), upload: vi.fn() }));
vi.mock('../companionApi', async importOriginal => {
  const original = await importOriginal<typeof import('../companionApi')>();
  return { ...original, companionApi: { ...original.companionApi, ...api } };
});

const home: Home = {
  device_id: 'phone_123', patient: { id: 'p1', name: 'Mei', preferred_name: 'Mei', timezone: 'Asia/Singapore', calling_route: null },
  active_companion: { device_id: null, generation: 1 }, voice: { voice_service: 'simulated', scheduler_enabled: false },
  current_proposal: null, medication_plan: null, doses: [], notes: [], measurements: [], preventive_tasks: [], support_requests: [], followups: [], permitted_recipients: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.session.mockResolvedValue({ has_installation: true, csrf_token: 'csrf' });
  api.enrollment.mockResolvedValue({ status: 'paired', device_id: 'phone_123', patient: { id: 'p1', name: 'Mei' } });
  api.home.mockResolvedValue(home);
  api.pending.mockResolvedValue({ active_companion: home.active_companion, commands: [], checkins: [] });
});
afterEach(() => cleanup());

it('keeps purpose selection optional and does not record or write care', async () => {
  const user = userEvent.setup();
  render(<Companion />);
  const purpose = await screen.findByRole('button', { name: 'Blood pressure' });
  expect(screen.getByRole('button', { name: 'Speak freely' }).getAttribute('aria-pressed')).toBe('true');
  await user.click(purpose);
  expect(purpose.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText(/Say both numbers/)).toBeTruthy();
  expect(api.upload).not.toHaveBeenCalled();
  expect(api.speaker).not.toHaveBeenCalled();
});

it('locks purpose while a proposal needs review', async () => {
  api.home.mockResolvedValue({ ...home, current_proposal: { id: 'prop_1', context_id: 'ctx_12345678', kind: 'measurement', readback: 'Review this reading?', status: 'pending', payload: { measurement_type: 'blood_pressure', systolic: 120, diastolic: 80, unit: 'mmHg', source_description: 'Home cuff', reporting_actor: 'patient', timezone: 'Asia/Singapore', occurrence_text: 'today' }, expires_at: '2099-01-01T00:00:00Z' } });
  render(<Companion />);
  expect((await screen.findByRole('button', { name: 'Blood pressure' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Speak freely' }) as HTMLButtonElement).disabled).toBe(true);
});

it('sends the chosen hint only on a new turn and keeps CSRF protection', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ turn_id: 'turn_1', status: 'accepted', received_at: '2026-10-02T00:00:00Z' }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const actual = await vi.importActual<typeof import('../companionApi')>('../companionApi');
  actual.setCompanionCsrf('csrf-test');
  const blob = new Blob(['audio'], { type: 'audio/webm' });
  await actual.companionApi.upload(blob, 'key', null, new AbortController().signal, 'health_note');
  const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers);
  expect(headers.get('X-Care-Intent')).toBe('health_note');
  expect(headers.get('X-CSRF-Token')).toBe('csrf-test');
  await actual.companionApi.upload(blob, 'key2', 'ctx_12345678', new AbortController().signal, 'measurement');
  const correctionHeaders = new Headers(fetchMock.mock.calls[1]![1]!.headers);
  expect(correctionHeaders.get('X-Care-Intent')).toBeNull();
  expect(correctionHeaders.get('X-Context-Id')).toBe('ctx_12345678');
  vi.unstubAllGlobals();
});
