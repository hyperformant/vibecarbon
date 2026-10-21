import { beforeEach, describe, expect, it, vi } from 'vitest';

// The app no longer migrates at boot: app-migrate applies db/migrations as the
// owner and sets app_service's password. A restore to a point before a
// deployed migration, or from a backup that carries an older app_service
// password, must rerun it before the app starts, or the app answers 503 (or
// cannot log in) after a "successful" restore.

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/command.js')>();
  return { ...actual, runCommandAsync: vi.fn() };
});
vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/ssh.js')>();
  return { ...actual, sshRunScript: vi.fn(async () => '') };
});

import { runCommandAsync } from '../../../src/lib/command.js';
import { restoreCompose } from '../../../src/lib/deploy/compose/index.js';

function remoteCommands(): string[] {
  return vi
    .mocked(runCommandAsync)
    .mock.calls.map((c) => String((c[0] as string[]).at(-1)))
    .filter((s) => s.includes('docker compose'));
}

let migrateFails = false;

describe('restoreCompose reruns app-migrate before the app comes back', () => {
  beforeEach(() => {
    migrateFails = false;
    vi.mocked(runCommandAsync).mockReset();
    vi.mocked(runCommandAsync).mockImplementation(async (argv: unknown) => {
      const cmd = String((argv as string[]).at(-1));
      if (cmd.includes('pg_is_in_recovery')) return 'f\n';
      if (migrateFails && cmd.includes('app-migrate')) throw new Error('exit 1');
      return '';
    });
  });

  it('runs app-migrate to completion after ANALYZE and before `compose start app`', async () => {
    await restoreCompose('1.2.3.4', '/tmp/key', 'proj', 'latest', { staleRetryDelaysMs: [] });
    const cmds = remoteCommands();
    const analyzeIdx = cmds.findIndex((c) => /psql\b.*\bANALYZE\b/.test(c));
    const migrateIdx = cmds.findIndex((c) =>
      c.includes('docker compose run --rm --no-deps app-migrate'),
    );
    const appStartIdx = cmds.findIndex((c) => c.includes('docker compose start app'));
    expect(migrateIdx, `no app-migrate run in:\n${cmds.join('\n')}`).toBeGreaterThan(-1);
    expect(migrateIdx).toBeGreaterThan(analyzeIdx);
    expect(migrateIdx).toBeLessThan(appStartIdx);
  });

  it('a failed migration fails the restore loudly and leaves the app stopped', async () => {
    migrateFails = true;
    await expect(
      restoreCompose('1.2.3.4', '/tmp/key', 'proj', 'latest', { staleRetryDelaysMs: [] }),
    ).rejects.toThrow(/app-migrate failed after the restore/);
    expect(remoteCommands().some((c) => c.includes('docker compose start app'))).toBe(false);
  });
});
