/**
 * deliverImage stages the save under a `vibecarbon-delta-*` temp dir and
 * removes it in a finally, which a killed run (SIGKILL, OOM, a closed laptop)
 * never reaches. A deploy or scale sweeps the leftovers at its start: a dir
 * whose owner process is dead, or one past a safe age, never one a live run
 * is using. Real temp dirs throughout.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DELTA_OWNER_FILE,
  deliverImage,
  sweepStaleDeltaDirs,
  // @ts-expect-error — JS module without types
} from '../../../src/lib/deploy/layer-delta.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-02T12:00:00Z');
const DEAD = 999_999_901;

function makeRoot() {
  const r = mkdtempSync(join(tmpdir(), 'delta-sweep-'));
  roots.push(r);
  return r;
}

function stage(
  root: string,
  name: string,
  owner: { pid: number; startedAt: number } | null,
  mtime = NOW,
) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'save'), { recursive: true });
  if (owner) writeFileSync(join(dir, DELTA_OWNER_FILE), JSON.stringify(owner));
  utimesSync(dir, mtime / 1000, mtime / 1000);
  return dir;
}

describe('sweepStaleDeltaDirs', () => {
  it('removes a dir whose owner process is dead, however young', () => {
    const root = makeRoot();
    const dir = stage(root, 'vibecarbon-delta-dead', { pid: DEAD, startedAt: NOW - 60_000 });
    expect(sweepStaleDeltaDirs({ root, now: NOW })).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  it("never removes this process's own dir, or a live run's young one", () => {
    const root = makeRoot();
    const mine = stage(root, 'vibecarbon-delta-mine', {
      pid: process.pid,
      startedAt: NOW - 30 * HOUR,
    });
    const theirs = stage(root, 'vibecarbon-delta-theirs', {
      pid: process.ppid,
      startedAt: NOW - HOUR,
    });
    expect(sweepStaleDeltaDirs({ root, now: NOW })).toEqual([]);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(theirs)).toBe(true);
  });

  it('removes a live-pid dir past the safe age (a recycled pid)', () => {
    const root = makeRoot();
    const dir = stage(root, 'vibecarbon-delta-old', {
      pid: process.ppid,
      startedAt: NOW - 25 * HOUR,
    });
    expect(sweepStaleDeltaDirs({ root, now: NOW })).toEqual([dir]);
  });

  it('a dir with no owner file is judged by its age only', () => {
    const root = makeRoot();
    const young = stage(root, 'vibecarbon-delta-young', null, NOW - HOUR);
    const old = stage(root, 'vibecarbon-delta-unowned', null, NOW - 25 * HOUR);
    expect(sweepStaleDeltaDirs({ root, now: NOW })).toEqual([old]);
    expect(existsSync(young)).toBe(true);
  });

  it('leaves everything else in the temp dir alone', () => {
    const root = makeRoot();
    const other = join(root, 'something-else');
    mkdirSync(other);
    utimesSync(other, 0, 0);
    expect(sweepStaleDeltaDirs({ root, now: NOW })).toEqual([]);
    expect(existsSync(other)).toBe(true);
  });
});

describe('deliverImage marks its work dir with its owner', () => {
  it('writes the pid before the save starts', async () => {
    let owner: { pid: number; startedAt: number } | null = null;
    await deliverImage({
      tag: 't:1',
      sshTarget: 'root@1.1.1.1',
      runtime: 'docker',
      deps: {
        saveImage: async (_tag: string, dir: string) => {
          owner = JSON.parse(readFileSync(join(dir, '..', DELTA_OWNER_FILE), 'utf-8'));
          throw new Error('stop here');
        },
        run: async () => '',
        send: async () => ({ code: 0, stderr: '' }),
        acquireLock: async () => () => {},
      },
    }).catch(() => {});
    expect(owner).toMatchObject({ pid: process.pid });
  });
});

describe('the sweep runs at the start of a deploy and of a scale', () => {
  it('both entry points call it', async () => {
    const { readFileSync } = await import('node:fs');
    for (const rel of ['../../../src/lib/deploy/orchestrator.js', '../../../src/scale.js']) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf-8');
      expect(src, rel).toMatch(/sweepStaleDeltaDirs\(/);
    }
  });
});
