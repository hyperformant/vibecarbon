/**
 * The stale-lock rules against the real Pulumi engine: real stacks on a file://
 * backend, and lock files planted where Pulumi keeps them. These are the same
 * files a killed run leaves, so a change to how Pulumi names a holder fails
 * here rather than turning every stale lock into a refusal in the field.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails this test instead of skipping it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { destroyStack, removeStackState, upStack } from '../../../src/lib/iac/index.js';
import { LOCK_EXPIRY_MS, StackHeldError } from '../../../src/lib/iac/stack-lock.js';

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PROJECT = 'locktest';
const dir = mkdtempSync(join(tmpdir(), 'vc-stack-lock-'));
const backend = join(dir, 'state');
const opts = { projectName: PROJECT };
const emptyProgram = async () => ({});

const lockDir = (stack: string) => join(backend, '.pulumi/locks/organization', PROJECT, stack);
const locksLeft = (stack: string) =>
  readdirSync(lockDir(stack)).filter((f) => f.endsWith('.json')).length;

/**
 * A real stack in this test's backend, locked by `holder`. The assertion stops a
 * run that lost the backend from passing against the operator's own store.
 */
async function lockedStack(stack: string, holder: { host: string; pid: number; ageMs?: number }) {
  await upStack(stack, emptyProgram, opts);
  expect(existsSync(join(backend, '.pulumi/stacks', PROJECT, `${stack}.json`))).toBe(true);
  mkdirSync(lockDir(stack), { recursive: true });
  writeFileSync(
    join(lockDir(stack), '11111111-2222-3333-4444-555555555555.json'),
    JSON.stringify({
      pid: holder.pid,
      username: 'someone',
      hostname: holder.host,
      timestamp: new Date(Date.now() - (holder.ageMs ?? 0)).toISOString(),
    }),
  );
}

describe.runIf(hasPulumi || process.env.CI)('stale locks on the real engine', () => {
  // Each test, not once: tests/setup/global-setup.ts resets process.env after
  // every test, and without this the CLI falls back to ~/.vibecarbon/pulumi-state.
  beforeEach(() => {
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
  });
  beforeAll(() => {
    mkdirSync(backend);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('destroy refuses a run on another machine and leaves its lock', async () => {
    await lockedStack('foreign', { host: 'another-laptop', pid: 4194000 });
    await expect(destroyStack('foreign', emptyProgram, opts)).rejects.toBeInstanceOf(
      StackHeldError,
    );
    expect(locksLeft('foreign')).toBe(1);
  });

  it('removal refuses a live process on this machine and leaves its lock', async () => {
    await lockedStack('live', { host: hostname(), pid: process.pid });
    await expect(removeStackState('live', opts)).rejects.toThrow(`pid ${process.pid}`);
    expect(locksLeft('live')).toBe(1);
  });

  it('up refuses too, so two deploys of one stack cannot run over each other', async () => {
    await lockedStack('deploys', { host: 'another-laptop', pid: 4194000 });
    await expect(upStack('deploys', emptyProgram, opts)).rejects.toBeInstanceOf(StackHeldError);
    expect(locksLeft('deploys')).toBe(1);
  });

  it('destroy clears the lock of a dead process on this machine and finishes', async () => {
    await lockedStack('dead', { host: hostname(), pid: spawnSync('true').pid as number });
    await expect(destroyStack('dead', emptyProgram, opts)).resolves.toMatchObject({
      destroyed: true,
    });
    expect(locksLeft('dead')).toBe(0);
  });

  it('up clears the lock of a dead process on this machine and finishes', async () => {
    await lockedStack('rerun', { host: hostname(), pid: spawnSync('true').pid as number });
    await expect(upStack('rerun', emptyProgram, opts)).resolves.toBeDefined();
    expect(locksLeft('rerun')).toBe(0);
  });

  it('removal clears a lock from another machine once it has expired', async () => {
    await lockedStack('expired', {
      host: 'another-laptop',
      pid: 1,
      ageMs: LOCK_EXPIRY_MS + 60_000,
    });
    await expect(removeStackState('expired', opts)).resolves.toEqual({ removed: true });
    expect(locksLeft('expired')).toBe(0);
  });
});
