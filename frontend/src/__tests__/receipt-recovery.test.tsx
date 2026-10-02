import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Companion from '../Companion';
import { CompanionApiError, type Home, type TurnStatus } from '../companionApi';

const api = vi.hoisted(() => ({ session: vi.fn(), enrollment: vi.fn(), home: vi.fn(), enroll: vi.fn(), revise: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), speech: vi.fn(), pending: vi.fn(), quiesce: vi.fn(), revoke: vi.fn(), ack: vi.fn(), upload: vi.fn(), receipt: vi.fn(), turn: vi.fn(), reminder: vi.fn(), speaker: vi.fn() }));
vi.mock('../companionApi', async importOriginal => ({ ...await importOriginal<typeof import('../companionApi')>(), companionApi: api }));
const key = '12345678-1234-1234-1234-123456789abc';
const pending = { key, context: null, createdAt: Date.now(), deviceId: 'device_123', patientId: 'patient_1' };
const storage = () => { const entries = new Map<string,string>(); return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); }, clear: () => entries.clear() }; };
const home = (): Home => ({ device_id: 'device_123', patient: { id: 'patient_1', name: 'Mei', preferred_name: 'Mei', timezone: 'Asia/Singapore', calling_route: null }, active_companion: { device_id: null, generation: 1 }, voice: { voice_service: 'simulated', scheduler_enabled: false }, current_proposal: null, medication_plan: null, doses: [], notes: [], measurements: [], preventive_tasks: [], support_requests: [], followups: [], permitted_recipients: [] });
const result = (status: string, eventStatus?: string): TurnStatus => ({ turn_id: 'turn_12345678', status, received_at: '2026-10-02T01:00:00Z', error: null, event: eventStatus ? { expires_at: '2026-10-01T00:00:00Z', payload: { status: eventStatus, record_type: 'health_note', record_id: 'note_1', spoken_text: 'Old audio' } } : null });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let currentHome: Home;
let currentEnrollment: { status: 'paired'; device_id: string; patient: { id: string; name: string } };

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('sessionStorage', storage()); vi.stubGlobal('localStorage', storage());
  sessionStorage.setItem('parse.web.pending.v1', JSON.stringify(pending));
  currentHome = home(); currentEnrollment = { status: 'paired', device_id: 'device_123', patient: { id: 'patient_1', name: 'Mei' } };
  api.session.mockResolvedValue({ has_installation: true, csrf_token: 'csrf' });
  api.enrollment.mockImplementation(async () => currentEnrollment);
  api.home.mockImplementation(async () => currentHome);
  api.pending.mockResolvedValue({ active_companion: currentHome.active_companion, commands: [], checkins: [] });
  api.receipt.mockResolvedValue({ turn_id: 'turn_12345678', status: 'accepted', received_at: '2026-10-02T01:00:00Z' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not reupload after the accepted upload response times out', async () => {
  sessionStorage.clear(); const user = userEvent.setup();
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const track = { stop: vi.fn(), onended: null };
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'recording';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    start() { /* browser captures until send */ }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['fictional audio bytes']) }); this.onstop?.(); }
  }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('crypto', { randomUUID: () => key });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  api.upload.mockRejectedValueOnce(new Error('response timed out'));
  api.turn.mockResolvedValue(result('committed', 'committed'));
  try {
    render(<Companion />); await screen.findByRole('button', { name: 'Tap to record' });
    await user.click(screen.getByRole('button', { name: 'Tap to record' }));
    clock.mockReturnValue(2000);
    await user.click(await screen.findByRole('button', { name: 'Tap to send' }));
    expect(await screen.findByText('Receipt unknown')).toBeTruthy();
    expect(api.upload).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Check recording' }));
    expect(await screen.findByText('Saved to your care space')).toBeTruthy();
    expect(api.upload).toHaveBeenCalledOnce(); expect(api.confirm).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  } finally {
    if (originalMedia) Object.defineProperty(navigator, 'mediaDevices', originalMedia);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});

it('keeps an aborted send checkable and ignores its late upload response', async () => {
  sessionStorage.clear(); const user = userEvent.setup();
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'recording';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    start() { /* capture until Send */ }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['fictional audio bytes']) }); this.onstop?.(); }
  }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn(), onended: null }] })) } });
  vi.stubGlobal('MediaRecorder', FakeRecorder); vi.stubGlobal('crypto', { randomUUID: () => key });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const upload = deferred<{ turn_id: string; status: string; received_at: string }>();
  api.upload.mockReturnValue(upload.promise); api.turn.mockResolvedValue(result('committed', 'committed'));
  try {
    render(<Companion />); await screen.findByRole('button', { name: 'Tap to record' });
    await user.click(screen.getByRole('button', { name: 'Tap to record' })); clock.mockReturnValue(2000);
    await user.click(await screen.findByRole('button', { name: 'Tap to send' }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(screen.getByText('Receipt unknown')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check recording' }));
    expect(await screen.findByText('Saved to your care space')).toBeTruthy();
    upload.resolve({ turn_id: 'turn_12345678', status: 'accepted', received_at: '2026-10-02T01:00:00Z' });
    await waitFor(() => expect(api.upload).toHaveBeenCalledOnce());
    expect(api.confirm).not.toHaveBeenCalled();
  } finally {
    if (originalMedia) Object.defineProperty(navigator, 'mediaDevices', originalMedia);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});

it('recovers an uncertain receipt after reload with reads only', async () => {
  const user = userEvent.setup(); api.receipt.mockRejectedValueOnce(new CompanionApiError('missing', 404));
  const first = render(<Companion />);
  await screen.findByText('Receipt unknown');
  expect(sessionStorage.getItem('parse.web.pending.v1')).not.toMatch(/Old audio|Fresh note/);
  await user.click(screen.getByRole('button', { name: 'Check recording' }));
  await screen.findByText(/Parse has no receipt yet/);
  first.unmount();
  api.turn.mockResolvedValue(result('committed', 'committed'));
  currentHome = { ...currentHome, notes: [{ id: 'note_1', wording: 'Fresh note', shared_with_user_ids: [] }] };
  render(<Companion />);
  await screen.findByText('Receipt unknown');
  await user.click(screen.getByRole('button', { name: 'Check recording' }));
  expect(await screen.findByText('Health note saved')).toBeTruthy();
  expect(screen.getByText(/Current care details: Fresh note/)).toBeTruthy();
  expect(api.upload).not.toHaveBeenCalled(); expect(api.confirm).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('parse.web.pending.v1')).toBeNull();
  expect(screen.queryByText('Old audio')).toBeNull();
});

it('keeps a committed fact but omits details after a failed fresh Home check', async () => {
  const user = userEvent.setup(); api.turn.mockResolvedValue(result('committed', 'committed'));
  api.home.mockResolvedValueOnce(currentHome).mockRejectedValueOnce(new Error('offline'));
  render(<Companion />); await screen.findByText('Receipt unknown');
  await user.click(screen.getByRole('button', { name: 'Check recording' }));
  expect(await screen.findByText('Saved to your care space')).toBeTruthy();
  expect(screen.getByText(/Current details are unavailable here/)).toBeTruthy();
  expect(api.upload).not.toHaveBeenCalled(); expect(api.confirm).not.toHaveBeenCalled();
});

it('omits deleted and newly private records and recipient names', async () => {
  const user = userEvent.setup(); api.turn.mockResolvedValue(result('committed', 'committed'));
  currentHome = { ...currentHome, notes: [], permitted_recipients: [{ id: 'person_1', name: 'Lin' }] };
  render(<Companion />); await screen.findByText('Receipt unknown');
  await user.click(screen.getByRole('button', { name: 'Check recording' }));
  expect(await screen.findByText('Saved to your care space')).toBeTruthy();
  expect(screen.queryByText(/Lin/)).toBeNull();
});

it('shows confirmation identity only after fresh authorized Home details arrive', async () => {
  sessionStorage.clear(); const user = userEvent.setup();
  const proposal = { id: 'prop_1', context_id: 'ctx_12345678', kind: 'health_note', status: 'pending', readback: 'Save this note?', payload: { wording: 'Fresh note' }, expires_at: '2099-01-01T00:00:00Z' };
  currentHome = { ...currentHome, current_proposal: proposal };
  const refresh = deferred<Home>();
  api.home.mockResolvedValueOnce(currentHome).mockReturnValueOnce(refresh.promise);
  api.confirm.mockResolvedValue({ status: 'committed', record_type: 'health_note', record_id: 'note_1' });
  render(<Companion />); await screen.findByText('Save this note?');
  await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
  expect(await screen.findByText('Saved to your care space')).toBeTruthy();
  expect(screen.queryByText(/Current care details: Fresh note/)).toBeNull();
  refresh.resolve({ ...currentHome, current_proposal: null, notes: [{ id: 'note_1', wording: 'Fresh note', shared_with_user_ids: [] }] });
  expect(await screen.findByText('Health note saved')).toBeTruthy();
  expect(screen.getByText(/Current care details: Fresh note/)).toBeTruthy();
  expect(api.confirm).toHaveBeenCalledOnce(); expect(api.upload).not.toHaveBeenCalled();
});

it('keeps verified confirmation visible when its Home refresh fails', async () => {
  sessionStorage.clear(); const user = userEvent.setup();
  currentHome = { ...currentHome, current_proposal: { id: 'prop_1', context_id: 'ctx_12345678', kind: 'health_note', status: 'pending', readback: 'Save this note?', payload: {}, expires_at: '2099-01-01T00:00:00Z' } };
  api.home.mockResolvedValueOnce(currentHome).mockRejectedValueOnce(new Error('offline'));
  api.confirm.mockResolvedValue({ status: 'committed', record_type: 'health_note', record_id: 'note_1' });
  render(<Companion />); await screen.findByText('Save this note?');
  await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
  expect(await screen.findByText('Saved to your care space')).toBeTruthy();
  expect(screen.getByText(/Current details are unavailable here/)).toBeTruthy();
  expect(screen.queryByText('Save this note?')).toBeNull();
});

it('clears a late result after installation revocation', async () => {
  const user = userEvent.setup(); const request = deferred<TurnStatus>(); api.turn.mockReturnValue(request.promise);
  render(<Companion />); await screen.findByText('Receipt unknown');
  await user.click(screen.getByRole('button', { name: 'Check recording' }));
  await waitFor(() => expect(api.turn).toHaveBeenCalledOnce());
  api.session.mockRejectedValueOnce(new CompanionApiError('revoked', 403));
  await user.click(screen.getByRole('button', { name: 'Refresh care details' }));
  await screen.findByText(/no longer has access/);
  request.resolve(result('committed', 'committed'));
  await waitFor(() => expect(screen.queryByText('Health note saved')).toBeNull());
  expect(screen.queryByText('Receipt unknown')).toBeNull(); expect(api.upload).not.toHaveBeenCalled();
});

it.each(['patient', 'device'])('clears an old %s receipt before a late callback can restore it', async replacement => {
  const user = userEvent.setup(); const request = deferred<TurnStatus>(); api.turn.mockReturnValue(request.promise);
  render(<Companion />); await screen.findByText('Receipt unknown');
  await user.click(screen.getByRole('button', { name: 'Check recording' }));
  await waitFor(() => expect(api.turn).toHaveBeenCalledOnce());
  currentEnrollment = { status: 'paired', device_id: replacement === 'device' ? 'device_456' : 'device_123', patient: { id: replacement === 'patient' ? 'patient_2' : 'patient_1', name: replacement === 'patient' ? 'Bo' : 'Mei' } };
  currentHome = { ...home(), device_id: currentEnrollment.device_id, patient: { ...home().patient, id: currentEnrollment.patient.id, name: currentEnrollment.patient.name, preferred_name: currentEnrollment.patient.name } };
  await user.click(screen.getByRole('button', { name: 'Refresh care details' }));
  await screen.findByText(`Hello, ${currentEnrollment.patient.name}.`);
  await waitFor(() => expect(screen.queryByText('Receipt unknown')).toBeNull());
  request.resolve(result('committed', 'committed'));
  await waitFor(() => expect(screen.queryByText('Receipt unknown')).toBeNull());
  expect(screen.queryByText('Health note saved')).toBeNull(); expect(api.confirm).not.toHaveBeenCalled();
});

it('clears old care content when result enrichment returns a different patient', async () => {
  const user = userEvent.setup(); const newHome = { ...home(), patient: { ...home().patient, id: 'patient_2', name: 'Bo', preferred_name: 'Bo' } };
  const reload = deferred<Home>();
  currentHome = { ...currentHome, notes: [{ id: 'old_note', wording: 'Old private note' }] };
  api.enrollment.mockResolvedValueOnce(currentEnrollment).mockResolvedValue({ status: 'paired', device_id: 'device_123', patient: { id: 'patient_2', name: 'Bo' } });
  api.home.mockResolvedValueOnce(currentHome).mockResolvedValueOnce(newHome).mockReturnValueOnce(reload.promise);
  api.turn.mockResolvedValue(result('committed', 'committed'));
  render(<Companion />); await screen.findByText('Old private note');
  await user.click(screen.getByRole('button', { name: 'Check recording' }));
  await screen.findByText('Opening Parse…');
  expect(screen.queryByText('Old private note')).toBeNull(); expect(screen.queryByText('Saved to your care space')).toBeNull();
  reload.resolve(newHome);
  await screen.findByText('Hello, Bo.');
  expect(screen.queryByText('Old private note')).toBeNull();
});

it('clears old care content when confirmation refresh returns a different device', async () => {
  sessionStorage.clear(); const user = userEvent.setup(); const newHome = { ...home(), device_id: 'device_456' };
  const reload = deferred<Home>();
  currentHome = { ...currentHome, notes: [{ id: 'old_note', wording: 'Old private note' }], current_proposal: { id: 'prop_1', context_id: 'ctx_12345678', kind: 'health_note', status: 'pending', readback: 'Old read-back', payload: {}, expires_at: '2099-01-01T00:00:00Z' } };
  api.enrollment.mockResolvedValueOnce(currentEnrollment).mockResolvedValue({ status: 'paired', device_id: 'device_456', patient: { id: 'patient_1', name: 'Mei' } });
  api.home.mockResolvedValueOnce(currentHome).mockResolvedValueOnce(newHome).mockReturnValueOnce(reload.promise);
  api.confirm.mockResolvedValue({ status: 'committed', record_type: 'health_note', record_id: 'old_note' });
  render(<Companion />); await screen.findByText('Old read-back');
  await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
  await screen.findByText('Opening Parse…');
  expect(screen.queryByText('Old private note')).toBeNull(); expect(screen.queryByText('Old read-back')).toBeNull();
  expect(screen.queryByText('Saved to your care space')).toBeNull();
  reload.resolve(newHome);
  await screen.findByText('Hello, Mei.');
  expect(screen.queryByText('Old private note')).toBeNull();
});
