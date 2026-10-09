import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivityLog } from '../ActivityLog';
import { api, ApiError, ActivityPage } from '../api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const entry = { id: 'confirmed:one', recorded_at: '2026-10-08T16:30:00Z', event: 'Care note confirmed',
  category: 'notes', summary: 'Fictional walk report', status: 'confirmed', source: 'Browser companion', record_id: 'one' };
const page = (items = [entry], cursor: string | null = null): ActivityPage => ({ items, next_cursor: cursor, timezone: 'Asia/Singapore' });
const props = { patientId: 'p', timezone: 'Asia/Singapore', accessRevision: 'original', onAccessLost: vi.fn() };

it('loads safe activity and requests older pages without duplicating existing entries', async () => {
  const activity = vi.spyOn(api, 'activity').mockResolvedValueOnce(page([entry], 'older')).mockResolvedValueOnce(page([entry, { ...entry, id: 'proposal:two', event: 'Care note proposed', status: 'pending' }]));
  render(<ActivityLog {...props}/>);
  await screen.findByRole('heading', { name: 'Care note confirmed' });
  expect(screen.getByText(/9 Oct 2026/)).toBeTruthy(); // patient's timezone, not browser timezone
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  await screen.findByRole('heading', { name: 'Care note proposed' });
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(activity.mock.calls[1][1]).toMatchObject({ cursor: 'older' });
});

it('applies server search/category/date filters and validates the date range', async () => {
  const activity = vi.spyOn(api, 'activity').mockResolvedValue(page());
  render(<ActivityLog {...props}/>);
  await screen.findByRole('heading', { name: 'Care note confirmed' });
  fireEvent.change(screen.getByLabelText('Search activity'), { target: { value: 'walk' } });
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'notes' } });
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-09' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-08' } });
  expect((screen.getByRole('button', { name: 'Apply filters' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-09' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await waitFor(() => expect(activity).toHaveBeenCalledTimes(2));
  expect(activity.mock.calls[1][1]).toEqual({ search: 'walk', category: 'notes', start: '2026-10-09', end: '2026-10-09' });
});

it('ignores an old response after switching care space and clears old activity immediately', async () => {
  let finish!: (value: ActivityPage) => void;
  const activity = vi.spyOn(api, 'activity').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(page([], null));
  const view = render(<ActivityLog {...props}/>);
  view.rerender(<ActivityLog {...props} patientId="other"/>);
  await screen.findByRole('heading', { name: 'No recorded activity matches' });
  await act(async () => { finish(page()); });
  expect(screen.queryByText('Fictional walk report')).toBeNull();
  expect(activity.mock.calls[0][2]?.aborted).toBe(true);
});

it('removes previously loaded content when record sharing changes', async () => {
  vi.spyOn(api, 'activity').mockResolvedValueOnce(page()).mockResolvedValueOnce(page([]));
  const view = render(<ActivityLog {...props}/>);
  await screen.findByText('Fictional walk report');
  view.rerender(<ActivityLog {...props} accessRevision="sharing-removed"/>);
  expect(screen.queryByText('Fictional walk report')).toBeNull();
  await screen.findByRole('heading', { name: 'No recorded activity matches' });
});

it('clears earlier pages and reports access loss on a denied older-page request', async () => {
  const onAccessLost = vi.fn();
  vi.spyOn(api, 'activity').mockResolvedValueOnce(page([entry], 'cursor')).mockRejectedValueOnce(new ApiError('Revoked', 403));
  render(<ActivityLog {...props} onAccessLost={onAccessLost}/>);
  await screen.findByText('Fictional walk report');
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  await waitFor(() => expect(onAccessLost).toHaveBeenCalledOnce());
  expect(screen.queryByText('Fictional walk report')).toBeNull();
});

it('shows a recoverable error instead of a successful empty log on service failure', async () => {
  vi.spyOn(api, 'activity').mockRejectedValueOnce(new ApiError('Service unavailable', 503)).mockResolvedValueOnce(page());
  render(<ActivityLog {...props}/>);
  expect((await screen.findByRole('alert')).textContent).toContain('Service unavailable');
  expect(screen.queryByRole('heading', { name: 'No recorded activity matches' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh log' }));
  await screen.findByText('Fictional walk report');
});
