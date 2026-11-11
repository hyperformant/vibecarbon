/**
 * sweepStaleSecretTempDirs (src/lib/temp-dir.js): earlier versions left a
 * deploy bundle (the app's .env and app.env) in the OS temp dir on every
 * deploy, and a killed run can still leave one. Each deploy removes, in the
 * background, what is provably such a leftover: a real directory with one of
 * the CLI's own secret-bearing prefixes, owned by this user, and older than
 * 24 h. Nothing else in the temp dir is touched, and errors cost nothing.
 *
 * Runs against a fake temp dir with real files and real mtimes.
 */
import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const { STALE_AFTER_MS, STALE_SECRET_PREFIXES, sweepStaleSecretTempDirs } = await import(
  '../../../src/lib/temp-dir.js'
);

const uid = process.getuid?.() ?? 0;
const isRoot = uid === 0;
const DAY = 24 * 60 * 60 * 1000;

/** A dir in `parent` holding a .env, last changed `ageMs` ago. */
function leftover(parent: string, name: string, ageMs: number) {
  const path = join(parent, name);
  mkdirSync(path);
  writeFileSync(join(path, '.env'), 'BETTER_AUTH_SECRET=not-a-real-secret\n');
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(path, at, at);
  return path;
}

function sweep(dir: string, opts: { uid?: number } = {}) {
  const lines: string[] = [];
  return sweepStaleSecretTempDirs({ dir, uid, ...opts, report: (l) => lines.push(l) }).then(
    (removed) => ({ removed, lines }),
  );
}

describe('the stale secret temp dir sweep', () => {
  it('removes an old dir of ours, and keeps a fresh one, a foreign prefix, a symlink and a file', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const old = leftover(tmp, 'vc-deploy-bundle-old', DAY + 60_000);
    const fresh = leftover(tmp, 'vc-deploy-bundle-fresh', 60_000);
    // Someone else's prefix, and a CLI prefix that never held a secret.
    const foreign = leftover(tmp, 'other-tool-bundle-old', 10 * DAY);
    const notSecret = leftover(tmp, 'vibecarbon-shell-old', 10 * DAY);
    // A symlink with our prefix, old, pointing at a dir outside: never followed.
    const outside = createTempDir('vc-stale-sweep-target-');
    writeFileSync(join(outside, 'keep'), 'x');
    const link = join(tmp, 'vc-deploy-bundle-link');
    symlinkSync(outside, link);
    // Both old, so only lstat (never following the link) tells it apart.
    const at = (Date.now() - 10 * DAY) / 1000;
    utimesSync(outside, at, at);
    lutimesSync(link, at, at);
    // A plain file with our prefix: only directories go.
    const file = join(tmp, 'vc-deploy-bundle-file');
    writeFileSync(file, 'x');
    utimesSync(file, at, at);

    const { removed, lines } = await sweep(tmp);

    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    for (const kept of [fresh, foreign, notSecret, link, file, join(outside, 'keep')]) {
      expect(existsSync(kept), kept).toBe(true);
    }
    expect(lines).toEqual([
      `removed 1 old vibecarbon temp dir from ${tmp}: earlier versions left them there, with deploy secrets in them`,
    ]);
  });

  it('keeps a dir another user owns', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const old = leftover(tmp, 'vc-deploy-bundle-old', 10 * DAY);
    // The dir is this process's; to a sweep running as another uid it is not its own.
    const { removed, lines } = await sweep(tmp, { uid: uid + 1 });
    expect(removed).toBe(0);
    expect(existsSync(old)).toBe(true);
    expect(lines).toEqual([]);
  });

  it('takes every secret-bearing prefix, and counts them', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const paths = STALE_SECRET_PREFIXES.map((prefix: string) =>
      leftover(tmp, `${prefix}x1`, STALE_AFTER_MS + 60_000),
    );
    const { removed, lines } = await sweep(tmp);
    expect(removed).toBe(STALE_SECRET_PREFIXES.length);
    for (const p of paths) expect(existsSync(p), p).toBe(false);
    expect(lines).toEqual([
      `removed ${paths.length} old vibecarbon temp dirs from ${tmp}: earlier versions left them there, with deploy secrets in them`,
    ]);
  });

  it.skipIf(isRoot)('an entry it cannot remove is skipped, and the rest still go', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const stuck = leftover(tmp, 'vc-deploy-bundle-stuck', 10 * DAY);
    mkdirSync(join(stuck, 'locked'));
    writeFileSync(join(stuck, 'locked', 'f'), 'x');
    chmodSync(join(stuck, 'locked'), 0o500);
    const at = (Date.now() - 10 * DAY) / 1000;
    utimesSync(stuck, at, at);
    const other = leftover(tmp, 'vb-sshscript-old', 10 * DAY);
    try {
      const { removed, lines } = await sweep(tmp);
      expect(removed).toBe(1);
      expect(existsSync(other)).toBe(false);
      expect(lines).toEqual([
        `removed 1 old vibecarbon temp dir from ${tmp}: earlier versions left them there, with deploy secrets in them`,
      ]);
    } finally {
      chmodSync(join(stuck, 'locked'), 0o700);
    }
  });

  it('says nothing when it removed nothing, and never throws', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    leftover(tmp, 'vc-deploy-bundle-fresh', 60_000);
    expect(await sweep(tmp)).toEqual({ removed: 0, lines: [] });
    // An unreadable temp dir (here: one that does not exist) costs nothing.
    expect(await sweep(join(tmp, 'missing'))).toEqual({ removed: 0, lines: [] });
  });

  it('removes nothing where it cannot tell who owns a dir (no process uid)', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const old = leftover(tmp, 'vc-deploy-bundle-old', 10 * DAY);
    const lines: string[] = [];
    // As on Windows, where process.getuid does not exist.
    const removed = await sweepStaleSecretTempDirs({
      dir: tmp,
      uid: null,
      report: (l: string) => lines.push(l),
    });
    expect(removed).toBe(0);
    expect(existsSync(old)).toBe(true);
    expect(lines).toEqual([]);
  });
});
