/**
 * `destroy` leaves no `.json.bak` in the state backend, on the real Pulumi
 * engine (file:// backend). Pulumi's DIY backend keeps the previous copy of a
 * stack's state beside it and `stack rm` leaves it behind, so every destroyed
 * environment used to leave one file in the state bucket.
 *
 * A stack with no cloud resources: the program exports one secret and creates
 * nothing, so no provider and no network is involved.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails this test instead of skipping it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStateProbesForTests,
  destroyStack,
  removeStackState,
  upStack,
} from '../../../src/lib/iac/index.js';
import { __resetStatePassphraseForTests } from '../../../src/lib/state-passphrase.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PROJECT = 'backuptest';
const PASSPHRASE = 'YmFja3VwYmFja3VwYmFja3VwYmFja3VwYmFja3VwYmFj';
const root = createTempDir('vc-destroy-backup-');
const backend = join(root, 'state');
const stacks = join(backend, '.pulumi/stacks', PROJECT);

const program = async () => ({ token: pulumi.secret('integration-sentinel') });

function projectDir(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
  return dir;
}

/** Every file under the backend that belongs to `stack`, relative to it. */
function filesOf(stack: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  return walk(backend)
    .map((f) => f.slice(backend.length + 1))
    .filter((f) => f.split('/').includes(stack) || f.includes(`/${stack}.`))
    .sort();
}

describe.runIf(hasPulumi || process.env.CI)('destroying a stack', () => {
  // Each test, not once: tests/setup/global-setup.ts resets process.env after
  // every test.
  beforeEach(() => {
    mkdirSync(backend, { recursive: true });
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
    process.env.VIBECARBON_STATE_PASSPHRASE = PASSPHRASE;
    __resetStatePassphraseForTests();
    __resetStateProbesForTests();
  });
  afterAll(() => {
    cleanupTempDir(root);
  });

  async function deployTwice(stack: string, dir: string) {
    const opts = { projectName: PROJECT, projectDir: dir };
    await upStack(stack, program, opts);
    // A second update is what makes Pulumi keep a previous copy.
    await upStack(stack, program, opts);
    expect(existsSync(join(stacks, `${stack}.json`))).toBe(true);
    return opts;
  }

  it('destroy leaves no .json.bak in the state backend', async () => {
    const opts = await deployTwice('e1', projectDir('d1'));
    await destroyStack('e1', program, opts);
    expect(existsSync(join(stacks, 'e1.json'))).toBe(false);
    expect(existsSync(join(stacks, 'e1.json.bak'))).toBe(false);
    // Nothing else of this stack's is left either: no history, backup or lock
    // file (a file:// backend keeps empty directories, which s3:// has none of).
    expect(filesOf('e1')).toEqual([]);
  });

  it('a forced removal keeps the .json.bak unless its caller verified the resources gone', async () => {
    const opts = await deployTwice('e2', projectDir('d2'));
    await removeStackState('e2', opts);
    expect(existsSync(join(stacks, 'e2.json'))).toBe(false);
    expect(existsSync(join(stacks, 'e2.json.bak'))).toBe(true);

    const opts3 = await deployTwice('e3', projectDir('d3'));
    await removeStackState('e3', { ...opts3, removeBackup: true });
    expect(existsSync(join(stacks, 'e3.json'))).toBe(false);
    expect(existsSync(join(stacks, 'e3.json.bak'))).toBe(false);
  });
});
