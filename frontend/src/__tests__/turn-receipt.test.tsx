import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { deriveReceipt, type ReceiptPhase } from '../turnReceipt';
import RecordingReceipt from '../RecordingReceipt';
import type { Home, TurnStatus } from '../companionApi';

const now = Date.parse('2026-10-02T12:00:00Z');
const proposal = { id: 'prop_1', context_id: 'ctx_1', kind: 'health_note', readback: 'Read-back', status: 'pending', payload: {}, expires_at: '2026-10-02T13:00:00Z' };
const home: Home = { device_id: 'device_1', patient: { id: 'patient_1', name: 'Mei', preferred_name: null, timezone: 'Asia/Singapore', calling_route: null }, active_companion: { device_id: null, generation: 1 }, voice: { voice_service: 'simulated', scheduler_enabled: false }, current_proposal: proposal, medication_plan: null, doses: [], notes: [{ id: 'note_1', wording: 'Shoulder feels sore', shared_with_user_ids: ['person_1'] }], measurements: [], preventive_tasks: [], support_requests: [], followups: [], permitted_recipients: [{ id: 'person_1', name: 'Lin' }] };
const status = (value: string, eventStatus?: string, expiry = '2026-10-02T13:00:00Z'): TurnStatus => ({ turn_id: 'turn_12345678', status: value, received_at: '2026-10-02T11:00:00Z', error: null, event: eventStatus ? { expires_at: expiry, payload: { status: eventStatus, context_id: 'ctx_1', record_type: 'health_note', record_id: 'note_1' } } : null });

it.each(['accepted', 'transcribed', 'processing'])('%s stays received and processing', value => {
  const result = deriveReceipt({ phase: 'receipt_unknown', status: status(value), nowMs: now });
  expect(result.phase).toBe('processing'); expect(result.primaryAction).toBe('check');
});

it('shows a current proposal for review and expires a stale one', () => {
  expect(deriveReceipt({ phase: 'processing', status: status('awaiting_confirmation', 'awaiting_confirmation'), proposal, nowMs: now }).phase).toBe('review');
  expect(deriveReceipt({ phase: 'processing', status: status('awaiting_confirmation', 'awaiting_confirmation'), proposal, nowMs: Date.parse(proposal.expires_at) }).phase).toBe('expired');
});

it('keeps a committed record saved after audio expires and never claims acknowledgement', () => {
  const result = deriveReceipt({ phase: 'processing', status: status('committed', 'committed', '2026-10-01T00:00:00Z'), home, nowMs: now });
  expect(result.phase).toBe('committed'); expect(result.primaryAction).toBe(null);
  expect(result.detail).not.toMatch(/seen|delivered/i); expect(result.recipients).toEqual(['Lin']);
});

it('enriches only an exact, visible record from fresh Home', () => {
  const saved = { status: 'committed', record_type: 'health_note', record_id: 'note_1' };
  const visible = deriveReceipt({ phase: 'committed', confirmation: saved, home, nowMs: now });
  expect(visible.detail).toContain('Shoulder feels sore');
  for (const candidate of [null, { ...home, notes: [] }, { ...home, notes: [{ id: 'other', wording: 'Wrong note' }] }]) {
    const result = deriveReceipt({ phase: 'committed', confirmation: saved, home: candidate, nowMs: now });
    expect(result.phase).toBe('committed'); expect(result.detail).not.toContain('Shoulder feels sore'); expect(result.recipients).toEqual([]);
  }
  expect(deriveReceipt({ phase: 'committed', confirmation: saved, home: { ...home, notes: [{ ...home.notes[0], shared_with_user_ids: [] }] }, nowMs: now }).recipients).toEqual([]);
  expect(deriveReceipt({ phase: 'committed', confirmation: saved, home: { ...home, notes: [{ ...home.notes[0], shared_with_user_ids: ['person_1', 'missing'] }] }, nowMs: now }).recipients).toEqual([]);
});

it.each<[ReceiptPhase, ReceiptPhase]>([['receipt_unknown', 'receipt_unknown'], ['cancelled', 'cancelled'], ['failed', 'failed']])('%s is distinguishable', (phase, expected) => {
  expect(deriveReceipt({ phase, nowMs: now }).phase).toBe(expected);
});

it('renders an accessible, keyboard-usable check action', async () => {
  const onCheck = vi.fn(); const onReview = vi.fn();
  render(<RecordingReceipt view={deriveReceipt({ phase: 'receipt_unknown', pending: { key: 'opaque' }, nowMs: now })} busy={false} onCheck={onCheck} onReview={onReview}/>);
  expect(screen.getByRole('region', { name: 'Recording receipt' })).toBeTruthy();
  expect(screen.getByRole('status')).toBeTruthy();
  const button = screen.getByRole('button', { name: 'Check recording' }); button.focus();
  await userEvent.keyboard('{Enter}'); expect(onCheck).toHaveBeenCalledOnce(); expect(onReview).not.toHaveBeenCalled();
});
