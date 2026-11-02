import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { progressLog } from '../../../src/lib/cli/progress.js';
import {
  acquireUplinkLock,
  // @ts-expect-error — JS module without types
} from '../../../src/lib/deploy/uplink-lock.js';

vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));

/**
 * Cross-process uplink lock — the class-level fix the mitigation registry has
 * carried as OPEN since the per-process mutex landed (91a66a3e): "matrix
 * siblings still share the uplink". A tunnel push failed after 5 attempts one
 * day after that mutex, because the mutex cannot see another process.
 *
 * Same one-writer-per-contended-resource shape that took the state backend
 * from 38 backpressure events to 0; the contended resource here is the
 * operator uplink, whose natural scope is the operator HOST — hence a file
 * lock, not a promise chain.
 *
 * Real filesystem + temp dirs throughout (no node:fs mocking — the
 * unit-test-mocking house rule): atomic mkdir IS the mechanism under test.
 */

const dirs: string[] = [];
const makeDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'uplink-lock-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fastSleep = () => Promise.resolve();

describe('acquireUplinkLock', () => {
  it('a second acquirer waits until the first releases', async () => {
    const lockDir = join(makeDir(), 'uplink-push.lock');
    const events: string[] = [];

    const release1 = await acquireUplinkLock({ lockDir, label: 'a', sleep: fastSleep });
    events.push('a:acquired');

    let bAcquired = false;
    const b = acquireUplinkLock({ lockDir, label: 'b', sleep: fastSleep }).then((rel) => {
      bAcquired = true;
      events.push('b:acquired');
      return rel;
    });

    // Give b every chance to (wrongly) acquire while a holds.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(bAcquired).toBe(false);

    release1();
    const release2 = await b;
    release2();
    expect(events).toEqual(['a:acquired', 'b:acquired']);
  });

  it("a wait on this process's own other transfer neither polls nor logs", async () => {
    // compose-ha sends one delta to each server from one deploy: the second
    // send queues behind the first in-process, and takes the lock the moment
    // the first releases.
    vi.mocked(progressLog).mockClear();
    const sleep = vi.fn(fastSleep);
    const lockDir = join(makeDir(), 'uplink-push.lock');
    const release1 = await acquireUplinkLock({ lockDir, label: 'a', sleep });
    let bAcquired = false;
    const b = acquireUplinkLock({ lockDir, label: 'b', sleep }).then((rel) => {
      bAcquired = true;
      return rel;
    });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(bAcquired).toBe(false);
    release1();
    const release2 = await b;
    expect(JSON.parse(readFileSync(join(lockDir, 'holder.json'), 'utf-8')).label).toBe('b');
    release2();
    expect(sleep).not.toHaveBeenCalled();
    expect(vi.mocked(progressLog)).not.toHaveBeenCalled();
  });

  it('a wait on another process logs once and names its pid', async () => {
    vi.mocked(progressLog).mockClear();
    const lockDir = join(makeDir(), 'uplink-push.lock');
    mkdirSync(lockDir, { recursive: true });
    // A live process that is not us: our parent.
    writeFileSync(
      join(lockDir, 'holder.json'),
      JSON.stringify({ pid: process.ppid, startedAt: Date.now() }),
    );
    let polls = 0;
    const release = await acquireUplinkLock({
      lockDir,
      label: 'x',
      sleep: async () => {
        polls++;
        if (polls === 2) rmSync(lockDir, { recursive: true, force: true });
      },
    });
    release();
    const lines = vi.mocked(progressLog).mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes(`another process (pid ${process.ppid})`))).toHaveLength(
      1,
    );
  });

  it('release removes only its own acquisition, by nonce, not by pid', async () => {
    const lockDir = join(makeDir(), 'uplink-push.lock');
    const release = await acquireUplinkLock({ lockDir, label: 'x', sleep: fastSleep });
    const mine = JSON.parse(readFileSync(join(lockDir, 'holder.json'), 'utf-8'));
    expect(typeof mine.nonce).toBe('string');
    // Reaped as over-age and re-taken by a later acquisition in this same
    // process: same pid, different nonce. The stale release must not free it.
    writeFileSync(
      join(lockDir, 'holder.json'),
      JSON.stringify({ ...mine, nonce: 'a-later-acquisition' }),
    );
    release();
    expect(existsSync(join(lockDir, 'holder.json'))).toBe(true);
  });

  it('reaps a stale holder whose process is dead', async () => {
    // A killed deploy (SIGKILL, OOM) never runs its release. The next deploy
    // must not wait for a corpse: holder liveness is probed via signal 0.
    const lockDir = join(makeDir(), 'uplink-push.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'holder.json'),
      JSON.stringify({ pid: 999999901, startedAt: Date.now() }),
    );

    const release = await acquireUplinkLock({ lockDir, label: 'x', sleep: fastSleep });
    const holder = JSON.parse(readFileSync(join(lockDir, 'holder.json'), 'utf-8'));
    expect(holder.pid).toBe(process.pid);
    release();
  });

  it('reaps a live-pid holder past the staleness budget', async () => {
    // A hung push (our own pid family, or a recycled pid that happens to be
    // alive) must not hold the uplink forever; age is the second reap axis,
    // sized above any legitimate push.
    const lockDir = join(makeDir(), 'uplink-push.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'holder.json'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3_600_000 }),
    );

    const release = await acquireUplinkLock({
      lockDir,
      label: 'x',
      sleep: fastSleep,
      staleMs: 600_000,
    });
    release();
  });

  it('release is idempotent and frees the lock for the next process', async () => {
    const lockDir = join(makeDir(), 'uplink-push.lock');
    const release = await acquireUplinkLock({ lockDir, label: 'x', sleep: fastSleep });
    release();
    release(); // second call must not throw or clobber a new holder
    const release2 = await acquireUplinkLock({ lockDir, label: 'y', sleep: fastSleep });
    release2();
  });

  it('a corrupt holder file counts as stale, never as a permanent block', async () => {
    const lockDir = join(makeDir(), 'uplink-push.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'holder.json'), 'not json{{{');

    const release = await acquireUplinkLock({ lockDir, label: 'x', sleep: fastSleep });
    release();
  });
});
