import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError, VocabularyView } from '../api';
import { CareVocabulary, vocabularyError } from '../CareVocabulary';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const empty: VocabularyView = { version: 0, terms: [], reviewed_by_user_id: null, reviewed_at: null };

it('keeps reviewed names private when profile management is absent', () => {
  const get = vi.spyOn(api, 'vocabulary');
  render(<CareVocabulary patientId="patient-a" canManage={false} onAccessLost={vi.fn()}/>);
  expect(screen.getByText(/Only an account with profile management permission/)).toBeTruthy();
  expect(get).not.toHaveBeenCalled();
});

it('requires review and explicit save for checked-plan suggestions', async () => {
  vi.spyOn(api, 'vocabulary').mockResolvedValue(empty);
  vi.spyOn(api, 'vocabularySuggestions').mockResolvedValue({ suggestions: [{ canonical: 'Fictional Med A', aliases: [], category: 'medicine' }] });
  const save = vi.spyOn(api, 'updateVocabulary').mockResolvedValue({ ...empty, version: 1, terms: [{ canonical: 'Fictional Med A', aliases: [], category: 'medicine' }] });
  render(<CareVocabulary patientId="patient-a" canManage onAccessLost={vi.fn()}/>);
  expect(await screen.findByRole('button', { name: 'Add Fictional Med A' })).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add Fictional Med A' }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewed names' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('patient-a', 0, [{ canonical: 'Fictional Med A', aliases: [], category: 'medicine' }]));
  expect(screen.getByText(/Custom vocabulary for speech recognition is unavailable/)).toBeTruthy();
});

it('retains unsaved entries after a stale-version conflict for comparison', async () => {
  const get = vi.spyOn(api, 'vocabulary').mockResolvedValueOnce(empty).mockResolvedValueOnce({ ...empty, version: 2, terms: [{ canonical: 'Current saved name', aliases: [], category: 'person' }] });
  vi.spyOn(api, 'vocabularySuggestions').mockResolvedValue({ suggestions: [] });
  vi.spyOn(api, 'updateVocabulary').mockRejectedValue(new ApiError('Stale version', 409));
  render(<CareVocabulary patientId="patient-a" canManage onAccessLost={vi.fn()}/>);
  await screen.findByText(/Version 0/);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewed name' }));
  fireEvent.change(screen.getByLabelText('Checked name'), { target: { value: 'My unsaved name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewed names' }));
  await screen.findByRole('heading', { name: /Current saved version 2/ });
  expect((screen.getByLabelText('Checked name') as HTMLInputElement).value).toBe('My unsaved name');
  expect(screen.getByText(/Current saved name/)).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(2);
});

it('rejects normalized collisions and excess limits before saving', () => {
  expect(vocabularyError([{ canonical: 'Ａlice', aliases: [], category: 'person' }, { canonical: 'Alice', aliases: [], category: 'person' }])).toMatch(/more than one/);
  expect(vocabularyError([{ canonical: 'Med', aliases: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], category: 'medicine' }])).toMatch(/at most 5/);
  expect(vocabularyError([{ canonical: 'x'.repeat(81), aliases: [], category: 'other' }])).toMatch(/1–80/);
  expect(vocabularyError(Array.from({ length: 101 }, (_, index) => ({ canonical: `Name ${index}`, aliases: [], category: 'other' })))).toMatch(/at most 100/);
});

it.each(['save', 'conflict refresh'])('ignores a late denied %s after switching patients', async phase => {
  const accessLost = vi.fn();
  let rejectSave!: (error: Error) => void;
  let rejectRefresh!: (error: Error) => void;
  vi.spyOn(api, 'vocabulary').mockImplementation(patientId => {
    if (patientId === 'patient-b') return Promise.resolve(empty);
    if (phase === 'conflict refresh' && typeof rejectSave === 'function') return new Promise((_, reject) => { rejectRefresh = reject; });
    return Promise.resolve(empty);
  });
  vi.spyOn(api, 'vocabularySuggestions').mockResolvedValue({ suggestions: [] });
  vi.spyOn(api, 'updateVocabulary').mockImplementation(() => new Promise((_, reject) => { rejectSave = reject; }));
  const { rerender } = render(<CareVocabulary key="patient-a" patientId="patient-a" canManage onAccessLost={accessLost}/>);
  await screen.findByText(/Version 0/);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewed name' }));
  fireEvent.change(screen.getByLabelText('Checked name'), { target: { value: 'Fictional name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewed names' }));
  await waitFor(() => expect(rejectSave).toBeTypeOf('function'));
  if (phase === 'conflict refresh') {
    rejectSave(new ApiError('Stale', 409));
    await waitFor(() => expect(rejectRefresh).toBeTypeOf('function'));
  }
  rerender(<CareVocabulary key="patient-b" patientId="patient-b" canManage onAccessLost={accessLost}/>);
  await screen.findByText(/Version 0/);
  if (phase === 'save') rejectSave(new ApiError('Denied', 403));
  else rejectRefresh(new ApiError('Denied', 403));
  await Promise.resolve();
  expect(accessLost).not.toHaveBeenCalled();
  expect(screen.queryByText(/Fictional name/)).toBeNull();
});
