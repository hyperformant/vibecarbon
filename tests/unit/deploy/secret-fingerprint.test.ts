import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fingerprintKey,
  fingerprintSecret,
  resetFingerprintKeyCache,
  secretHmac,
} from '../../../src/lib/deploy/secret-fingerprint.js';

let dir: string;
beforeEach(() => {
  resetFingerprintKeyCache();
  dir = mkdtempSync(join(tmpdir(), 'vc-fp-'));
});
afterEach(() => {
  resetFingerprintKeyCache();
  rmSync(dir, { recursive: true, force: true });
});
const keyFile = () => join(dir, 'fingerprint.key');

describe('secret-fingerprint', () => {
  it('mints a 32-byte hex key at mode 0600 and reuses it', () => {
    const k = fingerprintKey({ dir });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    resetFingerprintKeyCache();
    expect(fingerprintKey({ dir })).toBe(k);
  });

  it('distinct values give distinct HMACs, same value is stable, and it is not a plain sha256', () => {
    const a = fingerprintSecret('alpha', { dir });
    expect(fingerprintSecret('alpha', { dir })).toBe(a);
    expect(fingerprintSecret('beta', { dir })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(createHash('sha256').update('alpha').digest('hex').slice(0, 16));
    expect(secretHmac({ dir }).update('alpha').digest('hex').slice(0, 16)).toBe(a);
  });

  it('refuses a short or corrupt key file instead of HMACing with it', () => {
    writeFileSync(keyFile(), 'abc\n');
    expect(() => fingerprintKey({ dir })).toThrow(/does not hold a 32-byte key/);
    resetFingerprintKeyCache();
    writeFileSync(keyFile(), '');
    expect(() => fingerprintKey({ dir })).toThrow(/does not hold a 32-byte key/);
  });

  it('a concurrent mint that loses the race adopts the winner key', () => {
    const winner = 'ab'.repeat(32);
    mkdirSync(dir, { recursive: true });
    // The winner's file lands between our first read and our exclusive create.
    // Simulate with the file already present and valid: we must read it, not overwrite.
    writeFileSync(keyFile(), `${winner}\n`, { mode: 0o600 });
    expect(fingerprintKey({ dir })).toBe(winner);
  });

  it('tightens a group/world-readable key file to 0600', () => {
    writeFileSync(keyFile(), `${'cd'.repeat(32)}\n`, { mode: 0o644 });
    fingerprintKey({ dir });
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
  });

  it('keeps one stable key per process when the directory is unwritable', () => {
    const blocked = join(dir, 'file-not-dir');
    writeFileSync(blocked, 'x');
    const k1 = fingerprintKey({ dir: join(blocked, 'sub') });
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintKey({ dir: join(blocked, 'sub') })).toBe(k1);
  });
});
