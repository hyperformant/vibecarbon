/**
 * The process's own temp dirs (src/lib/temp-dir.js). Every temp dir src/ makes
 * comes from here (tests/unit/lib/temp-dir-census.test.ts): its owner removes
 * it when the work is done, and the exit sweep removes any still live when the
 * process exits, which is the only cleanup a Ctrl-C reaches (cli.js exits at
 * once, so no finally runs). The exit itself is proven on real processes in
 * tests/integration/modules/temp-dir-exit-sweep.test.ts.
 */
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  makeTempDir,
  removeTempDir,
  sweepTempDirs,
  withTempDir,
  withTempDirSync,
} from '../../../src/lib/temp-dir.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** A dir whose removal fails for a non-root user: a file under a 0500 subdir. */
function unremovable(dir: string) {
  const locked = join(dir, 'locked');
  mkdirSync(locked);
  writeFileSync(join(locked, 'f'), '');
  chmodSync(locked, 0o500);
  return () => chmodSync(locked, 0o700);
}

afterEach(() => {
  // Whatever a case left live goes now, so the per-file census sees nothing.
  sweepTempDirs({ report: () => {} });
});

describe('makeTempDir / removeTempDir', () => {
  it('makes a private dir in the OS temp dir with the prefix, and removes it', () => {
    const dir = makeTempDir('vc-unit-');
    expect(dirname(dir)).toBe(tmpdir());
    expect(basename(dir)).toMatch(/^vc-unit-\w{6}$/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    writeFileSync(join(dir, '.env'), 'SECRET=x\n');
    removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
    // Removing it again is a no-op.
    removeTempDir(dir);
  });

  it('makes it under a given parent', () => {
    const parent = makeTempDir('vc-parent-');
    const dir = makeTempDir('vc-child-', { parent });
    expect(dirname(dir)).toBe(parent);
    removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
    removeTempDir(parent);
  });

  it.skipIf(isRoot)(
    'a removal that fails never throws (it runs in finally blocks, where a throw would replace the real error) and leaves the dir for the exit sweep',
    () => {
      const dir = makeTempDir('vc-stuck-');
      const unlock = unremovable(dir);
      expect(() => removeTempDir(dir)).not.toThrow();
      expect(existsSync(dir)).toBe(true);
      unlock();
      const lines: string[] = [];
      sweepTempDirs({ report: (line) => lines.push(line) });
      expect(existsSync(dir)).toBe(false);
      expect(lines).toEqual([]);
    },
  );
});

describe('withTempDir / withTempDirSync', () => {
  it('removes the dir once the work resolves, and returns its value', async () => {
    let seen = '';
    const value = await withTempDir('vc-with-', async (dir) => {
      seen = dir;
      expect(existsSync(dir)).toBe(true);
      return 42;
    });
    expect(value).toBe(42);
    expect(existsSync(seen)).toBe(false);
  });

  it('removes the dir when the work rejects, and passes the rejection on', async () => {
    let seen = '';
    await expect(
      withTempDir('vc-with-', async (dir) => {
        seen = dir;
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    expect(existsSync(seen)).toBe(false);
  });

  it('sync: removes the dir after the work returns or throws', () => {
    let seen = '';
    expect(
      withTempDirSync('vc-with-', (dir) => {
        seen = dir;
        return 'ok';
      }),
    ).toBe('ok');
    expect(existsSync(seen)).toBe(false);
    expect(() =>
      withTempDirSync('vc-with-', (dir) => {
        seen = dir;
        throw new Error('sync work failed');
      }),
    ).toThrow('sync work failed');
    expect(existsSync(seen)).toBe(false);
  });
});

describe('the exit sweep', () => {
  it('removes every live dir and only those', () => {
    const a = makeTempDir('vc-live-');
    const b = makeTempDir('vc-live-');
    const done = makeTempDir('vc-done-');
    removeTempDir(done);
    const other = join(tmpdir(), 'vc-not-ours');
    mkdirSync(other);
    try {
      sweepTempDirs({ report: () => {} });
      expect(existsSync(a)).toBe(false);
      expect(existsSync(b)).toBe(false);
      expect(existsSync(other)).toBe(true);
    } finally {
      removeTempDir(other);
    }
  });

  it('is on the process exit only while a dir is live', () => {
    const before = process.listeners('exit').length;
    const dir = makeTempDir('vc-live-');
    expect(process.listeners('exit').length).toBe(before + 1);
    makeTempDir('vc-live-');
    expect(process.listeners('exit').length).toBe(before + 1);
    removeTempDir(dir);
    expect(process.listeners('exit').length).toBe(before + 1);
    sweepTempDirs({ report: () => {} });
    expect(process.listeners('exit').length).toBe(before);
  });

  it.skipIf(isRoot)('names a dir it cannot remove, so a secret left behind is never silent', () => {
    const dir = makeTempDir('vc-stuck-');
    const unlock = unremovable(dir);
    const lines: string[] = [];
    try {
      sweepTempDirs({ report: (line) => lines.push(line) });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(dir);
      expect(lines[0]).toMatch(/could not remove its temp dir/);
      expect(lines[0]).toMatch(/delete it/);
    } finally {
      unlock();
      removeTempDir(dir);
    }
    expect(existsSync(dir)).toBe(false);
  });
});
