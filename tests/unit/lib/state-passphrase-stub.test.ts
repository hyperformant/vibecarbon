/**
 * tests/_shared/state-passphrase-stub.ts: the state passphrase module the
 * fake-workspace iac tests mock in. It keeps every real export and answers
 * ensureStatePassphrase with a fixed value, writing nothing.
 */
import { describe, expect, it } from 'vitest';
import * as real from '../../../src/lib/state-passphrase.js';
import { fixedStatePassphrase } from '../../_shared/state-passphrase-stub.js';

describe('fixedStatePassphrase', () => {
  it('answers ensureStatePassphrase with test-passphrase for any project directory', async () => {
    const stub = fixedStatePassphrase(real);
    await expect(stub.ensureStatePassphrase()).resolves.toBe('test-passphrase');
  });

  it('keeps every other export of the real module, the same function', () => {
    const stub = fixedStatePassphrase(real) as Record<string, unknown>;
    const others = Object.keys(real).filter((k) => k !== 'ensureStatePassphrase');
    expect(others.length).toBeGreaterThan(0);
    for (const k of others) expect(stub[k], k).toBe((real as Record<string, unknown>)[k]);
    expect(stub.ensureStatePassphrase).not.toBe(real.ensureStatePassphrase);
  });
});
