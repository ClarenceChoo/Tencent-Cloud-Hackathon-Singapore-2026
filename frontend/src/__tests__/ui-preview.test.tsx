import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); window.history.replaceState({}, '', '/'); });

async function preview() {
  vi.stubEnv('VITE_UI_PREVIEW', 'true');
  vi.resetModules();
  vi.stubGlobal('scrollTo', vi.fn());
  const fetch = vi.fn(() => { throw new Error('Preview attempted a network request'); });
  vi.stubGlobal('fetch', fetch);
  const { default: App } = await import('../App');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading', { name: /maya’s care timeline/i });
  return fetch;
}

it('opens sample care views without login or backend traffic', async () => {
  const fetch = await preview();
  expect(screen.getByText(/UI demo · fictional sample data/)).toBeTruthy();
  expect(screen.queryByLabelText('Email address')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  expect(await screen.findByRole('heading', { name: /walk in the garden/i })).toBeTruthy();
  for (const [tab, content] of [
    ['Today', 'Today’s medication check-ins'], ['Medications', 'Current instructions'],
    ['Care', 'Review the care plan at a routine appointment.'],
    ['Requests & follow-ups', 'Follow up together'], ['Timeline', 'Maya’s care timeline'], ['Prepare summary', 'A summary you can review'],
    ['Settings', 'How the companion addresses them'],
  ]) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^' + tab) }));
    expect(screen.getByText(content, { exact: false })).toBeTruthy();
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('shows fictional Log activity and filters it without backend traffic', async () => {
  const fetch = await preview();
  fireEvent.click(screen.getByRole('button', { name: 'Log' }));
  await screen.findByRole('heading', { name: 'Care note confirmed' });
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'notes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await screen.findByText('1 entry loaded');
  expect(screen.queryByRole('heading', { name: 'Medication report confirmed' })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('blocks dashboard mutations and private shared links without network calls', async () => {
  const fetch = await preview();
  fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
  fireEvent.change(screen.getByRole('textbox', { name: /what would you like recorded/i }), { target: { value: 'Test note' } });
  fireEvent.click(screen.getByRole('button', { name: /review proposal/i }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/UI demo only.*not saved or shared/i);
  expect(fetch).not.toHaveBeenCalled();

  const { api } = await import('../api');
  await expect(api.sharedSummary('private-token')).rejects.toThrow(/UI demo only/);
  await expect(api.claimDevice('CODE', 'sample-patient')).rejects.toThrow(/UI demo only/);
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps a shared-summary URL inside the fictional dashboard', async () => {
  window.history.replaceState({}, '', '/shared/summaries/private-token');
  const fetch = await preview();
  expect(screen.getByText(/UI demo · fictional sample data/)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps the ordinary API authenticated when the flag is absent', async () => {
  vi.stubEnv('VITE_UI_PREVIEW', 'false');
  vi.resetModules();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ detail: 'Sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('../api');
  await expect(api.session()).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledWith('/v1/auth/session', expect.anything());
});

it('renders the companion route without voice or enrollment traffic', async () => {
  vi.stubEnv('VITE_UI_PREVIEW', 'true');
  vi.resetModules();
  window.history.replaceState({}, '', '/companion');
  document.body.innerHTML = '<div id="root"></div>';
  const fetch = vi.fn(() => { throw new Error('Companion preview attempted a network request'); });
  vi.stubGlobal('fetch', fetch);
  await import('../main');
  expect(await screen.findByRole('heading', { name: 'Companion preview' })).toBeTruthy();
  expect(screen.getByText(/does not use the microphone/i)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
