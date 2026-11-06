import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { resetStateLocksForTest, withStateLock } from '../../../src/lib/iac/state-lock.js';

/**
 * The lock keeps one state read-modify-write from interleaving with another on
 * the same bucket (`syncServerState`). These are the properties a waiter
 * depends on: order, a key per bucket, and a failed holder never strands the
 * queue behind it.
 */

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

afterEach(() => resetStateLocksForTest());

describe('withStateLock', () => {
  it('serializes two operations on the same key', async () => {
    const first = defer();
    const events: string[] = [];

    const a = withStateLock('s3://bucket', 'primary', async () => {
      events.push('a:start');
      await first.promise;
      events.push('a:end');
    });
    const b = withStateLock('s3://bucket', 'standby', async () => {
      events.push('b:start');
    });

    // b must not have begun while a holds the lock — this is the whole point.
    await Promise.resolve();
    expect(events).toEqual(['a:start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('lets different keys run concurrently', async () => {
    // Distinct buckets must not block each other, or an unrelated environment's
    // deploy would queue behind this one.
    const blocked = defer();
    const events: string[] = [];

    const a = withStateLock('s3://bucket-one', 'one', async () => {
      events.push('one:start');
      await blocked.promise;
    });
    const b = withStateLock('s3://bucket-two', 'two', async () => {
      events.push('two:start');
    });

    await b;
    expect(events).toContain('two:start');
    blocked.resolve();
    await a;
  });

  it('releases the lock when the operation throws', async () => {
    // A failed up must not strand the standby behind a lock that is never
    // released — the deploy would hang rather than fail.
    await expect(
      withStateLock('s3://bucket', 'failing', async () => {
        throw new Error('up failed');
      }),
    ).rejects.toThrow('up failed');

    await expect(withStateLock('s3://bucket', 'after', async () => 'ok')).resolves.toBe('ok');
  });

  it('keeps the queue moving when an earlier waiter rejects', async () => {
    // Each holder's slot is settled by its release callback, not by the
    // operation's outcome, so one failure cannot poison the chain behind it.
    const gate = defer();
    const results: string[] = [];

    const a = withStateLock('s3://bucket', 'a', async () => {
      await gate.promise;
      throw new Error('boom');
    });
    const b = withStateLock('s3://bucket', 'b', async () => {
      results.push('b ran');
    });

    gate.resolve();
    await expect(a).rejects.toThrow('boom');
    await b;
    expect(results).toEqual(['b ran']);
  });
});
