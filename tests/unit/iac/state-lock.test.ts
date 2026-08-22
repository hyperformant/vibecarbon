import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { resetStateLocksForTest, withStateLock } from '../../../src/lib/iac/state-lock.js';

/**
 * The lock exists to stop two Pulumi engines hitting one state bucket at once
 * — the shape that produced 16 of the 38 throttle events in run 31898658781
 * (the k8s-ha primary/standby pair, both stack-selecting the same bucket).
 *
 * The property that has to hold above all others is re-entrancy: the public
 * iac operations nest (upStack -> getOrCreateStack -> listStacks), so a lock
 * that is not re-entrant deadlocks on the first deploy rather than failing a
 * test. That case is first below and is the reason for the AsyncLocalStorage.
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
  it('does not deadlock when a holder acquires the same key again', async () => {
    // upStack -> getOrCreateStack -> listStacks, all on one backend URL.
    const order: string[] = [];
    const result = await withStateLock('s3://bucket', 'up', async () => {
      order.push('outer');
      return withStateLock('s3://bucket', 'stack-select', async () => {
        order.push('middle');
        return withStateLock('s3://bucket', 'list', async () => {
          order.push('inner');
          return 'done';
        });
      });
    });
    expect(result).toBe('done');
    expect(order).toEqual(['outer', 'middle', 'inner']);
  });

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

  it('scopes the holder to its own async context, not globally', async () => {
    // The re-entrancy escape must not leak: an unrelated concurrent operation
    // has to queue even while another context holds the key. Otherwise the
    // re-entrancy fix would silently disable the serialization it sits inside.
    const holding = defer();
    const released = defer();
    const events: string[] = [];

    const holder = withStateLock('s3://bucket', 'holder', async () => {
      events.push('holder:in');
      holding.resolve();
      await released.promise;
    });

    await holding.promise;
    const other = withStateLock('s3://bucket', 'other', async () => {
      events.push('other:in');
    });

    await Promise.resolve();
    expect(events).toEqual(['holder:in']);

    released.resolve();
    await Promise.all([holder, other]);
    expect(events).toEqual(['holder:in', 'other:in']);
  });
});
