import { beforeEach, describe, expect, it, vi } from 'vitest';

// A wal-g base backup carries no planner statistics: right after
// restoreCompose promoted the cluster, `pg_stat_user_tables.n_live_tup` reads
// 0 for every table until autovacuum gets around to it — which looks exactly
// like data loss to whoever is verifying the restore (vibecarbon-web prod
// move, 2026-09-15: every count showed 0; real COUNT(*)s were all intact).
// Run ANALYZE once postgres is out of recovery, before the app comes back.

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

/** The remote shell each sshRunAsync call carries — the last argv element. */
function remoteCommands(): string[] {
  return vi
    .mocked(runCommandAsync)
    .mock.calls.map((c) => String((c[0] as string[]).at(-1)))
    .filter((s) => s.includes('docker compose'));
}

describe('restoreCompose runs ANALYZE after the restored cluster promotes', () => {
  beforeEach(() => {
    vi.mocked(runCommandAsync).mockReset();
    vi.mocked(runCommandAsync).mockImplementation(async (argv: unknown) => {
      const cmd = String((argv as string[]).at(-1));
      // The promotion poll: report "out of recovery" on the first probe.
      if (cmd.includes('pg_is_in_recovery')) return 'f\n';
      return '';
    });
  });

  it('issues ANALYZE between promotion and `compose start app`', async () => {
    await restoreCompose('1.2.3.4', '/tmp/key', 'proj', 'latest', { staleRetryDelaysMs: [] });
    const cmds = remoteCommands();
    const analyzeIdx = cmds.findIndex((c) => /psql\b.*\bANALYZE\b/.test(c));
    const promotedIdx = cmds.findIndex((c) => c.includes('pg_is_in_recovery'));
    const appStartIdx = cmds.findIndex((c) => c.includes('docker compose start app'));
    expect(analyzeIdx, `no ANALYZE in:\n${cmds.join('\n')}`).toBeGreaterThan(-1);
    expect(analyzeIdx).toBeGreaterThan(promotedIdx);
    expect(analyzeIdx).toBeLessThan(appStartIdx);
  });
});
