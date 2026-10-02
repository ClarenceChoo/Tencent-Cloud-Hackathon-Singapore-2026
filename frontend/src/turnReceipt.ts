import type { Home, Proposal, TurnStatus } from './companionApi';

export type ReceiptPhase = 'capturing' | 'sending' | 'receipt_unknown' | 'processing' | 'review' | 'committed' | 'cancelled' | 'failed' | 'expired';
export type ReceiptView = { phase: ReceiptPhase; title: string; detail: string; primaryAction: 'check' | 'review' | 'record' | null; recordId: string | null; recipients: string[] };
export type ConfirmationResult = { status: string; record_type?: string; record_id?: string };
export type ReceiptInput = {
  phase: ReceiptPhase;
  pending?: { key: string; turnId?: string } | null;
  status?: TurnStatus | null;
  proposal?: Proposal | null;
  home?: Home | null;
  confirmation?: ConfirmationResult | null;
  nowMs: number;
};

const view = (phase: ReceiptPhase, title: string, detail: string, primaryAction: ReceiptView['primaryAction'] = null, recordId: string | null = null, recipients: string[] = []): ReceiptView => ({ phase, title, detail, primaryAction, recordId, recipients });
const lists: Record<string, keyof Home> = {
  health_note: 'notes', medication_report: 'doses', measurement: 'measurements',
  preventive_task: 'preventive_tasks', support_request: 'support_requests', followup: 'followups',
};
const labels: Record<string, string> = {
  health_note: 'Health note', medication_report: 'Medicine update', measurement: 'Reading',
  preventive_task: 'Care task', support_request: 'Support request', followup: 'Follow-up',
};

export function deriveReceipt(input: ReceiptInput): ReceiptView {
  const { status, proposal, home, confirmation, nowMs } = input;
  const event = status?.event;
  const committed = confirmation?.status === 'committed' ? confirmation : event?.payload.status === 'committed' ? event.payload : null;
  if (committed) {
    const recordId = typeof committed.record_id === 'string' ? committed.record_id : null;
    const recordType = typeof committed.record_type === 'string' ? committed.record_type : '';
    const listName = lists[recordType];
    const list = home && listName ? home[listName] : null;
    const row = Array.isArray(list) && recordId ? list.find(item => item.id === recordId) : null;
    if (!row) return view('committed', 'Saved to your care space', 'The record was confirmed. Current details are unavailable here.', null, recordId);
    const recipientIds = recordType === 'health_note' ? row.shared_with_user_ids : recordType === 'support_request' ? [row.recipient_user_id] : [];
    const ids = Array.isArray(recipientIds) ? recipientIds : [];
    const resolved = ids.length && home ? ids.map(id => home.permitted_recipients.find(person => person.id === id)?.name) : [];
    const recipients = resolved.length === ids.length && resolved.every((name): name is string => typeof name === 'string' && !!name) ? resolved : [];
    // The list is bounded and visibility-filtered. Only an exact ID and type match can enrich a receipt.
    const label = labels[recordType] || 'Care record';
    const content = [row.wording, row.description, row.request_text, row.medicine_name].find(value => typeof value === 'string' && value.trim()) as string | undefined;
    return view('committed', `${label} saved`, content ? `Current care details: ${content}` : 'Current care details are available in your care space.', null, recordId, recipients);
  }
  if (status?.status === 'clarification_required' || event?.payload.status === 'clarification_required') return view('failed', 'No care record was saved', 'Parse needs a clearer instruction. You can make a new recording.', 'record');
  if (status?.status === 'failed' || input.phase === 'failed') return view('failed', 'Recording could not be processed', status?.error || 'No care record was saved. You can make a new recording.', 'record');
  if (input.phase === 'cancelled' || status?.status === 'cancelled' || event?.payload.status === 'cancelled') return view('cancelled', 'Not saved', 'The proposal was cancelled. No care record was saved.', 'record');
  if (status?.status === 'awaiting_confirmation' || event?.payload.status === 'awaiting_confirmation') {
    if (proposal && Date.parse(proposal.expires_at) > nowMs && proposal.status === 'pending' && (!event?.payload.context_id || proposal.context_id === event.payload.context_id)) return view('review', 'Ready for your review', 'Check the current read-back before choosing whether to save it.', 'review');
    return view('expired', 'Review no longer available', 'This read-back can no longer be confirmed. Make a new recording if needed.', 'record');
  }
  if (input.phase === 'review' && proposal) return Date.parse(proposal.expires_at) > nowMs && proposal.status === 'pending'
    ? view('review', 'Ready for your review', 'Check the current read-back before choosing whether to save it.', 'review')
    : view('expired', 'Review has expired', 'This read-back can no longer be confirmed. Make a new recording if needed.', 'record');
  if (status && ['accepted', 'transcribing', 'transcribed', 'processing'].includes(status.status)) return view('processing', 'Recording received', 'Parse is working on your recording. Check again for the result.', 'check');
  if (input.phase === 'capturing') return view('capturing', 'Recording', 'Speak when you are ready, then tap Send. Nothing has been uploaded yet.');
  if (input.phase === 'sending') return view('sending', 'Sending recording', 'Waiting for Parse to acknowledge your recording.');
  if (input.pending || input.phase === 'receipt_unknown') return view('receipt_unknown', 'Receipt unknown', 'Your recording may have reached Parse. Check its status before recording again.', 'check');
  if (input.phase === 'expired') return view('expired', 'Review has expired', 'Make a new recording if needed.', 'record');
  return view('processing', 'Checking recording', 'Parse is checking the recording status.', 'check');
}
