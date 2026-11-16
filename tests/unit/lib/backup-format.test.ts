import { describe, expect, it } from 'vitest';
import { formatInstant } from '../../../src/lib/backup-format.js';

describe('formatInstant', () => {
  const now = new Date(2026, 4, 19, 14, 30, 0); // 2026-05-19 14:30 local

  it('formats a Date with relative labels', () => {
    expect(formatInstant(new Date(2026, 4, 19, 12, 0, 0), now)).toBe('Today, 12:00 PM');
    expect(formatInstant(new Date(2026, 4, 18, 18, 0, 0), now)).toBe('Yesterday, 6:00 PM');
    expect(formatInstant(new Date(2026, 4, 19, 0, 0, 1), now)).toBe('Today, 12:00 AM');
    expect(formatInstant(new Date(2025, 11, 31, 18, 0, 1), now)).toBe('Dec 31 2025, 6:00 PM');
  });

  it('accepts ISO-8601 strings (wal-g time field)', () => {
    // 2026-05-17T12:00:00 local — construct via local Date to avoid TZ drift.
    const local = new Date(2026, 4, 17, 12, 0, 0);
    expect(formatInstant(local.toISOString(), now)).toBe('May 17, 12:00 PM');
  });

  it('returns "" for unparseable input', () => {
    expect(formatInstant('not-a-date', now)).toBe('');
    expect(formatInstant(new Date('nope'), now)).toBe('');
  });
});
