import { describe, expect, it, vi } from 'vitest';
import { verifyPostgres } from '../../../src/restore.js';

const noSleep = () => Promise.resolve();
const getPod = () => 'supabase-supabase-db-0';

describe('verifyPostgres', () => {
  it('returns once pg_isready succeeds (no wait when already up)', async () => {
    const exec = vi.fn(); // resolves = exit 0
    await verifyPostgres('1.2.3.4', '/key', { exec, getPod, sleep: noSleep });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('polls through "not accepting connections" until postgres finishes WAL replay', async () => {
    const exec = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('pg_isready: rejecting');
      })
      .mockImplementationOnce(() => {
        throw new Error('pg_isready: rejecting');
      })
      .mockImplementation(() => {}); // now accepting
    await verifyPostgres('1.2.3.4', '/key', { exec, getPod, sleep: noSleep });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('uses a 2s default poll interval (tighter tail after WAL replay promotes)', async () => {
    // The default interval is the granularity of the tail latency between
    // "postgres finished WAL replay" and "we observe it". 5s was needlessly
    // coarse; 2s halves the worst-case wait without changing the early-exit
    // semantics (still returns on the first successful pg_isready). The 300s
    // timeoutMs ceiling is a separate, load-bearing budget and stays.
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const exec = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('pg_isready: rejecting');
      })
      .mockImplementation(() => {}); // now accepting
    await verifyPostgres('1.2.3.4', '/key', { exec, getPod, sleep });
    expect(sleeps[0]).toBe(2000);
  });

  it('throws after the deadline if postgres never accepts connections', async () => {
    const exec = vi.fn(() => {
      throw new Error('pg_isready: no response');
    });
    await expect(
      verifyPostgres('1.2.3.4', '/key', {
        exec,
        getPod,
        sleep: noSleep,
        timeoutMs: 20,
        intervalMs: 5,
      }),
    ).rejects.toThrow(/did not accept connections/);
  });
});
