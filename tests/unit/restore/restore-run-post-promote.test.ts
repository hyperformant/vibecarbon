/**
 * `vibecarbon restore` when the restore succeeded but what follows it did not
 * (H2b): the first base backup on the restored timeline failed (and, on
 * k8s-ha, the standby re-seed too). The database IS restored and serving, so
 * run() still records the restored lineage (the next restore reads its
 * folder), names every cause, and exits 1, without the "Restore failed"
 * banner, which would say the opposite.
 *
 * run() is driven end to end: the listing, the restore and the push are
 * stubs; the lineage record is the real one, written to a scratch project.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const LINEAGE = '7699032860122738725';
const dir = mkdtempSync(join(tmpdir(), 'vc-restore-run-'));
const keyPath = join(dir, 'id_ed25519');
writeFileSync(keyPath, 'not-a-key');
const envConfig = { deployMode: 'compose', provider: 'hetzner', servers: [{ ip: '10.0.0.1' }] };

vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => ({ projectName: 'myapp', environments: { prod: envConfig } }),
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/cli/env-context.js', () => ({
  resolveEnvContext: async () => ({ envName: 'prod', envConfig, serverIp: '10.0.0.1' }),
}));
vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/providers/index.js')>()),
  resolveProviderToken: () => null,
}));
vi.mock('../../../src/lib/ssh.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/ssh.js')>()),
  getSSHKeyPath: () => keyPath,
}));
vi.mock('../../../src/lib/walg/restore-base.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/walg/restore-base.js')>()),
  readEnvBaseBackups: async () => ({
    s3Config: { bucket: 'myapp-backups' },
    location: `s3://myapp-backups/backups/myapp/prod/walg/${LINEAGE}`,
    lineage: LINEAGE,
    backups: [
      {
        name: 'base_000000010000000000000002',
        timeline: 1,
        finishTime: new Date('2026-10-20T01:00:00Z'),
        sizeBytes: 1024,
        uncompressedBytes: 4096,
      },
    ],
  }),
}));
vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/deploy/compose/index.js')>()),
  restoreCompose: vi.fn(async () => {}),
}));
const push = vi.fn();
// The read-only WAL gap probe on the primary (no ssh in this test).
const walGap = vi.fn();
const confirmFn = vi.fn();
vi.mock('@clack/prompts', async (orig) => ({
  ...(await orig<typeof import('@clack/prompts')>()),
  confirm: (...a: unknown[]) => confirmFn(...a),
}));
vi.mock('../../../src/lib/status/backup-health.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/status/backup-health.js')>()),
  readPrimaryWalGap: (...a: unknown[]) => walGap(...a),
}));
const stops: string[] = [];
vi.mock('../../../src/lib/tracker.js', () => ({
  createTracker: () => ({
    spinner: () => ({
      start() {},
      message() {},
      stop: (m: string) => {
        stops.push(String(m));
      },
    }),
    finish() {},
  }),
}));
vi.mock('../../../src/lib/walg/post-promote-backup.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/walg/post-promote-backup.js')>()),
  pushBaseBackupAfterPromote: (...a: unknown[]) => push(...a),
}));

const { run } = await import('../../../src/restore.js');
const { PostPromoteBackupError } = await import('../../../src/lib/walg/post-promote-backup.js');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  vi.restoreAllMocks();
  push.mockReset();
  walGap.mockReset();
  walGap.mockResolvedValue(null);
  writeFileSync(
    join(dir, '.vibecarbon.json'),
    JSON.stringify({ projectName: 'myapp', environments: { prod: envConfig } }),
  );
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});

describe('restore run(): the restore succeeded, its first base did not', () => {
  it('records the restored lineage, names the cause, exits 1, no "Restore failed"', async () => {
    push.mockRejectedValue(new PostPromoteBackupError('wal-g: i/o timeout', 'prod'));
    const errors: string[] = [];
    vi.spyOn(p.log, 'error').mockImplementation((m: string) => {
      errors.push(String(m));
    });
    stops.length = 0;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await expect(run(['prod', '-y', '-source', 'latest', '-confirm', 'prod'])).rejects.toThrow(
      'process.exit(1)',
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toContain(
      'promoted, but the first base backup on the new timeline failed: wal-g: i/o timeout; run vibecarbon backup prod now',
    );
    expect(stops).toContain('Database restored');
    expect(stops).not.toContain('Restore failed');
    const saved = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8'));
    expect(saved.environments.prod.backup.lineage).toBe(LINEAGE);
  });

  // The k8s-ha runner throws this when its push and its standby re-seed both
  // fail (k8s-ha-reseed.test.ts); the compose runner hands it through here.
  it('both a failed push and a failed re-seed: the lineage is recorded and both causes are named', async () => {
    const { RestoredDatabaseError } = await import('../../../src/restore.js');
    push.mockRejectedValue(
      new RestoredDatabaseError([
        new PostPromoteBackupError('wal-g: i/o timeout', 'prod'),
        new Error('HA restore: re-seeding the standby FAILED'),
      ]),
    );
    const errors: string[] = [];
    vi.spyOn(p.log, 'error').mockImplementation((m: string) => {
      errors.push(String(m));
    });
    stops.length = 0;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await expect(run(['prod', '-y', '-source', 'latest', '-confirm', 'prod'])).rejects.toThrow(
      'process.exit(1)',
    );
    expect(errors.join('\n')).toContain('wal-g: i/o timeout');
    expect(errors.join('\n')).toContain('re-seeding the standby FAILED');
    expect(stops).not.toContain('Restore failed');
    const saved = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8'));
    expect(saved.environments.prod.backup.lineage).toBe(LINEAGE);
  });
});

describe('restore run(): a live WAL gap record on the primary', () => {
  const GAP = { count: 2, first: '000000010000000000000007', last: '000000010000000000000009' };

  /** Runs a restore to latest with a confirmation; returns what was said, in order. */
  async function restoreLatest() {
    const order: string[] = [];
    vi.spyOn(p.log, 'warn').mockImplementation((m: string) => {
      order.push(`warn: ${m}`);
    });
    confirmFn.mockImplementation(async () => {
      order.push('confirm');
      return true;
    });
    push.mockResolvedValue(undefined);
    vi.spyOn(p.log, 'error').mockImplementation((m: string) => {
      order.push(`error: ${m}`);
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    // What follows the confirmation is not under test (the stubs end it early).
    await run(['prod', '-source', 'latest', '-confirm', 'prod']).catch(() => {});
    return order;
  }

  it('warns before the confirmation, naming the first gap', async () => {
    walGap.mockResolvedValue(GAP);
    const order = await restoreLatest();
    const warn = order.findIndex((m) => m.includes('first recorded WAL gap'));
    expect(warn).toBeGreaterThanOrEqual(0);
    expect(order[warn]).toContain('000000010000000000000007');
    expect(order[warn]).toContain('2 segments');
    expect(order.indexOf('confirm')).toBeGreaterThan(warn);
    expect(walGap).toHaveBeenCalledWith('prod', envConfig, 'myapp', '10.0.0.1');
  });

  it('says nothing when there is no gap record', async () => {
    const order = await restoreLatest();
    expect(order.join('\n')).not.toContain('WAL gap');
    expect(order).toContain('confirm');
  });

  it('says nothing, and still restores, when the primary cannot be read', async () => {
    walGap.mockRejectedValue(
      new Error('ssh: connect to host 10.0.0.1 port 22: Connection refused'),
    );
    const order = await restoreLatest();
    expect(order.join('\n')).not.toContain('WAL gap');
    expect(order).toContain('confirm');
  });

  it('is for latest only: a point-in-time target is not warned', async () => {
    walGap.mockResolvedValue(GAP);
    confirmFn.mockResolvedValue(true);
    push.mockResolvedValue(undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await run(['prod', '-y', '-source', '2026-10-20T01:30:00Z', '-confirm', 'prod']).catch(
      () => {},
    );
    expect(walGap).not.toHaveBeenCalled();
  });
});
