import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SummaryPrint } from '../SummaryPrint';
import type { Row } from '../api';

const reviewed: Row = {
  id: 'summary_1', patient_id: 'patient_1', status: 'reviewed',
  purpose: 'family_handoff', template_version: 1,
  start_date: '2026-10-01', end_date: '2026-10-02',
  created_at: '2026-10-02T08:00:00Z', reviewed_at: '2026-10-02T09:00:00Z', invalidated_at: null,
  sources: [{ id: 'note_1', type: 'health_note', version: 2 }],
  sections: [
    { title: 'Reported concerns in selected period', items: [{ text: 'Fictional report', source_id: 'note_1' }] },
    { kind: 'authored_questions', title: 'Questions written by a caregiver', items: [{ text: 'Could this be discussed?', author_display_name: 'Owner', authored_at: '2026-10-02T08:30:00Z' }] },
  ],
};

beforeEach(() => {
  vi.stubGlobal('print', vi.fn());
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function view(loadCurrentSummary: (id: string, signal: AbortSignal) => Promise<Row>) {
  return render(<SummaryPrint summary={reviewed} patientId="patient_1" patientName="Fictional Mei"
    identityKey="session_1:patient_1" loadCurrentSummary={loadCurrentSummary} />);
}

it('fetches a fresh reviewed summary before opening print and includes provenance and question labels', async () => {
  const load = vi.fn(async () => reviewed);
  view(load);
  expect(window.print).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
  await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
  expect(load).toHaveBeenCalledWith('summary_1', expect.any(AbortSignal));
  expect(screen.getByText('2026-10-01 – 2026-10-02')).toBeTruthy();
  expect(screen.getByText(/Source: health_note · note_1 · version 2/)).toBeTruthy();
  expect(screen.getByText(/Authored question · Owner/)).toBeTruthy();
  expect(screen.getAllByText(/cannot be revoked/).length).toBeGreaterThan(0);
  fireEvent(window, new Event('afterprint'));
  await waitFor(() => expect(screen.queryByText('Fictional report')).toBeNull());
});

it.each([
  { status: 'draft' },
  { invalidated_at: '2026-10-02T09:30:00Z' },
  { reviewed_at: null },
  { patient_id: 'patient_2' },
  { id: 'summary_other' },
  { purpose: 'weekly_review' },
  { reviewed_at: '2026-10-02T09:30:00Z' },
  { sources: [{ id: 'note_1', type: 'health_note', version: 3 }] },
])('blocks stale or unreviewed content: %j', async patch => {
  view(async () => ({ ...reviewed, ...patch }));
  fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
  await screen.findByRole('alert');
  expect(window.print).not.toHaveBeenCalled();
  expect(screen.queryByText('Fictional report')).toBeNull();
});

it('does not print after an access failure', async () => {
  view(async () => { throw new Error('403'); });
  fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not check access to this summary. Please try again.');
  expect(window.print).not.toHaveBeenCalled();
});

it('aborts and ignores a late print result after patient or session changes', async () => {
  let finish!: (row: Row) => void;
  const load = vi.fn((_id: string, _signal: AbortSignal) => new Promise<Row>(resolve => { finish = resolve; }));
  const rendered = view(load);
  fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
  const signal = load.mock.calls[0][1];
  rendered.rerender(<SummaryPrint summary={reviewed} patientId="patient_2" patientName="Other patient"
    identityKey="session_2:patient_2" loadCurrentSummary={load} />);
  expect(signal.aborted).toBe(true);
  finish(reviewed);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeTruthy());
  expect(window.print).not.toHaveBeenCalled();
  expect(screen.queryByText('Fictional report')).toBeNull();
});

it('aborts an old preparation when local summary content changes under the same identity', async () => {
  let finish!: (row: Row) => void;
  const load = vi.fn((_id: string, _signal: AbortSignal) => new Promise<Row>(resolve => { finish = resolve; }));
  const rendered = view(load);
  fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
  const signal = load.mock.calls[0][1];
  rendered.rerender(<SummaryPrint summary={{ ...reviewed, sections: [] }} patientId="patient_1" patientName="Fictional Mei"
    identityKey="session_1:patient_1" loadCurrentSummary={load} />);
  expect(signal.aborted).toBe(true);
  finish(reviewed);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeTruthy());
  expect(window.print).not.toHaveBeenCalled();
  expect(screen.queryByText('Fictional report')).toBeNull();
});

it('aborts preparation on unmount', () => {
  const load = vi.fn((_id: string, _signal: AbortSignal) => new Promise<Row>(() => {}));
  const rendered = view(load);
  fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
  const signal = load.mock.calls[0][1];
  rendered.unmount();
  expect(signal.aborted).toBe(true);
  expect(window.print).not.toHaveBeenCalled();
});
