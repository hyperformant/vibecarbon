import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const progressLog = vi.fn();
vi.mock('../../../src/lib/cli/progress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/cli/progress.js')>();
  return { ...actual, progressLog: (...args: unknown[]) => progressLog(...args) };
});

import {
  composeMigrationsRetryShell,
  isMigrationDeadlockError,
  MIGRATION_DEADLOCK_DELAYS_MS,
  MIGRATION_DEADLOCK_PATTERN,
  withMigrationDeadlockRetry,
} from '../../../src/lib/deploy/migration-deadlock.js';

/**
 * CLASS (run 33287840597, hetzner k8s-ha restore, 2026-08-30 03:5xZ): the
 * re-deploy's applyMigrations died on
 *
 *   ERROR:  deadlock detected
 *   DETAIL: Process 71 waits for AccessExclusiveLock on relation 16524 …
 *   command terminated with exit code 3
 *
 * The migration's --single-transaction DDL (policies/triggers on
 * storage.objects among others) raced a concurrently-booting Supabase
 * service running its OWN boot DDL on the same relations. The storage-schema
 * readiness probe passes as soon as buckets.public exists — it cannot prove
 * the service has no DDL still in flight, so the race window is inherent.
 *
 * A deadlocked --single-transaction file rolls back COMPLETELY, so re-running
 * that one file is exactly what attempt 1 did — retry is safe by
 * construction, and deadlock is transient by definition (the other
 * transaction proceeds once ours aborts).
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf-8');

describe('isMigrationDeadlockError', () => {
  it('matches psql deadlock output wherever the transport put it', () => {
    expect(isMigrationDeadlockError({ stderr: 'ERROR:  deadlock detected\nDETAIL: …' })).toBe(true);
    expect(isMigrationDeadlockError({ stdout: 'ERROR:  deadlock detected' })).toBe(true);
    expect(isMigrationDeadlockError(new Error('psql: ERROR:  deadlock detected'))).toBe(true);
  });

  it('rejects everything that is not a deadlock', () => {
    expect(isMigrationDeadlockError(new Error('syntax error at or near "CREATE"'))).toBe(false);
    expect(isMigrationDeadlockError({ stderr: 'connection refused' })).toBe(false);
    expect(isMigrationDeadlockError(null)).toBe(false);
    expect(isMigrationDeadlockError(undefined)).toBe(false);
  });
});

describe('withMigrationDeadlockRetry', () => {
  it('re-runs a deadlocked exec and succeeds', async () => {
    let calls = 0;
    const result = await withMigrationDeadlockRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('exit 3'), { stderr: 'deadlock detected' });
        return 'ok';
      },
      '00001_init.sql',
      { delaysMs: [0, 0] },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws immediately on a non-deadlock failure (real SQL errors stay loud)', async () => {
    let calls = 0;
    await expect(
      withMigrationDeadlockRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('exit 3'), { stderr: 'syntax error at or near "FROM"' });
        },
        '00001_init.sql',
        { delaysMs: [0, 0] },
      ),
    ).rejects.toThrow('exit 3');
    expect(calls).toBe(1);
  });

  it('gives up after the ladder is exhausted, propagating the deadlock error', async () => {
    let calls = 0;
    await expect(
      withMigrationDeadlockRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('exit 3'), { stderr: 'deadlock detected' });
        },
        '00001_init.sql',
        { delaysMs: [0, 0] },
      ),
    ).rejects.toThrow('exit 3');
    expect(calls).toBe(3);
  });

  it('logs each retry with the file name and attempt count', async () => {
    progressLog.mockReset();
    let calls = 0;
    await withMigrationDeadlockRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('x'), { stderr: 'deadlock detected' });
        return 'ok';
      },
      '00007_notifications.sql',
      { delaysMs: [0, 0] },
    );
    expect(progressLog).toHaveBeenCalledTimes(1);
    const line = String(progressLog.mock.calls[0][0]);
    expect(line).toContain('00007_notifications.sql');
    expect(line).toMatch(/deadlock.*attempt 1\/3/i);
  });
});

describe('composeMigrationsRetryShell', () => {
  const shell = composeMigrationsRetryShell();

  it('keeps the atomicity contract: ON_ERROR_STOP=1 and --single-transaction per file', () => {
    expect(shell).toContain('ON_ERROR_STOP=1');
    expect(shell).toContain('--single-transaction');
  });

  it('retries a file only on deadlock, bounded by the shared ladder', () => {
    const attempts = MIGRATION_DEADLOCK_DELAYS_MS.length + 1;
    expect(shell).toContain('deadlock detected');
    // Bounded attempt loop derived from the SAME constant the JS ladder uses,
    // so shell and k8s retries cannot drift apart.
    expect(shell).toContain(`seq 1 ${attempts}`);
  });

  it('still fails the deploy loudly when a file cannot be applied', () => {
    expect(shell).toContain('FAILED applying');
    expect(shell).toMatch(/exit 1/);
  });
});

describe('call sites route through the deadlock retry (source pins)', () => {
  it('k3s applyMigrations wraps its per-file psql exec', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toContain('withMigrationDeadlockRetry(');
  });

  it('compose migrations use the shared shell builder, not a hand-rolled loop', () => {
    const compose = read('src/lib/deploy/compose/index.js');
    expect(compose).toContain('composeMigrationsRetryShell(');
    // The old inline form (no retry) must be gone — its psql loop is the one
    // that died on the 2026-08-30 deadlock's compose siblings.
    expect(compose).not.toMatch(/for f in \$\(ls supabase\/migrations/);
  });
});

describe('pattern hygiene', () => {
  it('the pattern matches the observed psql spelling and nothing broader', () => {
    expect(MIGRATION_DEADLOCK_PATTERN.test('ERROR:  deadlock detected')).toBe(true);
    expect(MIGRATION_DEADLOCK_PATTERN.test('lock timeout')).toBe(false);
  });
});
