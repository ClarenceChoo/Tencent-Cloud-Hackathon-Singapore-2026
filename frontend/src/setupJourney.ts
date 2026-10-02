import type { Enrollment, Home } from './companionApi';

export type SetupStep = 'approve' | 'connection' | 'reminders' | 'speaker' | 'microphone' | 'first_update' | 'done';
export type SetupProgress = {
  step: SetupStep;
  completed: SetupStep[];
  voiceMode: 'live' | 'simulated' | 'unavailable';
  reminderAvailability: string;
  liveVoiceVerified: boolean;
};
export type SetupInputs = {
  enrollment: Enrollment | null;
  home: Home | null;
  connected?: boolean;
  speakerPlayed: boolean;
  microphoneChecked: boolean;
  firstCommittedRecordId: string | null;
  lastTurnSimulated: boolean | null;
  lastTurnCompleted: boolean;
  evidenceIdentity?: string | null;
  nowMs: number;
};

export function setupIdentity(home: Home | null): string | null {
  return home?.device_id && home.patient?.id ? `${home.device_id}:${home.patient.id}` : null;
}

export function deriveSetupProgress(input: SetupInputs): SetupProgress {
  const { enrollment, home, nowMs } = input;
  const identity = setupIdentity(home);
  const paired = enrollment?.status === 'paired' && !!enrollment.patient?.id && !!enrollment.device_id;
  const matching = paired && !!identity && home?.device_id === enrollment.device_id && home.patient.id === enrollment.patient?.id;
  const connected = matching && input.connected !== false;
  const evidenceCurrent = connected && input.evidenceIdentity === identity;
  const voiceMode = home?.voice.voice_service === 'configured' ? 'live' : home?.voice.voice_service === 'simulated' ? 'simulated' : 'unavailable';
  const selected = connected && home?.active_companion.device_id === home.device_id;
  const reminderAvailability = !connected
    ? 'Check the current connection before choosing this browser for reminders.'
    : !selected
      ? 'The owner must select this browser as the reminder companion.'
      : !home.voice.scheduler_enabled
        ? 'This browser is selected, but scheduled reminders are disabled on the server.'
        : 'Selected browser reminders can play only while this companion page is open and visible.';
  const completed: SetupStep[] = [];
  if (paired && (!enrollment.expires_at || Date.parse(enrollment.expires_at) > nowMs)) completed.push('approve');
  else return { step: 'approve', completed, voiceMode, reminderAvailability, liveVoiceVerified: false };
  if (!connected) return { step: 'connection', completed, voiceMode, reminderAvailability, liveVoiceVerified: false };
  completed.push('connection');
  if (!selected) return { step: 'reminders', completed, voiceMode, reminderAvailability, liveVoiceVerified: false };
  completed.push('reminders');
  if (!evidenceCurrent || !input.speakerPlayed) return { step: 'speaker', completed, voiceMode, reminderAvailability, liveVoiceVerified: false };
  completed.push('speaker');
  if (!input.microphoneChecked) return { step: 'microphone', completed, voiceMode, reminderAvailability, liveVoiceVerified: false };
  completed.push('microphone');
  const liveVoiceVerified = voiceMode === 'live' && input.lastTurnCompleted && input.lastTurnSimulated === false;
  if (!input.firstCommittedRecordId) return { step: 'first_update', completed, voiceMode, reminderAvailability, liveVoiceVerified };
  completed.push('first_update');
  return { step: 'done', completed, voiceMode, reminderAvailability, liveVoiceVerified };
}
