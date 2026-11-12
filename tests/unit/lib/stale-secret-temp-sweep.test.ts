/**
 * The stale secret sweep (src/lib/temp-dir.js): earlier versions left a
 * deploy bundle (the app's .env and app.env) in the OS temp dir on every
 * deploy, released versions made other secret-bearing temp dirs and files,
 * and a killed run can still leave one. Each deploy removes, in the
 * background, what is provably such a leftover: a real directory with one of
 * the CLI's own secret-bearing prefixes (current or legacy), or a regular
 * file with a legacy secret-bearing name, owned by this user, and older than
 * 24 h. Nothing else in the temp dir is touched, and errors cost nothing. Its
 * one line waits for a quiet point, never for a spinner.
 *
 * Runs against a fake temp dir with real files and real mtimes.
 */
import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const {
  LEGACY_SECRET_TEMP,
  STALE_AFTER_MS,
  STALE_SECRET_PREFIXES,
  staleSweepLine,
  startStaleSecretSweep,
  sweepStaleSecretTempDirs,
} = await import('../../../src/lib/temp-dir.js');

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

/** A regular file in `parent`, last changed `ageMs` ago. */
function leftoverFile(parent: string, name: string, ageMs: number) {
  const path = join(parent, name);
  writeFileSync(path, 'ADMIN_PASSWORD=not-a-real-secret\n');
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(path, at, at);
  return path;
}

/** The sweep, with how many it removed and the line it would print. */
async function sweep(dir: string, opts: { uid?: number } = {}) {
  const counts = await sweepStaleSecretTempDirs({ dir, uid, ...opts });
  const line = staleSweepLine(counts);
  return { removed: counts.dirs + counts.files, lines: line ? [line] : [], counts };
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
      `removed 1 old vibecarbon temp dir from ${tmp}: an earlier run left it, and it can hold deploy secrets`,
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
      `removed ${paths.length} old vibecarbon temp dirs from ${tmp}: earlier runs left them, and they can hold deploy secrets`,
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
        `removed 1 old vibecarbon temp dir from ${tmp}: an earlier run left it, and it can hold deploy secrets`,
      ]);
    } finally {
      chmodSync(join(stuck, 'locked'), 0o700);
    }
  });

  it('says nothing when it removed nothing, and never throws', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    leftover(tmp, 'vc-deploy-bundle-fresh', 60_000);
    expect(await sweep(tmp)).toMatchObject({ removed: 0, lines: [] });
    // An unreadable temp dir (here: one that does not exist) costs nothing.
    expect(await sweep(join(tmp, 'missing'))).toMatchObject({ removed: 0, lines: [] });
  });

  it('removes nothing where it cannot tell who owns a dir (no process uid)', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const old = leftover(tmp, 'vc-deploy-bundle-old', 10 * DAY);
    // As on Windows, where process.getuid does not exist.
    const counts = await sweepStaleSecretTempDirs({ dir: tmp, uid: null });
    expect(counts).toEqual({ dir: tmp, dirs: 0, files: 0 });
    expect(existsSync(old)).toBe(true);
  });
});

// Released versions made these, and src/ no longer does: each entry names the
// versions and the shape (LEGACY_SECRET_TEMP).
describe('the legacy secret-bearing names', () => {
  const OLD = 10 * DAY;
  // The values file's real middle word is the retired stack's name, which the
  // terminology census keeps out of the repo; its pattern takes any word there.
  const shapes = {
    repl: 'vibecarbon-repl-Ab12Cd',
    values: 'vibecarbon-stack-values-48213-1762800000000.yaml',
    tarball: 'vc-deploy-shop-203_0_113_7-48213-0123456789ab.tar.gz',
  };

  it('takes a legacy dir, and each legacy file shape when it is a regular file', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const dir = leftover(tmp, shapes.repl, OLD);
    const values = leftoverFile(tmp, shapes.values, OLD);
    const tarball = leftoverFile(tmp, shapes.tarball, OLD);
    const { counts, lines } = await sweep(tmp);
    expect(counts).toEqual({ dir: tmp, dirs: 1, files: 2 });
    for (const p of [dir, values, tarball]) expect(existsSync(p), p).toBe(false);
    expect(lines).toEqual([
      `removed 1 old vibecarbon temp dir and 2 files from ${tmp}: earlier runs left them, and they can hold deploy secrets`,
    ]);
  });

  it('keeps a fresh one, a dir with a file name, a file with a dir name, a symlink, and near misses', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const fresh = leftoverFile(tmp, shapes.values, 60_000);
    // A file name pattern on a directory, and a dir prefix on a file.
    const dirNamedLikeFile = leftover(tmp, shapes.tarball, OLD);
    const fileNamedLikeDir = leftoverFile(tmp, `${shapes.repl}-file`, OLD);
    // An old symlink with a legacy file name, pointing at a file outside.
    const outside = createTempDir('vc-stale-sweep-target-');
    const target = leftoverFile(outside, 'keep', OLD);
    const link = join(tmp, 'vibecarbon-stack-values-1-2.yaml');
    symlinkSync(target, link);
    const at = (Date.now() - OLD) / 1000;
    lutimesSync(link, at, at);
    // Close to a legacy name, but not it.
    const misses = [
      'vibecarbon-stack-values-48213.yaml',
      'vibecarbon-stack-values-48213-1762800000000.yaml.bak',
      'vc-deploy-shop-203_0_113_7-48213-0123abc.tar.gz',
      'vc-deploy-shop-203_0_113_7-48213-0123456789ab.tar',
    ].map((name) => leftoverFile(tmp, name, OLD));

    const { removed, lines } = await sweep(tmp);

    expect(removed).toBe(0);
    for (const kept of [fresh, dirNamedLikeFile, fileNamedLikeDir, link, target, ...misses]) {
      expect(existsSync(kept), kept).toBe(true);
    }
    expect(lines).toEqual([]);
  });

  it('keeps a legacy file another user owns', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const values = leftoverFile(tmp, shapes.values, OLD);
    const { removed } = await sweep(tmp, { uid: uid + 1 });
    expect(removed).toBe(0);
    expect(existsSync(values)).toBe(true);
  });

  it('every legacy entry is covered by a case here', () => {
    // A new entry gets its own shape above, or this fails.
    const covered = LEGACY_SECRET_TEMP.filter(
      (entry: { shape: string; prefix?: string; name?: RegExp }) =>
        Object.values(shapes).some((name) =>
          entry.shape === 'dir'
            ? name.startsWith(entry.prefix as string)
            : (entry.name as RegExp).test(name),
        ),
    );
    expect(covered).toHaveLength(LEGACY_SECRET_TEMP.length);
  });
});

describe('the sweep line', () => {
  const dir = '/tmp';
  it.each([
    [
      { dirs: 1, files: 0 },
      'removed 1 old vibecarbon temp dir from /tmp: an earlier run left it, and it can hold deploy secrets',
    ],
    [
      { dirs: 3, files: 0 },
      'removed 3 old vibecarbon temp dirs from /tmp: earlier runs left them, and they can hold deploy secrets',
    ],
    [
      { dirs: 0, files: 1 },
      'removed 1 old vibecarbon temp file from /tmp: an earlier run left it, and it can hold deploy secrets',
    ],
    [
      { dirs: 2, files: 1 },
      'removed 2 old vibecarbon temp dirs and 1 file from /tmp: earlier runs left them, and they can hold deploy secrets',
    ],
  ])('%o', (counts, line) => {
    expect(staleSweepLine({ dir, ...counts })).toBe(line);
  });

  it('is null when nothing was removed', () => {
    expect(staleSweepLine({ dir, dirs: 0, files: 0 })).toBeNull();
  });
});

// A line written while a spinner animates breaks the spinner's line
// (src/lib/progress.js), and the sweep settles about a second into a deploy,
// mid-spinner. So it prints nothing itself: the deploy flushes it before its
// outro, and a process that exits first prints it on its own line.
describe('the background sweep holds its line for a quiet point', () => {
  function fakeProc() {
    const listeners = new Map<string, () => void>();
    return {
      listeners,
      once: vi.fn((event: string, fn: () => void) => listeners.set(event, fn)),
      off: vi.fn((event: string, fn: () => void) => {
        if (listeners.get(event) === fn) listeners.delete(event);
      }),
    };
  }
  const withOldDir = () => {
    const tmp = createTempDir('vc-stale-sweep-');
    leftover(tmp, 'vc-deploy-bundle-old', 10 * DAY);
    return tmp;
  };

  it('writes nothing until flushed, then prints the line once', async () => {
    const tmp = withOldDir();
    const proc = fakeProc();
    const write = vi.fn();
    const sweeper = startStaleSecretSweep({ dir: tmp, uid, proc, write });
    const printed: string[] = [];
    await sweeper.flush((line: string) => printed.push(line));
    expect(printed).toEqual([
      `removed 1 old vibecarbon temp dir from ${tmp}: an earlier run left it, and it can hold deploy secrets`,
    ]);
    // Flushed: the exit hook is gone, and a second flush prints nothing.
    expect(proc.listeners.has('exit')).toBe(false);
    await sweeper.flush((line: string) => printed.push(line));
    expect(printed).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('a process that exits before the flush prints the line on its own line, once', async () => {
    const tmp = withOldDir();
    const proc = fakeProc();
    const write = vi.fn();
    const sweeper = startStaleSecretSweep({ dir: tmp, uid, proc, write });
    // Let the sweep settle (a deploy that fails later than a second in).
    await vi.waitFor(() => expect(proc.listeners.has('exit')).toBe(true));
    (proc.listeners.get('exit') as () => void)();
    expect(write).toHaveBeenCalledExactlyOnceWith(
      `\nremoved 1 old vibecarbon temp dir from ${tmp}: an earlier run left it, and it can hold deploy secrets\n`,
    );
    const printed: string[] = [];
    await sweeper.flush((line: string) => printed.push(line));
    expect(printed).toEqual([]);
  });

  it('hooks nothing when it removed nothing', async () => {
    const tmp = createTempDir('vc-stale-sweep-');
    const proc = fakeProc();
    const sweeper = startStaleSecretSweep({ dir: tmp, uid, proc, write: vi.fn() });
    const printed: string[] = [];
    await sweeper.flush((line: string) => printed.push(line));
    expect(printed).toEqual([]);
    expect(proc.once).not.toHaveBeenCalled();
  });

  it('the deploy starts it without a printer and flushes it before its outro', () => {
    const text = readFileSync(join('src', 'lib', 'deploy', 'orchestrator.js'), 'utf-8');
    const start = text.indexOf('export async function executeDeployment(');
    const body = text.slice(start, text.indexOf('\n}\n', start));
    const started = body.indexOf('startStaleSecretSweep()');
    const flushed = body.indexOf('await staleSecretSweep.flush(');
    const outro = body.indexOf('p.log.success(`Deployment to');
    expect(started).toBeGreaterThan(-1);
    expect(flushed).toBeGreaterThan(started);
    expect(outro).toBeGreaterThan(flushed);
    // Nothing else prints from inside the sweep.
    expect(text).not.toMatch(/sweepStaleSecretTempDirs\(/);
  });
});
