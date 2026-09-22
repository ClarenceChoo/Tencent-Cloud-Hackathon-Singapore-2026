import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrf } from '../api';

afterEach(() => { vi.unstubAllGlobals(); setCsrf(''); });

describe('API validation errors', () => {
  it('turns FastAPI field errors into readable messages and sends CSRF on mutations', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-value');
      return new Response(JSON.stringify({ detail: [{ loc: ['body', 'systolic'], msg: 'Input should be less than or equal to 300' }] }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    setCsrf('csrf-value');

    await expect(api.createProposal('patient-1', 'measurement', {})).rejects.toThrow('systolic: Input should be less than or equal to 300');
  });
});
