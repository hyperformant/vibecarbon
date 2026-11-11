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
  return {
    ...actual,
    readProjectConfigFile: vi.fn(actual.readProjectConfigFile),
    updateProjectConfig: vi.fn(actual.updateProjectConfig),
  };
});

// What git's HEAD holds for .vibecarbon.json (lib/git-head.js, which the
// integration tier runs against real repositories).
const gitHead = vi.hoisted(() => ({
  read: vi.fn((_dir: string): unknown => ({ state: 'no-git' })),
}));
vi.mock('../../../src/lib/git-head.js', () => ({
  readProjectConfigAtHead: (dir: string) => gitHead.read(dir),
}));

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
  statePassphraseGeneratedThisRun,
  statePassphraseProvenance,
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
    // A teammate has it; otherwise back up, delete the fingerprint, then
    // destroy and redeploy what the old value deployed: destroy removes a
    // record it can't read.
    expect(err.message).toContain(
      'Copy it into .env.local from where you saved it (a teammate who deployed this project has it too), then run this again.',
    );
    expect(err.message).toContain(
      "If it's lost for good, first run `vibecarbon backup` for each environment you deployed with it, to keep a copy of its database. Then delete the `stateEncryption` entry from .vibecarbon.json; vibecarbon makes a new passphrase the next time it needs one.",
    );
    expect(err.message).toContain(
      "Run `vibecarbon destroy` (once more if it asks) and deploy again for each of those environments: their state can't be read any more, so destroy removes the record.",
    );
    expect(err.message.indexOf('vibecarbon backup')).toBeLessThan(
      err.message.indexOf('vibecarbon destroy'),
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

  describe('an empty exported value counts as unset', () => {
    const stored = 'S'.repeat(43);
    const withStored = () => {
      writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
      writeFileSync(join(dir, '.env.local'), `${KEY}=${stored}\n`);
      process.env[KEY] = '';
    };

    it('ensure adopts the passphrase stored in .env.local and never overwrites it', async () => {
      withStored();
      await expect(ensureStatePassphrase(dir)).resolves.toBe(stored);
      expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toBe(`${KEY}=${stored}\n`);
      expect(manifest().stateEncryption.fingerprint).toBe(statePassphraseFingerprint(stored));
      expect(p.log.info).not.toHaveBeenCalled();
    });

    it('find reads the same value ensure would use', () => {
      withStored();
      expect(findStatePassphraseProblem(dir)).toBeNull();
      writeFileSync(join(dir, '.env.local'), `${KEY}=short\n`);
      expect(findStatePassphraseProblem(dir)?.reason).toBe('invalid');
    });

    it('a value of only spaces is not stored: a fresh passphrase and its fingerprint replace it', async () => {
      writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
      writeFileSync(join(dir, '.env.local'), `${KEY}="   "\n`);
      const made = await ensureStatePassphrase(dir);
      expect(made).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(manifest().stateEncryption.fingerprint).toBe(statePassphraseFingerprint(made));
      expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toContain(`${KEY}=${made}`);
    });

    describe('a writer landing .env.local between the look and the config lock', () => {
      const race = (line: string) => {
        writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
        const real = vi.mocked(configModule.updateProjectConfig).getMockImplementation();
        vi.mocked(configModule.updateProjectConfig).mockImplementationOnce((...args) => {
          writeFileSync(join(dir, '.env.local'), `${line}\n`);
          return (real as typeof configModule.updateProjectConfig)(...args);
        });
      };

      it('a valid value is adopted, never overwritten', async () => {
        const racer = 'R'.repeat(43);
        race(`${KEY}=${racer}`);
        await expect(ensureStatePassphrase(dir)).resolves.toBe(racer);
        expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toBe(`${KEY}=${racer}\n`);
        expect(manifest().stateEncryption.fingerprint).toBe(statePassphraseFingerprint(racer));
      });

      it('an untrimmed value is fingerprinted as the trimmed one', async () => {
        const racer = 'R'.repeat(43);
        race(`${KEY}="  ${racer}  "`);
        await expect(ensureStatePassphrase(dir)).resolves.toBe(racer);
        expect(manifest().stateEncryption.fingerprint).toBe(statePassphraseFingerprint(racer));
      });

      it('a weak value is refused and never fingerprinted', async () => {
        race(`${KEY}=weak`);
        await expect(ensureStatePassphrase(dir)).rejects.toMatchObject({ reason: 'invalid' });
        expect(manifest().stateEncryption).toBeUndefined();
        expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toBe(`${KEY}=weak\n`);
      });
    });

    it('with nothing stored it still makes one', async () => {
      writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
      process.env[KEY] = '';
      const made = await ensureStatePassphrase(dir);
      expect(made).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(readFileSync(join(dir, '.env.local'), 'utf-8')).toContain(`${KEY}=${made}`);
    });
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
    // It adopted the winner's passphrase: this process made none.
    expect(statePassphraseGeneratedThisRun(dir)).toBe(false);
  });

  describe('statePassphraseGeneratedThisRun', () => {
    it('is true once this process made the passphrase, for that project only', async () => {
      expect(statePassphraseGeneratedThisRun(dir)).toBe(false);
      await ensureStatePassphrase(dir);
      expect(statePassphraseGeneratedThisRun(dir)).toBe(true);
      // The same project named another way is still the same project.
      expect(statePassphraseGeneratedThisRun(join(dir, '.'))).toBe(true);
      const other = mkdtempSync(join(tmpdir(), 'vc-state-pass-'));
      try {
        expect(statePassphraseGeneratedThisRun(other)).toBe(false);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it('is false when the value already existed, with or without its fingerprint', async () => {
      const v = generateStatePassphrase();
      process.env[KEY] = v;
      await ensureStatePassphrase(dir); // case 2: records the fingerprint
      expect(statePassphraseGeneratedThisRun(dir)).toBe(false);
      __resetStatePassphraseForTests();
      await ensureStatePassphrase(dir); // case 1
      expect(statePassphraseGeneratedThisRun(dir)).toBe(false);
    });

    it('is false in the next process, which reads the saved value back', async () => {
      await ensureStatePassphrase(dir);
      __resetStatePassphraseForTests();
      expect(statePassphraseGeneratedThisRun(dir)).toBe(false);
      await ensureStatePassphrase(dir);
      expect(statePassphraseGeneratedThisRun(dir)).toBe(false);
    });
  });

  describe('statePassphraseProvenance: was the passphrase made in this clone?', () => {
    const committing = (manifestJson: unknown) =>
      gitHead.read.mockReturnValue({ state: 'committed', content: JSON.stringify(manifestJson) });

    afterEach(() => {
      gitHead.read.mockReset();
      gitHead.read.mockReturnValue({ state: 'no-git' });
    });

    it('outside a git checkout, or without git, only this process making it counts', async () => {
      const v = generateStatePassphrase();
      process.env[KEY] = v;
      await ensureStatePassphrase(dir); // case 2: an existing value
      expect(statePassphraseProvenance(dir)).toEqual({
        madeHere: false,
        thisRun: false,
        head: 'no-git',
      });
      expect(gitHead.read).toHaveBeenCalledWith(resolve(dir));

      delete process.env[KEY];
      const other = mkdtempSync(join(tmpdir(), 'vc-state-pass-'));
      try {
        await ensureStatePassphrase(other); // case 5: made now
        expect(statePassphraseProvenance(other)).toMatchObject({ madeHere: true, thisRun: true });
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("in a git checkout: committed means the project's, anything else means made here", async () => {
      const v = generateStatePassphrase();
      process.env[KEY] = v;
      await ensureStatePassphrase(dir);
      const fp = statePassphraseFingerprint(v);

      committing({ projectName: 'x', stateEncryption: { fingerprint: fp } });
      expect(statePassphraseProvenance(dir)).toEqual({
        madeHere: false,
        thisRun: false,
        head: 'committed',
      });

      // HEAD lacks the file, lacks the entry, or records another value's.
      gitHead.read.mockReturnValue({ state: 'absent' });
      expect(statePassphraseProvenance(dir)).toMatchObject({ madeHere: true, head: 'uncommitted' });
      committing({ projectName: 'x' });
      expect(statePassphraseProvenance(dir)).toMatchObject({ madeHere: true, head: 'uncommitted' });
      committing({ stateEncryption: { fingerprint: 'sha256:0123456789abcdef' } });
      expect(statePassphraseProvenance(dir)).toMatchObject({ madeHere: true, head: 'uncommitted' });
    });

    it("git can't tell: counts as made here, and says what git said", async () => {
      process.env[KEY] = generateStatePassphrase();
      await ensureStatePassphrase(dir);
      gitHead.read.mockReturnValue({
        state: 'unknown',
        detail: 'fatal: detected dubious ownership',
      });
      expect(statePassphraseProvenance(dir)).toEqual({
        madeHere: true,
        thisRun: false,
        head: 'unknown',
        detail: 'fatal: detected dubious ownership',
      });
      // HEAD's copy that doesn't parse can't tell either.
      gitHead.read.mockReturnValue({ state: 'committed', content: '<<<<<<< HEAD\n{' });
      expect(statePassphraseProvenance(dir)).toMatchObject({ madeHere: true, head: 'unknown' });
    });
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
