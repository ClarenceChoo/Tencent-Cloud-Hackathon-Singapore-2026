import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';
const statement = 'A fictional private statement in a shared visit summary';
const shared = { patient: { name: 'Fictional Mei' }, read_only: true, summary: { sections: [{ title: 'Reported notes', items: [{ text: statement }] }], sources: [] } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
async function setup() {
  window.history.replaceState({}, '', '/shared/summaries/fictional-token');
  let poll!: () => Promise<void>;
  let next = async (): Promise<Response> => response(shared);
  const interval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((handler, delay, ...args) => {
    if (delay === 5000) { poll = handler as typeof poll; return 99; }
    return interval(handler, delay, ...args);
  });
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('scrollTo', vi.fn());
  const fetch = vi.fn((_url: unknown, _options: RequestInit) => next());
  vi.stubGlobal('fetch', fetch); render(<App/>); await screen.findByText(statement);
  return { fetch, visibility, startPoll: () => poll(), poll: () => act(async () => { await poll(); }), setNext: (value: typeof next) => { next = value; } };
}
it.each([404, 410])('removes displayed public summary after fresh HTTP %s', async status => {
  const app = await setup(); app.setNext(async () => response({ detail: 'Shared summary is no longer available' }, status));
  await app.poll(); expect(screen.queryByText(statement)).toBeNull();
  expect(screen.getByRole('heading', { name: 'This summary is unavailable' })).toBeTruthy();
  expect(app.fetch.mock.calls.every(([, options]) => options.cache === 'no-store')).toBe(true);
  const count = app.fetch.mock.calls.length; await app.poll(); expect(app.fetch).toHaveBeenCalledTimes(count);
});
it('clears content on connection failure and restores only a successful fresh read', async () => {
  const app = await setup(); app.setNext(async () => response({ detail: 'Temporary connection failure' }, 503));
  await app.poll(); expect(screen.queryByText(statement)).toBeNull(); expect(screen.getByText('Temporary connection failure')).toBeTruthy();
  app.setNext(async () => response(shared)); await app.poll(); expect(screen.getByText(statement)).toBeTruthy();
  expect(screen.queryByText('Temporary connection failure')).toBeNull();
});
it('hides on background, ignores an old response and rechecks access before showing a resumed page', async () => {
  const app = await setup(); let complete!: (value: Response) => void;
  app.setNext(() => new Promise(resolve => { complete = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = app.startPoll(); });
  const signal = app.fetch.mock.calls.at(-1)![1].signal!;
  app.visibility.mockReturnValue('hidden');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(signal.aborted).toBe(true); expect(screen.queryByText(statement)).toBeNull();
  await act(async () => { complete(response(shared)); await pending; }); expect(screen.queryByText(statement)).toBeNull();
  const count = app.fetch.mock.calls.length; await app.poll(); expect(app.fetch).toHaveBeenCalledTimes(count);
  app.setNext(async () => response({ detail: 'Revoked while away' }, 410)); app.visibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await screen.findByText('Revoked while away'); expect(screen.queryByText(statement)).toBeNull();
});
it('revalidates a page-cache restore without overlapping a slow request with polling', async () => {
  const app = await setup(); let complete!: (value: Response) => void;
  app.setNext(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => { window.dispatchEvent(new Event('pageshow')); }); expect(screen.queryByText(statement)).toBeNull();
  const count = app.fetch.mock.calls.length; await app.poll(); expect(app.fetch).toHaveBeenCalledTimes(count);
  await act(async () => { complete(response({ detail: 'Expired during browser suspension' }, 410)); });
  await screen.findByText('Expired during browser suspension'); expect(screen.queryByText(statement)).toBeNull();
});
it('bounds a stalled access check and ignores its late success', async () => {
  const app = await setup(); vi.useFakeTimers(); let complete!: (value: Response) => void;
  app.setNext(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  const signal = app.fetch.mock.calls.at(-1)![1].signal!;
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(signal.aborted).toBe(true); expect(screen.queryByText(statement)).toBeNull();
  expect(screen.getByText(/Could not check this shared summary/)).toBeTruthy();
  await act(async () => { complete(response(shared)); }); expect(screen.queryByText(statement)).toBeNull();
});

it('labels authored questions separately and never renders private actor identifiers', async () => {
  const app = await setup();
  const withQuestion = { ...shared, summary: { ...shared.summary, purpose: 'family_handoff',
    sections: [...shared.summary.sections, { kind: 'authored_questions', title: 'Questions written by a caregiver',
      items: [{ text: 'Was there an unrecorded fall?', author_display_name: 'Fictional caregiver',
        authored_at: '2026-10-02T08:30:00Z' }] }],
    questions: [{ text: 'Was there an unrecorded fall?', author_display_name: 'Fictional caregiver',
      authored_at: '2026-10-02T08:30:00Z' }] } };
  app.setNext(async () => response(withQuestion)); await app.poll();
  expect(screen.getByText('Was there an unrecorded fall?')).toBeTruthy();
  expect(screen.getByText(/Authored question · Fictional caregiver/)).toBeTruthy();
  expect(screen.getByText(/Family handoff · reviewed care summary/)).toBeTruthy();
  expect(document.body.textContent).not.toContain('user_private_id');
  expect(document.body.textContent).not.toContain('caregiver@example.invalid');
});
