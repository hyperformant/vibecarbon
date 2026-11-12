/**
 * The state passphrase fingerprint is scrypt (src/lib/state-passphrase.js),
 * about 45 ms a call, and one command compares the same value more than once
 * (the first look, case 2's re-check, destroy's problem check). Each value is
 * derived once per process.
 */
import { describe, expect, it, vi } from 'vitest';

const derive = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (orig) => {
  const real = await orig<typeof import('node:crypto')>();
  return {
    ...real,
    scryptSync: (...args: Parameters<typeof real.scryptSync>) => {
      derive.calls += 1;
      return real.scryptSync(...args);
    },
  };
});

const { statePassphraseFingerprint } = await import('../../../src/lib/state-passphrase.js');

describe('statePassphraseFingerprint', () => {
  it('derives each value once per process, and the same fingerprint every time', () => {
    const a = 'c'.repeat(43);
    const b = 'd'.repeat(43);
    const first = statePassphraseFingerprint(a);
    expect(statePassphraseFingerprint(a)).toBe(first);
    expect(statePassphraseFingerprint(a)).toBe(first);
    expect(derive.calls).toBe(1);
    expect(statePassphraseFingerprint(b)).not.toBe(first);
    expect(derive.calls).toBe(2);
  });
});
