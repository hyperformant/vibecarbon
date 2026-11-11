import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import * as p from '@clack/prompts';
import {
  __resetStatePassphraseForTests,
  ensureStatePassphrase,
  generateStatePassphrase,
  resolveStatePassphrase,
  STATE_PASSPHRASE_KEY,
  StatePassphraseError,
  statePassphraseFingerprint,
} from '../../../src/lib/state-passphrase.js';

const KEY = 'VIBECARBON_STATE_PASSPHRASE';

describe('state passphrase', () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-state-pass-'));
    savedEnv = process.env[KEY];
    delete process.env[KEY];
    __resetStatePassphraseForTests();
    vi.mocked(p.log.info).mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env[KEY];
    else process.env[KEY] = savedEnv;
  });

  const manifest = () => JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8'));
  const writeManifest = (fp: string) =>
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ stateEncryption: { fingerprint: fp } }),
    );

  it('generates a 256-bit base64url value and a stable sha256:16hex fingerprint', () => {
    const a = generateStatePassphrase();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateStatePassphrase()).not.toBe(a);
    expect(statePassphraseFingerprint(a)).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(statePassphraseFingerprint(a)).toBe(statePassphraseFingerprint(a));
    expect(statePassphraseFingerprint('x')).not.toBe(statePassphraseFingerprint('y'));
  });

  it('resolveStatePassphrase reads only the environment', () => {
    expect(resolveStatePassphrase()).toBeNull();
    process.env[KEY] = 'a-passphrase-of-some-length';
    expect(resolveStatePassphrase()).toBe('a-passphrase-of-some-length');
  });

  it('case 1: value and matching fingerprint return the value', async () => {
    const v = generateStatePassphrase();
    process.env[KEY] = v;
    writeManifest(statePassphraseFingerprint(v));
    expect(await ensureStatePassphrase(dir)).toBe(v);
    expect(p.log.info).not.toHaveBeenCalled();
  });

  it('case 2: value without a fingerprint records the fingerprint', async () => {
    const v = generateStatePassphrase();
    process.env[KEY] = v;
    expect(await ensureStatePassphrase(dir)).toBe(v);
    expect(manifest().stateEncryption.fingerprint).toBe(statePassphraseFingerprint(v));
  });

  it('case 3: a mismatch throws, naming both fingerprints and the source', async () => {
    const v = generateStatePassphrase();
    process.env[KEY] = v;
    writeManifest('sha256:0000000000000000');
    const err = await ensureStatePassphrase(dir).catch((e) => e);
    expect(err).toBeInstanceOf(StatePassphraseError);
    expect(err.reason).toBe('mismatch');
    expect(err.message).toContain('sha256:0000000000000000');
    expect(err.message).toContain(statePassphraseFingerprint(v));
    expect(err.message).toContain('your shell environment');
    expect(err.message).not.toContain(v);
  });

  it('case 4: a fingerprint without a value throws missing', async () => {
    writeManifest('sha256:abcdabcdabcdabcd');
    const err = await ensureStatePassphrase(dir).catch((e) => e);
    expect(err).toBeInstanceOf(StatePassphraseError);
    expect(err.reason).toBe('missing');
    expect(err.message).toContain('sha256:abcdabcdabcdabcd');
    expect(err.message).toContain(STATE_PASSPHRASE_KEY);
  });

  it('case 5: neither generates, saves to .env.local only, records the fingerprint, logs once', async () => {
    const v = await ensureStatePassphrase(dir);
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(process.env[KEY]).toBe(v);
    expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toContain(`${KEY}=`);
    expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toContain(v);
    expect(existsSync(join(dir, '.env'))).toBe(false);
    expect(manifest().stateEncryption.fingerprint).toBe(statePassphraseFingerprint(v));
    expect(p.log.info).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(p.log.info).mock.calls[0][0])).not.toContain(v);
  });

  it('case 5 does not write an existing .env', async () => {
    writeFileSync(join(dir, '.env'), 'FOO=bar\n');
    const v = await ensureStatePassphrase(dir);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('FOO=bar\n');
    expect(readFileSync(join(dir, '.env'), 'utf-8')).not.toContain(v);
  });

  it('the next call after generating succeeds (fingerprint was recorded)', async () => {
    const v = await ensureStatePassphrase(dir);
    __resetStatePassphraseForTests();
    expect(await ensureStatePassphrase(dir)).toBe(v);
  });

  it('is memoized per project dir', async () => {
    const v = await ensureStatePassphrase(dir);
    // Corrupt the fingerprint: the memo means no re-check this process.
    writeManifest('sha256:0000000000000000');
    expect(await ensureStatePassphrase(dir)).toBe(v);
    const other = mkdtempSync(join(tmpdir(), 'vc-state-pass-'));
    try {
      writeFileSync(
        join(other, '.vibecarbon.json'),
        JSON.stringify({ stateEncryption: { fingerprint: 'sha256:1111111111111111' } }),
      );
      await expect(ensureStatePassphrase(other)).rejects.toMatchObject({ reason: 'mismatch' });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('concurrent ensures yield one value', async () => {
    mkdirSync(dir, { recursive: true });
    const [a, b, c] = await Promise.all([
      ensureStatePassphrase(dir),
      ensureStatePassphrase(dir),
      ensureStatePassphrase(dir),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(manifest().stateEncryption.fingerprint).toBe(statePassphraseFingerprint(a));
    expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toContain(a);
    expect(p.log.info).toHaveBeenCalledTimes(1);
  });
});
