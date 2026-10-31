/**
 * `-source <base backup name>` restores that exact base, replaying all WAL.
 *
 * The e2e lifecycle restores the base `vibecarbon backup` reported pushed
 * (`base backup pushed: base_…`). With `-source latest` the restore picked
 * whatever was newest, which after a destroy -y (now backing up by default)
 * is destroy's own pre-backup, so verify-restore proved nothing about the
 * backup step's base.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  isCancel: vi.fn(() => false),
}));

import { NoRestorePointError } from '../../../src/lib/walg/restore-base.js';
import { pickRestoreBase, resolveRestoreTarget } from '../../../src/restore.js';

const A = 'base_000000010000000000000004';
const B = 'base_000000010000000000000009';
const backups = [
  { name: A, finishTime: new Date('2026-10-21T01:00:00Z') },
  { name: B, finishTime: new Date('2026-10-21T02:00:00Z') },
];

describe('restore -source <base name>', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
  });
  afterEach(() => exitSpy.mockRestore());

  it('a wal-g base name (full or delta) is a restore point: that base, all WAL', () => {
    expect(resolveRestoreTarget(A)).toEqual({ kind: 's3', name: 'latest', base: A });
    const delta = `${B}_D_000000010000000000000004`;
    expect(resolveRestoreTarget(delta)).toEqual({ kind: 's3', name: 'latest', base: delta });
    expect(() => resolveRestoreTarget('base_123')).toThrow('exit');
  });

  it('picks the named base even when a newer one exists', () => {
    expect(pickRestoreBase(backups, { kind: 's3', name: 'latest', base: A }).name).toBe(A);
    expect(pickRestoreBase(backups, { kind: 's3', name: 'latest' }).name).toBe(B);
    expect(pickRestoreBase(backups, { kind: 's3', name: '2026-10-21T01:30:00Z' }).name).toBe(A);
  });

  it('a name the bucket does not hold is a NoRestorePointError naming it', () => {
    expect(() =>
      pickRestoreBase(backups, {
        kind: 's3',
        name: 'latest',
        base: 'base_0000000100000000000000FF',
      }),
    ).toThrow(NoRestorePointError);
    expect(() =>
      pickRestoreBase(backups, {
        kind: 's3',
        name: 'latest',
        base: 'base_0000000100000000000000FF',
      }),
    ).toThrow(/base_0000000100000000000000FF/);
  });

  it("the e2e restore step passes the backup step's name", async () => {
    const { readFileSync } = await import('node:fs');
    const runner = readFileSync(new URL('../../e2e/utils/cli-runner.ts', import.meta.url), 'utf-8');
    expect(runner).toMatch(/restore \$\{env\} -y -source \$\{source\}/);
    const life = readFileSync(
      new URL('../../e2e/scenarios/_run-lifecycle.ts', import.meta.url),
      'utf-8',
    );
    expect(life).toMatch(/runRestore\(config\.envPrefix, pushedBackupName/);
  });
});
