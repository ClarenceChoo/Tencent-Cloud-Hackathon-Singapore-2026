import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Companion from '../Companion';
import { CompanionApiError, webAudioPath, type Home } from '../companionApi';

const api = vi.hoisted(() => ({
  session: vi.fn(), enrollment: vi.fn(), home: vi.fn(), enroll: vi.fn(), presence: vi.fn(),
  revise: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), speech: vi.fn(),
  pending: vi.fn(), quiesce: vi.fn(), revoke: vi.fn(), ack: vi.fn(),
  upload: vi.fn(), receipt: vi.fn(), turn: vi.fn(), reminder: vi.fn(), speaker: vi.fn(),
}));
const audioFetch = vi.hoisted(() => vi.fn());
vi.mock('../companionApi', async importOriginal => {
  const original = await importOriginal<typeof import('../companionApi')>();
  return { ...original, companionApi: api, fetchWebAudio: audioFetch };
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
  api.presence.mockResolvedValue({ server_time: '2026-10-09T00:00:00Z' });
  api.pending.mockResolvedValue({ active_companion: current.active_companion, commands: [], checkins: [] });
  audioFetch.mockResolvedValue({ blob: new Blob(['example'], { type: 'audio/wav' }), duration: 1 });
  api.revise.mockImplementation(async (_proposal, payload) => {
    const revised = { ...proposal, id: 'prop_456', readback: 'Record a sore right knee. Keep this private?', payload };
    current = { ...current, current_proposal: revised };
    return revised;
  });
  api.confirm.mockImplementation(async () => { current = { ...current, current_proposal: null }; return { status: 'committed' }; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reports live presence without recording and reports background when hidden', async () => {
  const query = vi.fn(async () => ({ state: 'prompt' as PermissionState }));
  const previous = Object.getOwnPropertyDescriptor(navigator, 'permissions');
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } });
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  try {
    render(<Companion/>);
    await waitFor(() => expect(api.presence).toHaveBeenCalledWith('foreground', 'undetermined'));
    expect(query).toHaveBeenCalledWith({ name: 'microphone' });
    expect(api.upload).not.toHaveBeenCalled();
    visible.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(api.presence).toHaveBeenCalledWith('background', 'undetermined'));
  } finally {
    if (previous) Object.defineProperty(navigator, 'permissions', previous);
    else Reflect.deleteProperty(navigator, 'permissions');
  }
});

it('does not report presence before owner approval', async () => {
  api.enrollment.mockResolvedValue({ status: 'awaiting_approval', device_id: 'phone_123', code: 'P-DEMO-12345', expires_at: '2099-01-01T00:00:00Z' });
  render(<Companion/>);
  await screen.findByLabelText('Pairing code P-DEMO-12345');
  expect(api.presence).not.toHaveBeenCalled();
  expect(api.home).not.toHaveBeenCalled();
});

it('accepts only canonical reply asset IDs on the browser audio route', () => {
  const id = 'audio_' + 'a'.repeat(32);
  expect(webAudioPath('/v1/device/audio/' + id)).toBe('/v1/web/audio/' + id);
  expect(webAudioPath('/v1/web/audio/' + id)).toBe('/v1/web/audio/' + id);
  expect(() => webAudioPath('https://elsewhere.example/v1/web/audio/' + id)).toThrow();
  expect(() => webAudioPath('/v1/web/audio/' + id + '?token=secret')).toThrow();
});

it('clears an expired pairing code and offers a fresh browser enrollment', async () => {
  const user = userEvent.setup();
  api.enrollment.mockRejectedValueOnce(new CompanionApiError('expired', 410)).mockResolvedValue({ status: 'awaiting_approval', device_id: 'fresh', code: 'P-FRESH-12345', expires_at: '2099-01-01T00:00:00Z' });
  api.enroll.mockResolvedValue({ status: 'awaiting_approval', device_id: 'fresh', code: 'P-FRESH-12345', expires_at: '2099-01-01T00:00:00Z' });
  render(<Companion />);
  expect(await screen.findByText(/pairing code expired/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Connect this browser' }));
  expect(await screen.findByLabelText('Pairing code P-FRESH-12345')).toBeTruthy();
  expect(api.enroll).toHaveBeenCalledOnce();
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

it('refreshes a stale correction and never confirms the obsolete proposal', async () => {
  const user = userEvent.setup();
  const replacement = { ...proposal, id: 'prop_latest', context_id: 'ctx_latest', readback: 'Review the newer note?', payload: { wording: 'Newer note', share_with_user_ids: [] } };
  api.revise.mockImplementationOnce(async () => { current = { ...current, current_proposal: replacement }; throw new CompanionApiError('stale proposal', 409); });
  render(<Companion />);
  await screen.findByText(proposal.readback);
  await user.click(screen.getByRole('button', { name: 'Change wording' }));
  await user.clear(screen.getByLabelText('How should this note read?'));
  await user.type(screen.getByLabelText('How should this note read?'), 'Edited old note');
  await user.click(screen.getByRole('button', { name: 'Review changed note' }));
  expect(await screen.findByText('Review the newer note?')).toBeTruthy();
  expect(screen.queryByText(proposal.readback)).toBeNull();
  expect(api.confirm).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
  await waitFor(() => expect(api.confirm).toHaveBeenCalledWith(replacement));
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

it('cancels a late first-use microphone permission and never uploads the exercise', async () => {
  const user = userEvent.setup();
  current = { ...current, current_proposal: null, active_companion: { device_id: 'phone_123', generation: 1 }, voice: { voice_service: 'configured', scheduler_enabled: true } };
  api.speaker.mockResolvedValue({ expires_at: '2099-01-01T00:00:00Z', payload: { status: 'speaker_check', audio_paths: ['/v1/web/audio/audio_' + 'a'.repeat(32)], simulated: false } });
  vi.stubGlobal('Audio', class {
    listeners = new Map<string, () => void>();
    constructor(_src: string) {}
    addEventListener(event: string, callback: () => void) { this.listeners.set(event, callback); }
    removeEventListener(event: string) { this.listeners.delete(event); }
    pause() {}
    removeAttribute(_name: string) {}
    load() {}
    play() { queueMicrotask(() => this.listeners.get('ended')?.()); return Promise.resolve(); }
  });
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:example', revokeObjectURL: vi.fn() });
  let grant!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  render(<Companion />);
  await screen.findByRole('button', { name: 'Play speaker check' });
  expect(getUserMedia).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Play speaker check' }));
  await screen.findByRole('button', { name: 'Check microphone permission' });
  expect(api.speaker).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'Check microphone permission' }));
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
  await user.click(screen.getByRole('button', { name: 'Cancel microphone check' }));
  const stop = vi.fn();
  grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(screen.getByRole('button', { name: 'Check microphone permission' })).toBeTruthy();
  expect(api.upload).not.toHaveBeenCalled();
  getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));
  await user.click(screen.getByRole('button', { name: 'Check microphone permission' }));
  expect(await screen.findByText(/Permission denied/)).toBeTruthy();
  const stopRetry = vi.fn();
  getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop: stopRetry }] } as unknown as MediaStream);
  await user.click(screen.getByRole('button', { name: 'Check microphone permission' }));
  expect(await screen.findByRole('button', { name: 'Start first update' })).toBeTruthy();
  expect(stopRetry).toHaveBeenCalledOnce();
  expect(api.upload).not.toHaveBeenCalled();
  current = { ...current, patient: { ...current.patient, id: 'p2', name: 'Bo', preferred_name: 'Bo' } };
  api.enrollment.mockResolvedValue({ status: 'paired', device_id: 'phone_123', patient: { id: 'p2', name: 'Bo' } });
  await user.click(screen.getByRole('button', { name: 'Refresh care details' }));
  expect(await screen.findByText('Hello, Bo.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Play speaker check' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start first update' })).toBeNull();
});

it('ignores a speaker response from the previous patient after a switch', async () => {
  const user = userEvent.setup();
  current = { ...current, current_proposal: null, active_companion: { device_id: 'phone_123', generation: 1 }, voice: { voice_service: 'configured', scheduler_enabled: true } };
  let finish!: (event: unknown) => void;
  api.speaker.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<Companion />);
  await user.click(await screen.findByRole('button', { name: 'Play speaker check' }));
  current = { ...current, patient: { ...current.patient, id: 'p2', name: 'Bo', preferred_name: 'Bo' } };
  api.enrollment.mockResolvedValue({ status: 'paired', device_id: 'phone_123', patient: { id: 'p2', name: 'Bo' } });
  await user.click(screen.getByRole('button', { name: 'Refresh care details' }));
  expect(await screen.findByText('Hello, Bo.')).toBeTruthy();
  finish({ expires_at: '2099-01-01T00:00:00Z', payload: { status: 'speaker_check', audio_paths: ['/v1/web/audio/audio_' + 'a'.repeat(32)] } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Play speaker check' })).toBeTruthy());
  expect(audioFetch).not.toHaveBeenCalled();
});

it('counts the first update only after the ordinary review and explicit confirmation', async () => {
  const user = userEvent.setup();
  current = { ...current, current_proposal: null, active_companion: { device_id: 'phone_123', generation: 1 }, voice: { voice_service: 'configured', scheduler_enabled: true } };
  api.speaker.mockResolvedValue({ expires_at: '2099-01-01T00:00:00Z', payload: { status: 'speaker_check', audio_paths: ['/v1/web/audio/audio_' + 'a'.repeat(32)], simulated: false } });
  vi.stubGlobal('Audio', class {
    listeners = new Map<string, () => void>();
    constructor(_src: string) {}
    addEventListener(event: string, callback: () => void) { this.listeners.set(event, callback); }
    removeEventListener(event: string) { this.listeners.delete(event); }
    pause() {}
    removeAttribute(_name: string) {}
    load() {}
    play() { queueMicrotask(() => this.listeners.get('ended')?.()); return Promise.resolve(); }
  });
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:example', revokeObjectURL: vi.fn() });
  const stop = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } });
  vi.stubGlobal('MediaRecorder', class {
    static isTypeSupported() { return true; }
    state = 'inactive';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    constructor(_stream: MediaStream, _options: unknown) {}
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['recording long enough to send']) }); this.onstop?.(); }
  });
  api.upload.mockResolvedValue({ turn_id: 'turn_12345678', status: 'received', received_at: '2026-10-02T00:00:00Z' });
  api.turn.mockImplementation(async () => {
    current = { ...current, current_proposal: proposal };
    return { turn_id: 'turn_12345678', status: 'completed', received_at: '2026-10-02T00:00:00Z', error: null, event: { expires_at: '2099-01-01T00:00:00Z', payload: { status: 'awaiting_confirmation', context_id: proposal.context_id, simulated: false } } };
  });
  api.confirm.mockImplementation(async () => { current = { ...current, current_proposal: null }; return { status: 'committed', record_id: 'note_123', record_type: 'health_note' }; });
  const view = render(<Companion />);
  await user.click(await screen.findByRole('button', { name: 'Play speaker check' }));
  await user.click(await screen.findByRole('button', { name: 'Check microphone permission' }));
  await user.click(await screen.findByRole('button', { name: 'Start first update' }));
  expect(screen.getByText('Next: First confirmed update')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Tap to record' }));
  await new Promise(resolve => setTimeout(resolve, 350));
  await user.click(screen.getByRole('button', { name: 'Tap to send' }));
  expect(await screen.findByText(proposal.readback)).toBeTruthy();
  expect(screen.getByText('Next: First confirmed update')).toBeTruthy();
  expect(api.confirm).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
  expect(await screen.findByText('Your first update is saved')).toBeTruthy();
  expect(screen.getByText(/completed live voice turn/)).toBeTruthy();
  view.unmount();
  render(<Companion />);
  expect(await screen.findByRole('button', { name: 'Play speaker check' })).toBeTruthy();
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
