import { describe, expect, it } from 'vitest';
import { localDay, niceDate } from '../api';

describe('care dates', () => {
  it('uses the patient date across the Singapore midnight boundary', () => {
    const instant = new Date('2026-09-22T16:05:00Z');
    expect(localDay(instant, 'Asia/Singapore')).toBe('2026-09-23');
    expect(localDay(instant, 'America/Los_Angeles')).toBe('2026-09-22');
  });
  it('does not invent a time of day for an appointment date', () => {
    expect(niceDate('2026-09-23')).not.toMatch(/\d:\d/);
  });
});
