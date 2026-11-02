/**
 * deliverImage stages a full `docker save` under a host-side work dir and
 * removes it in a finally, which a killed run (SIGKILL, OOM, a closed laptop)
 * never reaches. The work dirs live in a private per-user directory
 * (`<tmpdir>/vibecarbon-<uid>`, mode 0700, owned by this user: anything else
 * is refused), and a deploy or scale sweeps the leftovers there at its start.
 * A dir goes when its owner process is dead or it is past a safe age; this
 * run's dirs and a live run's young ones stay. The sweep never leaves the
 * private dir, never follows a symlink, and skips anything not a real
 * directory owned by this user. Real temp dirs throughout.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DELTA_OWNER_FILE,
  deliverImage,
  deltaWorkRoot,
  sweepStaleDeltaDirs,
  // @ts-expect-error — JS module without types
} from '../../../src/lib/deploy/layer-delta.js';

const bases: string[] = [];
afterEach(() => {
  for (const b of bases.splice(0)) {
    chmodSync(b, 0o700);
    rmSync(b, { recursive: true, force: true });
  }
});

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-02T12:00:00Z');
const DEAD = 999_999_901;
const UID = process.getuid?.() ?? 0;

/** A fresh base (stands in for os.tmpdir()) and its private root. */
function makeRoot() {
  const base = mkdtempSync(join(tmpdir(), 'delta-sweep-'));
  bases.push(base);
  return { base, root: deltaWorkRoot({ base }) };
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

describe('deltaWorkRoot: a private per-user directory', () => {
  it('is <base>/vibecarbon-<uid>, a real dir, mode 0700, owned by this user', () => {
    const { base, root } = makeRoot();
    expect(root).toBe(join(base, `vibecarbon-${UID}`));
    const st = lstatSync(root);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect(st.uid).toBe(UID);
  });

  it('refuses an existing dir with group or other permission bits', () => {
    const { base, root } = makeRoot();
    chmodSync(root, 0o755);
    expect(() => deltaWorkRoot({ base })).toThrow(/vibecarbon-\d+.*0700/);
  });

  it('refuses a symlink in its place', () => {
    const base = mkdtempSync(join(tmpdir(), 'delta-sweep-'));
    bases.push(base);
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(base, `vibecarbon-${UID}`));
    expect(() => deltaWorkRoot({ base })).toThrow(/not a real directory/);
  });

  it('refuses one owned by another uid', () => {
    const { base, root } = makeRoot();
    const lstat = (p: string) => {
      const st = lstatSync(p);
      return p === root ? Object.assign(Object.create(st), { uid: UID + 1 }) : st;
    };
    expect(() => deltaWorkRoot({ base, lstat })).toThrow(/owned by uid/);
  });
});

describe('deltaWorkRoot: every refusal says what to do', () => {
  const remedy = (root: string) =>
    `remove ${root}, or set TMPDIR to a private directory, then run the command again`;

  it('wrong mode, a symlink, or a foreign owner each name the remedy, with no em dash', () => {
    const cases: Array<() => void> = [];
    {
      const { base, root } = makeRoot();
      chmodSync(root, 0o755);
      cases.push(() => {
        try {
          deltaWorkRoot({ base });
        } catch (err) {
          expect((err as Error).message).toContain(remedy(root));
          expect((err as Error).message).not.toContain('\u2014');
          return;
        }
        throw new Error('not refused');
      });
    }
    {
      const base = mkdtempSync(join(tmpdir(), 'delta-sweep-'));
      bases.push(base);
      const elsewhere = join(base, 'elsewhere');
      mkdirSync(elsewhere, { mode: 0o700 });
      const root = join(base, `vibecarbon-${UID}`);
      symlinkSync(elsewhere, root);
      cases.push(() => expect(() => deltaWorkRoot({ base })).toThrow(remedy(root)));
    }
    {
      const { base, root } = makeRoot();
      const lstat = (p: string) => {
        const st = lstatSync(p);
        return p === root ? Object.assign(Object.create(st), { uid: UID + 1 }) : st;
      };
      cases.push(() => expect(() => deltaWorkRoot({ base, lstat })).toThrow(remedy(root)));
    }
    for (const c of cases) c();
  });
});

describe('sweepStaleDeltaDirs', () => {
  it('removes a dir whose owner process is dead, however young', () => {
    const { base, root } = makeRoot();
    const dir = stage(root, 'delta-dead', { pid: DEAD, startedAt: NOW - 60_000 });
    expect(sweepStaleDeltaDirs({ base, now: NOW })).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  it("never removes this process's own dir, or a live run's young one", () => {
    const { base, root } = makeRoot();
    const mine = stage(root, 'delta-mine', { pid: process.pid, startedAt: NOW - 30 * HOUR });
    const theirs = stage(root, 'delta-theirs', { pid: process.ppid, startedAt: NOW - HOUR });
    expect(sweepStaleDeltaDirs({ base, now: NOW })).toEqual([]);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(theirs)).toBe(true);
  });

  it('removes a live-pid dir past the safe age (a recycled pid)', () => {
    const { base, root } = makeRoot();
    const dir = stage(root, 'delta-old', { pid: process.ppid, startedAt: NOW - 25 * HOUR });
    expect(sweepStaleDeltaDirs({ base, now: NOW })).toEqual([dir]);
  });

  it('a dir with no owner file is judged by its age only', () => {
    const { base, root } = makeRoot();
    const young = stage(root, 'delta-young', null, NOW - HOUR);
    const old = stage(root, 'delta-unowned', null, NOW - 25 * HOUR);
    expect(sweepStaleDeltaDirs({ base, now: NOW })).toEqual([old]);
    expect(existsSync(young)).toBe(true);
  });

  it('a symlink planted as a candidate is neither followed nor deleted', () => {
    const { base, root } = makeRoot();
    const victim = join(base, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, DELTA_OWNER_FILE), JSON.stringify({ pid: DEAD, startedAt: 0 }));
    const link = join(root, 'delta-planted');
    symlinkSync(victim, link);
    expect(sweepStaleDeltaDirs({ base, now: NOW })).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(victim, DELTA_OWNER_FILE))).toBe(true);
  });

  it('an owner.json that is a symlink is not followed: the dir is judged by its age', () => {
    const { base, root } = makeRoot();
    const lie = join(base, 'lie.json');
    writeFileSync(lie, JSON.stringify({ pid: DEAD, startedAt: 0 }));
    const dir = join(root, 'delta-young');
    mkdirSync(dir);
    symlinkSync(lie, join(dir, DELTA_OWNER_FILE));
    expect(sweepStaleDeltaDirs({ base, now: Date.now() })).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('a candidate owned by another uid is skipped', () => {
    const { base, root } = makeRoot();
    const dir = stage(root, 'delta-foreign', { pid: DEAD, startedAt: 0 });
    const lstat = (p: string) => {
      const st = lstatSync(p);
      return p === dir ? Object.assign(Object.create(st), { uid: UID + 1 }) : st;
    };
    expect(sweepStaleDeltaDirs({ base, now: NOW, lstat })).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('a refused private dir sweeps nothing', () => {
    const { base, root } = makeRoot();
    const dir = stage(root, 'delta-dead', { pid: DEAD, startedAt: 0 });
    chmodSync(root, 0o755);
    expect(sweepStaleDeltaDirs({ base, now: NOW })).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('never looks outside the private dir', () => {
    const { base } = makeRoot();
    const outside = join(base, 'vibecarbon-delta-shared');
    mkdirSync(outside);
    writeFileSync(join(outside, DELTA_OWNER_FILE), JSON.stringify({ pid: DEAD, startedAt: 0 }));
    expect(sweepStaleDeltaDirs({ base, now: NOW })).toEqual([]);
    expect(existsSync(outside)).toBe(true);
  });
});

describe('deliverImage works inside the private dir and marks its owner', () => {
  it('writes the pid before the save starts, under <base>/vibecarbon-<uid>', async () => {
    const { base, root } = makeRoot();
    let owner: { pid: number; startedAt: number } | null = null;
    let work = '';
    await deliverImage({
      tag: 't:1',
      sshTarget: 'root@1.1.1.1',
      runtime: 'docker',
      deps: {
        workBase: base,
        saveImage: async (_tag: string, dir: string) => {
          work = join(dir, '..');
          owner = JSON.parse(readFileSync(join(work, DELTA_OWNER_FILE), 'utf-8'));
          throw new Error('stop here');
        },
        run: async () => '',
        send: async () => ({ code: 0, stderr: '' }),
        acquireLock: async () => () => {},
      },
    }).catch(() => {});
    expect(owner).toMatchObject({ pid: process.pid });
    expect(work.startsWith(`${root}/delta-`)).toBe(true);
  });

  it('a refused private dir fails the delivery with its reason', async () => {
    const { base, root } = makeRoot();
    chmodSync(root, 0o755);
    await expect(
      deliverImage({
        tag: 't:1',
        sshTarget: 'root@1.1.1.1',
        runtime: 'docker',
        deps: { workBase: base, acquireLock: async () => () => {} },
      }),
    ).rejects.toThrow(/image delivery failed: .*0700/);
  });
});

describe('the sweep runs at the start of a deploy and of a scale', () => {
  it('both entry points call it', async () => {
    for (const rel of ['../../../src/lib/deploy/orchestrator.js', '../../../src/scale.js']) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf-8');
      expect(src, rel).toMatch(/sweepStaleDeltaDirs\(/);
    }
  });
});
