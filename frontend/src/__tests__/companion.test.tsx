import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Companion from '../Companion';
import { webAudioPath, type Home } from '../companionApi';

const api = vi.hoisted(() => ({
  session: vi.fn(), enrollment: vi.fn(), home: vi.fn(), enroll: vi.fn(),
  revise: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), speech: vi.fn(),
  pending: vi.fn(), quiesce: vi.fn(), revoke: vi.fn(), ack: vi.fn(),
  upload: vi.fn(), receipt: vi.fn(), turn: vi.fn(), reminder: vi.fn(), speaker: vi.fn(),
}));
vi.mock('../companionApi', async importOriginal => {
  const original = await importOriginal<typeof import('../companionApi')>();
  return { ...original, companionApi: api };
});

let current: Home;
const proposal = { id: 'prop_123', context_id: 'ctx_12345678', kind: 'health_note', readback: 'Record a sore left knee. Keep this private?', status: 'pending', payload: { wording: 'Sore left knee', share_with_user_ids: [] }, expires_at: '2099-01-01T00:00:00Z' };
function storage() { const entries = new Map<string,string>(); return { getItem: (key:string) => entries.get(key) ?? null, setItem: (key:string,value:string) => { entries.set(key,value); }, removeItem: (key:string) => { entries.delete(key); }, clear: () => entries.clear() }; }
beforeEach(() => {
  vi.stubGlobal('sessionStorage', storage()); vi.stubGlobal('localStorage', storage()); vi.clearAllMocks();
  current = { device_id: 'phone_123', patient: { id: 'p1', name: 'Mei', preferred_name: 'Mei', timezone: 'Asia/Singapore', calling_route: null }, active_companion: { device_id: null, generation: 1 }, voice: { voice_service: 'simulated', scheduler_enabled: false }, current_proposal: proposal, medication_plan: null, doses: [], notes: [], measurements: [], preventive_tasks: [], support_requests: [], followups: [], permitted_recipients: [] };
  api.session.mockResolvedValue({ has_installation: true, csrf_token: 'csrf' });
  api.enrollment.mockResolvedValue({ status: 'paired', device_id: 'phone_123', patient: { id: 'p1', name: 'Mei' } });
  api.home.mockImplementation(async () => current);
  api.pending.mockResolvedValue({ active_companion: current.active_companion, commands: [], checkins: [] });
  api.revise.mockImplementation(async (_proposal, payload) => {
    const revised = { ...proposal, id: 'prop_456', readback: 'Record a sore right knee. Keep this private?', payload };
    current = { ...current, current_proposal: revised };
    return revised;
  });
  api.confirm.mockImplementation(async () => { current = { ...current, current_proposal: null }; return { status: 'committed' }; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('accepts only canonical reply asset IDs on the browser audio route', () => {
  const id = 'audio_' + 'a'.repeat(32);
  expect(webAudioPath('/v1/device/audio/' + id)).toBe('/v1/web/audio/' + id);
  expect(webAudioPath('/v1/web/audio/' + id)).toBe('/v1/web/audio/' + id);
  expect(() => webAudioPath('https://elsewhere.example/v1/web/audio/' + id)).toThrow();
  expect(() => webAudioPath('/v1/web/audio/' + id + '?token=secret')).toThrow();
});

it('requires review and a fresh confirmation after textual health-note correction', async () => {
  const user = userEvent.setup(); render(<Companion />);
  expect(await screen.findByText('Record a sore left knee. Keep this private?')).toBeTruthy();
  expect(api.confirm).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Change wording' }));
  await user.clear(screen.getByLabelText('How should this note read?'));
  await user.type(screen.getByLabelText('How should this note read?'), 'Sore right knee');
  expect((screen.getByRole('button', { name: 'Confirm and save' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Review changed note' }));
  expect(await screen.findByText('Record a sore right knee. Keep this private?')).toBeTruthy();
  expect(api.revise).toHaveBeenCalledWith(proposal, { wording: 'Sore right knee', share_with_user_ids: [] });
  expect(api.confirm).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
  await waitFor(() => expect(api.confirm).toHaveBeenCalledOnce());
  expect(await screen.findByText('Confirmed and saved.')).toBeTruthy();
});

it('stops a late microphone grant after the page loses focus and never uploads', async () => {
  const user = userEvent.setup(); let grant!: (value: MediaStream) => void;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  render(<Companion />); await screen.findByRole('button', { name: 'Tap to record' });
  await user.click(screen.getByRole('button', { name: 'Tap to record' }));
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
  window.dispatchEvent(new Event('blur'));
  const stop = vi.fn(); grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(api.upload).not.toHaveBeenCalled();
});

it('labels confirmed doses, readings, tasks and support using actual home fields', async () => {
  current = { ...current, current_proposal: null,
    doses: [{ id: 'dose_1', medicine_name: 'DemoMed', scheduled_at: '2026-09-29T00:00:00Z', report_state: 'reported_taken' }],
    measurements: [{ id: 'reading_1', systolic: 128, diastolic: 76, unit: 'mmHg', occurred_at: '2026-09-29T00:00:00Z' }],
    preventive_tasks: [{ id: 'task_1', description: 'Book review', state: 'arranged', due_date: '2026-10-01T00:00:00Z' }],
    support_requests: [{ id: 'support_1', request_text: 'Need a ride', status: 'open', created_at: '2026-09-29T00:00:00Z' }],
  };
  render(<Companion />);
  expect(await screen.findByText('DemoMed')).toBeTruthy();
  expect(screen.getAllByText('Blood pressure reading').length).toBeGreaterThan(0);
  expect(screen.getByText('Book review')).toBeTruthy();
  expect(screen.getByText('Need a ride')).toBeTruthy();
  expect(screen.getByText(/reported taken · Scheduled/)).toBeTruthy();
});
