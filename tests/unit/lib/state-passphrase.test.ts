import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

// Lets a test hand ensureStatePassphrase a STALE fingerprint read (the one it
// takes before the config lock), as if another process landed in between.
vi.mock('../../../src/lib/config.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/lib/config.js')>();
  return { ...actual, readProjectConfigFile: vi.fn(actual.readProjectConfigFile) };
});

import * as p from '@clack/prompts';
import * as configModule from '../../../src/lib/config.js';
import { bootstrapOperatorEnv } from '../../../src/lib/project.js';
import {
  __resetStatePassphraseForTests,
  ensureStatePassphrase,
  findStatePassphraseProblem,
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
    const v = generateStatePassphrase();
    process.env[KEY] = v;
    expect(resolveStatePassphrase()).toBe(v);
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
    expect(err.source).toBe('shell');
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

  it('case 4: missing also says what to do when the passphrase is lost for good', async () => {
    writeManifest('sha256:abcdabcdabcdabcd');
    const err = await ensureStatePassphrase(dir).catch((e) => e);
    // Delete the fingerprint, then destroy and redeploy what the old value
    // deployed: destroy removes a record it can't read.
    expect(err.message).toContain(
      "If it's lost for good, delete the `stateEncryption` entry from .vibecarbon.json and vibecarbon makes a new passphrase the next time it needs one.",
    );
    expect(err.message).toContain(
      "Then run `vibecarbon destroy` and deploy again for each environment you deployed with the old one: its state can't be read any more, so destroy removes the record.",
    );
    expect(err.message).not.toContain('—');
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
    // A new process: the memo is gone and the env is rebuilt from .env.local
    // by the CLI's bootstrap, so this proves the file round trip.
    __resetStatePassphraseForTests();
    delete process.env[KEY];
    bootstrapOperatorEnv(dir);
    expect(process.env[KEY]).toBe(v);
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

  it('in-process calls after the first reuse its value (one log, one value)', async () => {
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

  it('a loser of the generate race adopts the winner without overwriting it', async () => {
    // The winner landed after this call's unlocked fingerprint read: its
    // fingerprint and .env.local are already on disk, this process has no env.
    const winner = generateStatePassphrase();
    writeManifest(statePassphraseFingerprint(winner));
    writeFileSync(join(dir, '.env.local'), `${KEY}=${winner}\n`);
    vi.mocked(configModule.readProjectConfigFile).mockReturnValueOnce(null);

    expect(await ensureStatePassphrase(dir)).toBe(winner);
    expect(process.env[KEY]).toBe(winner);
    expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toBe(`${KEY}=${winner}\n`);
    expect(manifest().stateEncryption.fingerprint).toBe(statePassphraseFingerprint(winner));
    expect(p.log.info).not.toHaveBeenCalled();
  });

  it('separate processes racing on one project end with one value and one fingerprint', async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'vc-state-pass-script-'));
    try {
      const script = join(scriptDir, 'ensure.mjs');
      const mod = pathToFileURL(resolve('src/lib/state-passphrase.js')).href;
      writeFileSync(
        script,
        `import { ensureStatePassphrase } from ${JSON.stringify(mod)};
const v = await ensureStatePassphrase(process.argv[2]);
console.log('RESULT ' + v);
`,
      );
      const env = { ...process.env };
      delete env[KEY];
      const run = () =>
        promisify(execFile)(process.execPath, [script, dir], { env, timeout: 60_000 });
      const outs = await Promise.all(Array.from({ length: 6 }, run));
      const values = outs.map((o) => /^RESULT (.+)$/m.exec(o.stdout)?.[1]);
      expect(new Set(values).size).toBe(1);
      const v = values[0] as string;
      expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(manifest().stateEncryption.fingerprint).toBe(statePassphraseFingerprint(v));
      expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toBe(
        `# Local-only environment overrides (not committed to git)\n${KEY}=${v}\n`,
      );
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  describe('a weak or malformed value is refused before use', () => {
    it.each([
      ['too short', 'short-but-urlsafe'],
      ['outside base64url', `${'a'.repeat(43)}!`],
      ['with a space', `${'a'.repeat(30)} ${'b'.repeat(30)}`],
    ])('%s: invalid, nothing recorded, value not echoed', async (_name, weak) => {
      process.env[KEY] = weak;
      expect(() => resolveStatePassphrase()).toThrow(StatePassphraseError);
      const err = await ensureStatePassphrase(dir).catch((e) => e);
      expect(err).toBeInstanceOf(StatePassphraseError);
      expect(err.reason).toBe('invalid');
      expect(err.message).toContain(STATE_PASSPHRASE_KEY);
      expect(err.message).not.toContain(weak);
      expect(existsSync(join(dir, '.vibecarbon.json'))).toBe(false);
    });

    it('a generated value is accepted', () => {
      const v = generateStatePassphrase();
      process.env[KEY] = v;
      expect(resolveStatePassphrase()).toBe(v);
    });

    it('a blank value counts as not set', () => {
      process.env[KEY] = '';
      expect(resolveStatePassphrase()).toBeNull();
    });
  });

  // destroy asks this instead of ensureStatePassphrase: it can tear down
  // without the passphrase, so it only needs to say what is wrong, and it
  // must never generate one or record a fingerprint on the way.
  describe('findStatePassphraseProblem: the same verdict, read-only', () => {
    const files = () => ({
      manifest: existsSync(join(dir, '.vibecarbon.json'))
        ? readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')
        : null,
      envLocal: existsSync(join(dir, '.env.local'))
        ? readFileSync(join(dir, '.env.local'), 'utf-8')
        : null,
    });

    it('null for a fresh project, and it makes nothing', () => {
      expect(findStatePassphraseProblem(dir)).toBeNull();
      expect(files()).toEqual({ manifest: null, envLocal: null });
      expect(process.env[KEY]).toBeUndefined();
    });

    it('null for a value without a fingerprint, and it records nothing', () => {
      writeFileSync(join(dir, '.vibecarbon.json'), '{}');
      process.env[KEY] = generateStatePassphrase();
      expect(findStatePassphraseProblem(dir)).toBeNull();
      expect(manifest()).toEqual({});
    });

    it('null when the value matches, from the shell or only from .env.local', () => {
      const v = generateStatePassphrase();
      writeManifest(statePassphraseFingerprint(v));
      process.env[KEY] = v;
      expect(findStatePassphraseProblem(dir)).toBeNull();
      delete process.env[KEY];
      writeFileSync(join(dir, '.env.local'), `${KEY}=${v}\n`);
      expect(findStatePassphraseProblem(dir)).toBeNull();
      // Read, not loaded into the environment.
      expect(process.env[KEY]).toBeUndefined();
    });

    it.each([
      ['missing', () => writeManifest('sha256:abcdabcdabcdabcd')],
      [
        'mismatch',
        () => {
          writeManifest('sha256:0000000000000000');
          process.env[KEY] = generateStatePassphrase();
        },
      ],
      [
        'invalid',
        () => {
          writeManifest('sha256:0000000000000000');
          process.env[KEY] = 'short-but-urlsafe';
        },
      ],
    ])('%s: the error ensureStatePassphrase throws, returned not thrown', async (reason, setup) => {
      setup();
      const before = files();
      const found = findStatePassphraseProblem(dir);
      expect(files()).toEqual(before);
      const thrown = await ensureStatePassphrase(dir).catch((e) => e);
      expect(found).toBeInstanceOf(StatePassphraseError);
      expect(found?.reason).toBe(reason);
      expect(found?.message).toBe(thrown.message);
    });

    // A value only in .env.local (this process started before it was
    // written) gets the same shape check as one in the environment, and the
    // message names the file it came from, not the shell.
    it.each([
      ['mismatch', () => generateStatePassphrase()],
      ['invalid', () => 'short-but-urlsafe'],
    ])('%s only in .env.local: the same verdict and words as ensure', async (reason, make) => {
      writeManifest('sha256:0000000000000000');
      // This process started before .env.local had the value: its startup
      // bootstrap loaded nothing (and forgets an earlier test's provenance).
      bootstrapOperatorEnv(dir);
      writeFileSync(join(dir, '.env.local'), `${KEY}=${make()}\n`);
      const found = findStatePassphraseProblem(dir);
      const thrown = await ensureStatePassphrase(dir).catch((e) => e);
      expect(found?.reason).toBe(reason);
      expect(thrown.reason).toBe(reason);
      expect(found?.message).toBe(thrown.message);
      expect(found?.source).toBe('env-local');
      expect(found?.message).toContain("your project's .env.local");
      expect(found?.message).not.toContain('shell');
      // A refused value is never folded into the environment.
      expect(process.env[KEY]).toBeUndefined();
    });
  });
});
