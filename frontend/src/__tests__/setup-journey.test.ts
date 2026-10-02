import { expect, it } from 'vitest';
import type { Enrollment, Home } from '../companionApi';
import { deriveSetupProgress } from '../setupJourney';

const enrollment: Enrollment = { status: 'paired', device_id: 'browser1', patient: { id: 'patient1', name: 'Mei' } };
const home: Home = {
  device_id: 'browser1', patient: { id: 'patient1', name: 'Mei', preferred_name: 'Mei', timezone: 'Asia/Singapore', calling_route: null },
  active_companion: { device_id: 'browser1', generation: 1 }, voice: { voice_service: 'configured', scheduler_enabled: true },
  current_proposal: null, medication_plan: null, doses: [], notes: [], measurements: [], preventive_tasks: [], support_requests: [], followups: [], permitted_recipients: [],
};
const evidence = { enrollment, home, connected: true, evidenceIdentity: 'browser1:patient1', speakerPlayed: true, microphoneChecked: true, firstCommittedRecordId: 'note1', lastTurnSimulated: false, lastTurnCompleted: true, nowMs: Date.now() };

it('keeps approval, current connection, and reminder selection distinct', () => {
  expect(deriveSetupProgress({ ...evidence, enrollment: { ...enrollment, status: 'awaiting_approval' } }).step).toBe('approve');
  expect(deriveSetupProgress({ ...evidence, home: null }).step).toBe('connection');
  expect(deriveSetupProgress({ ...evidence, connected: false }).step).toBe('connection');
  expect(deriveSetupProgress({ ...evidence, home: { ...home, patient: { ...home.patient, id: 'another' } } }).step).toBe('connection');
  const unselected = deriveSetupProgress({ ...evidence, home: { ...home, active_companion: { device_id: null, generation: 2 } } });
  expect(unselected.step).toBe('reminders');
  expect(unselected.completed).not.toContain('reminders');
  expect(deriveSetupProgress(evidence).reminderAvailability).toMatch(/open and visible/);
});

it('does not turn a tutorial, stale identity, or simulated turn into live voice proof', () => {
  expect(deriveSetupProgress({ ...evidence, speakerPlayed: false, microphoneChecked: false, firstCommittedRecordId: null }).step).toBe('speaker');
  expect(deriveSetupProgress({ ...evidence, evidenceIdentity: 'other:patient1' }).step).toBe('speaker');
  expect(deriveSetupProgress({ ...evidence, firstCommittedRecordId: null }).step).toBe('first_update');
  expect(deriveSetupProgress({ ...evidence, lastTurnSimulated: true }).liveVoiceVerified).toBe(false);
  expect(deriveSetupProgress({ ...evidence, lastTurnCompleted: false }).liveVoiceVerified).toBe(false);
  expect(deriveSetupProgress({ ...evidence, home: { ...home, voice: { ...home.voice, voice_service: 'simulated' } } }).liveVoiceVerified).toBe(false);
  expect(deriveSetupProgress(evidence).step).toBe('done');
  expect(deriveSetupProgress(evidence).liveVoiceVerified).toBe(true);
});

it('reports unavailable voice and disabled reminders without claiming completion', () => {
  const result = deriveSetupProgress({ ...evidence, home: { ...home, voice: { voice_service: 'unconfigured', scheduler_enabled: false } }, speakerPlayed: false });
  expect(result.voiceMode).toBe('unavailable');
  expect(result.step).toBe('speaker');
  expect(result.reminderAvailability).toMatch(/disabled/);
  expect(result.liveVoiceVerified).toBe(false);
});
