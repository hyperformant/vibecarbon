/**
 * What `destroy` can and cannot do with a stack this project's passphrase
 * cannot open, on the real Pulumi engine (file:// backend): Pulumi refuses
 * every read, so `pulumi destroy` cannot run and the checkpoint is left as it
 * was; `pulumi stack rm --force` needs no passphrase at all, which is what
 * lets a compose destroy clear the record after the provider API removed the
 * servers.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails this test instead of skipping it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  destroyStack,
  getStackOutputs,
  removeStackState,
  upStack,
} from '../../../src/lib/iac/index.js';
import { StateUndecryptableError } from '../../../src/lib/iac/state-error.js';
import {
  __resetStatePassphraseForTests,
  statePassphraseFingerprint,
} from '../../../src/lib/state-passphrase.js';

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PROJECT = 'passphrasetest';
const WRITER = 'd3JpdGVyd3JpdGVyd3JpdGVyd3JpdGVyd3JpdGVyd3Jp';
const READER = 'cmVhZGVycmVhZGVycmVhZGVycmVhZGVycmVhZGVycmVh';
const root = mkdtempSync(join(tmpdir(), 'vc-passphrase-destroy-'));
const backend = join(root, 'state');
const checkpoint = join(backend, '.pulumi/stacks', PROJECT, 'e1.json');

/** A project dir of its own, so each passphrase check sees its own manifest. */
function projectDir(name: string, manifest: object) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.vibecarbon.json'), `${JSON.stringify(manifest)}\n`);
  return dir;
}

const withSecret = async () => ({ token: pulumi.secret('integration-sentinel') });

describe.runIf(hasPulumi || process.env.CI)('a stack the passphrase cannot open', () => {
  // Each test, not once: tests/setup/global-setup.ts resets process.env after
  // every test, and without this the CLI falls back to ~/.vibecarbon/pulumi-state.
  beforeEach(() => {
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
    __resetStatePassphraseForTests();
  });
  beforeAll(async () => {
    mkdirSync(backend);
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
    process.env.VIBECARBON_STATE_PASSPHRASE = WRITER;
    await upStack('e1', withSecret, {
      projectName: PROJECT,
      projectDir: projectDir('writer', {}),
    });
    expect(existsSync(checkpoint)).toBe(true);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('every read under another passphrase is the typed error, and the checkpoint is untouched', async () => {
    process.env.VIBECARBON_STATE_PASSPHRASE = READER;
    const opts = { projectName: PROJECT, projectDir: projectDir('reader', {}) };
    const before = readFileSync(checkpoint);

    const outputs = await getStackOutputs('e1', withSecret, opts).catch((e: unknown) => e);
    expect(outputs).toBeInstanceOf(StateUndecryptableError);
    const destroyed = await destroyStack('e1', withSecret, opts).catch((e: unknown) => e);
    expect(destroyed).toBeInstanceOf(StateUndecryptableError);
    expect((destroyed as Error).message).toContain('`vibecarbon destroy e1`');

    expect(readFileSync(checkpoint).equals(before)).toBe(true);
  });

  it('`stack rm --force` removes the record with no passphrase at all', async () => {
    delete process.env.VIBECARBON_STATE_PASSPHRASE;
    // The writer's fingerprint is recorded and no value is set: every
    // decrypting call would refuse this project as "missing".
    const dir = projectDir('lost', {
      stateEncryption: { fingerprint: statePassphraseFingerprint(WRITER) },
    });

    await expect(
      removeStackState('e1', { projectName: PROJECT, projectDir: dir }),
    ).resolves.toEqual({ removed: true });
    expect(existsSync(checkpoint)).toBe(false);
  });
});
