/**
 * Clearing a Pulumi lock only on evidence that its holder is gone.
 *
 * `pulumi cancel` deletes a lock without looking at who holds it, and that lock
 * is the only guard between two `vibecarbon` processes on one stack. Cleared
 * unconditionally, it let a destroy report a clean teardown while the deploy it
 * raced kept creating servers nothing tracks (security review of #366, proven
 * on the real engine). tests/integration/iac/stack-lock.test.ts runs the same
 * rules against real locks, so a change to Pulumi's wording fails there.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withStateBackendRetry } from '../../../src/lib/iac/index.js';
import {
  holderIsGone,
  LOCK_EXPIRY_MS,
  lockHolders,
  runPastStaleLock,
  StackHeldError,
} from '../../../src/lib/iac/stack-lock.js';

/** A pid that has exited. */
const deadPid = () => spawnSync('true').pid;

const lockedError = (holder: string, at = new Date().toISOString()) =>
  new Error(
    'code: 255\n stdout: \n stderr: error: the stack is currently locked by 1 lock(s). Either wait ' +
      'for the other process(es) to end or delete the lock file with `pulumi cancel`.\n' +
      `  s3://b/.pulumi/locks/organization/p/s/u.json?endpoint=https://x&region=y: created by ${holder} at ${at}\n`,
  );

describe('lockHolders', () => {
  it("reads the holder out of Pulumi's error", () => {
    const err = lockedError('someone@another-laptop (pid 4194000)', '2026-11-07T18:00:00Z');
    expect(lockHolders(err.message)).toEqual([
      { user: 'someone', host: 'another-laptop', pid: 4194000, at: '2026-11-07T18:00:00Z' },
    ]);
  });

  // Seen on the real engine: the automation API repeats the command's output.
  it('lists a holder once when the error repeats it', () => {
    const { message } = lockedError('someone@another-laptop (pid 1)', '2026-11-07T18:00:00Z');
    expect(lockHolders(message + message)).toHaveLength(1);
  });

  it('reads a user name with a space or an @ in it', () => {
    const [holder] = lockHolders(lockedError('A B@corp@laptop (pid 7)').message) ?? [];
    expect(holder).toMatchObject({ user: 'A B@corp', host: 'laptop', pid: 7 });
  });

  it('answers null for anything that is not a lock error', () => {
    expect(lockHolders('error: update failed')).toBeNull();
    expect(lockHolders('')).toBeNull();
  });

  // Fail closed: a lock we cannot read is not a lock we may clear.
  it('answers null when Pulumi names fewer holders than locks', () => {
    expect(lockHolders('the stack is currently locked by 2 lock(s).')).toBeNull();
    const oneOfTwo = lockedError('a@b (pid 1)').message.replace('by 1 lock(s)', 'by 2 lock(s)');
    expect(lockHolders(oneOfTwo)).toBeNull();
  });
});

describe('holderIsGone', () => {
  const now = Date.parse('2026-11-07T18:00:00Z');
  const at = '2026-11-07T17:59:00Z';
  const here = hostname();

  it('is true for a dead process on this machine', () => {
    expect(holderIsGone({ user: 'u', host: here, pid: deadPid(), at }, now)).toBe(true);
  });

  it('is false for a live process on this machine', () => {
    expect(holderIsGone({ user: 'u', host: here, pid: process.pid, at }, now)).toBe(false);
  });

  it('is false for another machine, whose processes we cannot see', () => {
    expect(holderIsGone({ user: 'u', host: 'another-laptop', pid: deadPid(), at }, now)).toBe(
      false,
    );
  });

  it('is true for any lock past the expiry, which frees a lock from a dead machine', () => {
    const old = new Date(now - LOCK_EXPIRY_MS - 1).toISOString();
    expect(holderIsGone({ user: 'u', host: 'another-laptop', pid: 1, at: old }, now)).toBe(true);
    expect(holderIsGone({ user: 'u', host: here, pid: process.pid, at: old }, now)).toBe(true);
  });

  // Pulumi prints the holder's local time, as a real lock showed.
  it('reads a time with a UTC offset', () => {
    const local = '2026-11-07T11:59:00-06:00';
    expect(holderIsGone({ user: 'u', host: 'another-laptop', pid: 1, at: local }, now)).toBe(false);
    const later = now + LOCK_EXPIRY_MS + 120_000;
    expect(holderIsGone({ user: 'u', host: 'another-laptop', pid: 1, at: local }, later)).toBe(
      true,
    );
  });

  it('keeps a lock with an unreadable time until the process check says otherwise', () => {
    expect(holderIsGone({ user: 'u', host: 'another-laptop', pid: 1, at: 'soon' }, now)).toBe(
      false,
    );
  });
});

describe('runPastStaleLock', () => {
  const stackWith = () => ({ name: 'prod', cancel: vi.fn(async () => undefined) });

  // Every `up` used to spawn `pulumi cancel` first, lock or no lock.
  it('leaves an unlocked stack alone', async () => {
    const stack = stackWith();
    await expect(runPastStaleLock(stack, async () => 'done')).resolves.toBe('done');
    expect(stack.cancel).not.toHaveBeenCalled();
  });

  it('clears the lock of a dead run and goes again', async () => {
    const stack = stackWith();
    const op = vi
      .fn()
      .mockRejectedValueOnce(lockedError(`u@${hostname()} (pid ${deadPid()})`))
      .mockResolvedValueOnce('done');
    await expect(runPastStaleLock(stack, op)).resolves.toBe('done');
    expect(stack.cancel).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('refuses, naming the holder, when that run may be alive, and keeps its lock', async () => {
    const stack = stackWith();
    const op = vi.fn().mockRejectedValue(lockedError('someone@another-laptop (pid 123)'));
    const refusal = await runPastStaleLock(stack, op).catch((e) => e);
    expect(refusal).toBeInstanceOf(StackHeldError);
    expect(refusal.message).toContain('prod');
    expect(refusal.message).toContain('someone@another-laptop (pid 123)');
    expect(stack.cancel).not.toHaveBeenCalled();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('refuses when only one of two holders is gone, because cancel removes both', async () => {
    const stack = stackWith();
    const now = new Date().toISOString();
    const message = lockedError(`u@${hostname()} (pid ${deadPid()})`, now)
      .message.replace('by 1 lock(s)', 'by 2 lock(s)')
      .concat(`  s3://b/two.json: created by someone@another-laptop (pid 5) at ${now}\n`);
    await expect(
      runPastStaleLock(stack, async () => {
        throw new Error(message);
      }),
    ).rejects.toBeInstanceOf(StackHeldError);
    expect(stack.cancel).not.toHaveBeenCalled();
  });

  it('passes any other failure through untouched', async () => {
    const stack = stackWith();
    const boom = new Error('error: update failed');
    await expect(runPastStaleLock(stack, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(stack.cancel).not.toHaveBeenCalled();
  });

  // A locked stack is classified as retry-in-place. The refusal must not be, or
  // it would wait out the backoff to give the same answer.
  it('stops the state-backend retry at the first refusal', async () => {
    const stack = stackWith();
    const op = vi.fn().mockRejectedValue(lockedError('someone@another-laptop (pid 123)'));
    const sleep = vi.fn(async () => undefined);
    await expect(
      withStateBackendRetry(() => runPastStaleLock(stack, op), 'up', { sleep }),
    ).rejects.toBeInstanceOf(StackHeldError);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('census', () => {
  it('leaves stack-lock.js the only code that can clear a lock', () => {
    const dir = join(process.cwd(), 'src/lib/iac');
    const callers = readdirSync(dir, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /\.cancel\(/.test(readFileSync(join(dir, f), 'utf-8')));
    expect(callers).toEqual(['stack-lock.js']);
  });
});
