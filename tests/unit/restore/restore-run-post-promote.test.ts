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
