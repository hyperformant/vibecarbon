import { describe, expect, it } from 'vitest';
import {
  formatBackupTime,
  formatInstant,
  parseBackupTime,
} from '../../../src/lib/backup-format.js';

describe('parseBackupTime', () => {
  it('parses the embedded _YYYYMMDD_HHMMSS_ timestamp', () => {
    const d = parseBackupTime('vibecarbon-web_20260519_120001_full.tar.gz');
    expect(d).not.toBeNull();
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(4); // May (0-indexed)
    expect(d?.getDate()).toBe(19);
    expect(d?.getHours()).toBe(12);
    expect(d?.getMinutes()).toBe(0);
  });

  it('returns null when there is no timestamp', () => {
    expect(parseBackupTime('not-a-backup.txt')).toBeNull();
    expect(parseBackupTime('')).toBeNull();
    expect(parseBackupTime(undefined as unknown as string)).toBeNull();
  });
});

describe('formatBackupTime', () => {
  const now = new Date(2026, 4, 19, 14, 30, 0); // 2026-05-19 14:30 local

  it('labels same-day backups as Today + clock time', () => {
    expect(formatBackupTime('p_20260519_120001_full.tar.gz', now)).toBe('Today, 12:00 PM');
    expect(formatBackupTime('p_20260519_000001_full.tar.gz', now)).toBe('Today, 12:00 AM');
  });

  it('labels the prior day as Yesterday', () => {
    expect(formatBackupTime('p_20260518_180001_full.tar.gz', now)).toBe('Yesterday, 6:00 PM');
  });

  it('labels same-year older backups as "Mon DD, time" (no year)', () => {
    expect(formatBackupTime('p_20260517_120001_full.tar.gz', now)).toBe('May 17, 12:00 PM');
  });

  it('includes the year for prior-year backups', () => {
    expect(formatBackupTime('p_20251231_180001_full.tar.gz', now)).toBe('Dec 31 2025, 6:00 PM');
  });

  it('falls back to the raw name when there is no parseable timestamp', () => {
    expect(formatBackupTime('mystery.tar.gz', now)).toBe('mystery.tar.gz');
  });
});

describe('formatInstant', () => {
  const now = new Date(2026, 4, 19, 14, 30, 0); // 2026-05-19 14:30 local

  it('formats a Date with the same relative labels', () => {
    expect(formatInstant(new Date(2026, 4, 19, 12, 0, 0), now)).toBe('Today, 12:00 PM');
    expect(formatInstant(new Date(2026, 4, 18, 18, 0, 0), now)).toBe('Yesterday, 6:00 PM');
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
