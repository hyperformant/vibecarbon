import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  isCancel: vi.fn(() => false),
}));

import * as p from '@clack/prompts';
import { resolveRestoreTarget } from '../../../src/restore.js';

/**
 * `-source` is a wal-g restore POINT — `latest` or an ISO-8601 timestamp —
 * not a backup file. The old classifier special-cased `latest` and pushed
 * everything else through the legacy tar.gz filename validator, so the PITR
 * path the help text advertises (`-source 2026-06-22T14:30:00Z`) exited 1
 * with "Backup filename must match <safe-name>.(tar|sql)[.gz]", and a local
 * file path was accepted here only to throw deep inside runComposeRestore.
 * (Found while trimming the wal-g-incompatible surface, 2026-09-15.)
 */
describe('resolveRestoreTarget', () => {
  const dirs: string[] = [];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    (p.log.error as unknown as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => {
    exitSpy.mockRestore();
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const lastError = () =>
    String((p.log.error as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? '');

  it('`latest` → the latest base backup', () => {
    expect(resolveRestoreTarget('latest')).toEqual({ kind: 's3', name: 'latest' });
  });

  it('an ISO-8601 timestamp → a point-in-time target (Z and offset forms)', () => {
    expect(resolveRestoreTarget('2026-06-22T14:30:00Z')).toEqual({
      kind: 's3',
      name: '2026-06-22T14:30:00Z',
    });
    expect(resolveRestoreTarget('2026-06-22T14:30:00+02:00')).toEqual({
      kind: 's3',
      name: '2026-06-22T14:30:00+02:00',
    });
  });

  it('a local file path exits 1 up front, naming the two accepted forms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-restore-src-'));
    dirs.push(dir);
    const file = join(dir, 'backup.tar.gz');
    writeFileSync(file, 'x');
    expect(() => resolveRestoreTarget(file)).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(lastError()).toMatch(/wal-g/i);
    expect(lastError()).toMatch(/latest/);
    expect(lastError()).toMatch(/ISO-8601/);
  });

  it('a legacy tar.gz backup NAME exits 1 with the same guidance (not a filename-format error)', () => {
    expect(() => resolveRestoreTarget('myapp_20260507_120000_full.tar.gz')).toThrow('exit');
    expect(lastError()).not.toMatch(/must match/);
    expect(lastError()).toMatch(/latest/);
  });

  it('a malformed timestamp is rejected with the expected format', () => {
    expect(() => resolveRestoreTarget('2026-06-22 14:30')).toThrow('exit');
    expect(lastError()).toMatch(/2026-06-22T14:30:00Z/);
  });
});
