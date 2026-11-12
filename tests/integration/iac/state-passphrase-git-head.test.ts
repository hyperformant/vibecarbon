/**
 * "Was this project's passphrase made in this clone?" across processes, on
 * real git: lib/git-head.js reads `.vibecarbon.json` as HEAD holds it, and
 * statePassphraseProvenance compares that copy's fingerprint with the one the
 * working copy records. destroy keeps a refused stack's record while the
 * fingerprint is only in this clone (a teammate's passphrase may read it).
 *
 * Outside a git checkout, and without git at all, the answer is "no-git" and
 * only the process that made the passphrase counts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitSafeEnv } from '../../../src/lib/command.js';
import { readProjectConfigAtHead } from '../../../src/lib/git-head.js';
import {
  __resetStatePassphraseForTests,
  ensureStatePassphrase,
  statePassphraseFingerprint,
  statePassphraseProvenance,
} from '../../../src/lib/state-passphrase.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

const PASSPHRASE = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
const KEY = 'VIBECARBON_STATE_PASSPHRASE';

let root: string;

/** git in `cwd`, never the repo this test may run from (a pre-push hook sets GIT_DIR). */
function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=vibecarbon-test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, env: gitSafeEnv(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
}

function writeManifest(dir: string, manifest: object) {
  writeFileSync(join(dir, '.vibecarbon.json'), `${JSON.stringify(manifest)}\n`);
}

function repo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  return dir;
}

beforeEach(() => {
  root = createTempDir('vc-git-head-');
  __resetStatePassphraseForTests();
});

afterEach(() => {
  cleanupTempDir(root);
});

describe('readProjectConfigAtHead', () => {
  it('not a git checkout: no-git', () => {
    const dir = join(root, 'plain');
    mkdirSync(dir);
    writeManifest(dir, {});
    expect(readProjectConfigAtHead(dir)).toEqual({ state: 'no-git' });
  });

  it('git not installed: no-git', () => {
    const dir = repo('nogit');
    writeManifest(dir, {});
    // tests/setup/global-setup.ts restores process.env after each test.
    process.env.PATH = join(root, 'empty-bin');
    expect(readProjectConfigAtHead(dir)).toEqual({ state: 'no-git' });
  });

  it('a checkout with no commit, or one that never added the file: absent', () => {
    const dir = repo('fresh');
    writeManifest(dir, {});
    expect(readProjectConfigAtHead(dir)).toEqual({ state: 'absent' });
    writeFileSync(join(dir, 'README.md'), 'x\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-q', '-m', 'readme only');
    expect(readProjectConfigAtHead(dir)).toEqual({ state: 'absent' });
  });

  it("committed: HEAD's copy, not the working copy's", () => {
    const dir = repo('committed');
    writeManifest(dir, { stateEncryption: { fingerprint: 'scrypt:aaaaaaaaaaaaaaaa' } });
    git(dir, 'add', '.vibecarbon.json');
    git(dir, 'commit', '-q', '-m', 'project');
    writeManifest(dir, { stateEncryption: { fingerprint: 'scrypt:bbbbbbbbbbbbbbbb' } });
    const read = readProjectConfigAtHead(dir);
    expect(read.state).toBe('committed');
    expect(JSON.parse((read as { content: string }).content)).toEqual({
      stateEncryption: { fingerprint: 'scrypt:aaaaaaaaaaaaaaaa' },
    });
  });

  it('a project in a subdirectory of a larger repository reads its own file', () => {
    const top = repo('mono');
    const dir = join(top, 'apps', 'site');
    mkdirSync(dir, { recursive: true });
    writeManifest(top, { stateEncryption: { fingerprint: 'scrypt:1111111111111111' } });
    writeManifest(dir, { stateEncryption: { fingerprint: 'scrypt:2222222222222222' } });
    git(top, 'add', '-A');
    git(top, 'commit', '-q', '-m', 'both');
    const read = readProjectConfigAtHead(dir) as { state: string; content: string };
    expect(read.state).toBe('committed');
    expect(JSON.parse(read.content).stateEncryption.fingerprint).toBe('scrypt:2222222222222222');
  });

  it('an inherited GIT_DIR (a git hook) never redirects it to another repository', () => {
    const other = repo('other');
    writeManifest(other, { stateEncryption: { fingerprint: 'scrypt:3333333333333333' } });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'other');
    const dir = repo('mine');
    writeManifest(dir, {});
    process.env.GIT_DIR = join(other, '.git');
    expect(readProjectConfigAtHead(dir)).toEqual({ state: 'absent' });
  });

  it("git fails some other way (HEAD's blob is missing): unknown, with git's line", () => {
    const dir = repo('broken');
    writeManifest(dir, { stateEncryption: { fingerprint: 'scrypt:4444444444444444' } });
    git(dir, 'add', '.vibecarbon.json');
    git(dir, 'commit', '-q', '-m', 'project');
    const blob = git(dir, 'rev-parse', 'HEAD:.vibecarbon.json').trim();
    unlinkSync(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const read = readProjectConfigAtHead(dir) as { state: string; detail: string };
    expect(read.state).toBe('unknown');
    expect(read.detail).toMatch(/^(fatal|error):/);
  });
});

describe('statePassphraseProvenance on real git', () => {
  it('a fingerprint this clone recorded is made here until it is committed', async () => {
    const dir = repo('project');
    writeManifest(dir, { projectName: 'p' });
    git(dir, 'add', '.vibecarbon.json');
    git(dir, 'commit', '-q', '-m', 'before the passphrase');
    // An earlier run (upgrade, deploy) recorded the value's fingerprint.
    process.env[KEY] = PASSPHRASE;
    await ensureStatePassphrase(dir);
    __resetStatePassphraseForTests(); // destroy runs in a later process
    expect(statePassphraseProvenance(dir)).toEqual({
      madeHere: true,
      thisRun: false,
      head: 'uncommitted',
    });

    git(dir, 'commit', '-q', '-am', 'record the passphrase fingerprint');
    expect(statePassphraseProvenance(dir)).toEqual({
      madeHere: false,
      thisRun: false,
      head: 'committed',
    });
  });

  it("a teammate's committed fingerprint is not this clone's", async () => {
    const dir = repo('teammate');
    writeManifest(dir, {
      stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) },
    });
    git(dir, 'add', '.vibecarbon.json');
    git(dir, 'commit', '-q', '-m', 'project');
    process.env[KEY] = PASSPHRASE;
    await ensureStatePassphrase(dir);
    expect(statePassphraseProvenance(dir)).toMatchObject({ madeHere: false, head: 'committed' });
  });

  it('a gitignored .vibecarbon.json is in no commit: made here, and untracked', async () => {
    const dir = repo('ignored');
    writeFileSync(join(dir, '.gitignore'), '.vibecarbon.json\n');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'ignore the project file');
    writeManifest(dir, {
      stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) },
    });
    process.env[KEY] = PASSPHRASE;
    await ensureStatePassphrase(dir);
    expect(readProjectConfigAtHead(dir)).toEqual({ state: 'absent' });
    expect(statePassphraseProvenance(dir)).toEqual({
      madeHere: true,
      thisRun: false,
      head: 'uncommitted',
      untracked: true,
    });
  });

  it('outside a git checkout: only the run that made it', async () => {
    const dir = join(root, 'plain-project');
    mkdirSync(dir);
    writeManifest(dir, {});
    delete process.env[KEY];
    await ensureStatePassphrase(dir);
    expect(statePassphraseProvenance(dir)).toEqual({
      madeHere: true,
      thisRun: true,
      head: 'no-git',
    });
    __resetStatePassphraseForTests();
    expect(statePassphraseProvenance(dir)).toEqual({
      madeHere: false,
      thisRun: false,
      head: 'no-git',
    });
  });
});
