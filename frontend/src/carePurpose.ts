export const capturePurposes = [
  { id: 'health_note', label: 'Health note', prompt: 'Tell Parse what happened and when. You can choose who sees the note when you review it.' },
  { id: 'medication_report', label: 'Medicine update', prompt: 'Say which scheduled medicine and whether you took it, skipped it, or are unsure.' },
  { id: 'measurement', label: 'Blood pressure', prompt: 'Say both numbers, when you measured them, and where the reading came from.' },
  { id: 'support_request', label: 'Ask for help', prompt: 'Say what help you need and who should receive the request.' },
] as const;

export type CaptureIntent = typeof capturePurposes[number]['id'];
export const isCaptureIntent = (value: unknown): value is CaptureIntent =>
  capturePurposes.some(purpose => purpose.id === value);

export const materialLabels: Record<CaptureIntent, Record<string, string>> = {
  health_note: { wording: 'What happened', symptom: 'Symptom', occurrence_text: 'When it happened', occurred_at: 'When it happened', share_with_user_ids: 'Shared with' },
  medication_report: { dose_instance_id: 'Scheduled medicine', report_state: 'Your report', taken_time_text: 'Time taken' },
  measurement: { systolic: 'Top number', diastolic: 'Bottom number', source_description: 'Reading source', occurrence_text: 'When measured', occurred_at: 'When measured' },
  support_request: { request_text: 'Help needed', recipient_user_id: 'Recipient', urgency: 'Urgency', barrier_text: 'Barrier' },
};
