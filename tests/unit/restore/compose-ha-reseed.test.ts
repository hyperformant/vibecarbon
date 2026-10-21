import * as p from '@clack/prompts';
import { describe, expect, it, vi } from 'vitest';
import { runComposeRestore } from '../../../src/restore.js';

// ---------------------------------------------------------------------------
// runComposeRestore() — compose-ha standby re-seed after a wal-g restore.
//
// A wal-g restore rewinds the primary to an earlier LSN. For a compose-ha
// deployment the standby is then AHEAD of the primary and cannot resume
// streaming, so runComposeRestore must re-seed it via configureStandbyReplication
// (a fresh pg_basebackup from the restored primary). For single-region compose
// there is no standby, so it must NOT be called.
//
// The SSH/side-effecting calls (restoreCompose, configureStandbyReplication)
// are injected via opts so the logic is unit-testable without a real server.
// ---------------------------------------------------------------------------

function makeSpinner() {
  return { start: vi.fn(), stop: vi.fn(), message: vi.fn() };
}

const baseArgs = {
  chosenSource: { kind: 's3' as const, name: 'latest' },
  envName: 'prod',
  projectName: 'myapp',
  serverIp: '10.0.0.1', // primary (servers[0])
  sshKeyPath: '/tmp/key',
};

// The restore target (serverIp) is derived in run() as the role==='primary'
// server, falling back to servers[0]. This mirrors that derivation so the
// post-failover case (roles swapped, array order preserved) is locked down:
// servers[0] is the standby after a failover, so an index-0 pick would target
// the wrong node and re-seed basebackup-from-self.
function deriveRestoreServerIp(servers: Array<{ ip: string; role?: string }>) {
  const primary = servers?.find((sv) => sv.role === 'primary');
  return primary?.ip || servers?.[0]?.ip;
}

describe('restore target selection (role-aware)', () => {
  it('picks the role===primary node even when it is not servers[0] (post-failover)', () => {
    // After a failover ha.js swaps roles but preserves array order, so the
    // standby sits at index 0 and the promoted primary at index 1.
    const servers = [
      { ip: '10.0.0.2', role: 'standby' },
      { ip: '10.0.0.1', role: 'primary' },
    ];
    expect(deriveRestoreServerIp(servers)).toBe('10.0.0.1');
  });

  it('falls back to servers[0] when no role is present (non-HA compose)', () => {
    expect(deriveRestoreServerIp([{ ip: '10.0.0.9' }])).toBe('10.0.0.9');
  });
});

describe('runComposeRestore — compose-ha standby re-seed', () => {
  it('re-seeds the standby from the restored primary for deployMode compose-ha', async () => {
    const restoreCompose = vi.fn().mockResolvedValue(undefined);
    const configureStandbyReplication = vi.fn().mockResolvedValue(true);
    const s = makeSpinner();

    await runComposeRestore({
      ...baseArgs,
      s,
      envConfig: {
        deployMode: 'compose-ha',
        servers: [
          { ip: '10.0.0.1', role: 'primary' },
          { ip: '10.0.0.2', role: 'standby' },
        ],
      },
      restoreCompose,
      configureStandbyReplication,
    });

    // Primary restored first.
    expect(restoreCompose).toHaveBeenCalledWith('10.0.0.1', '/tmp/key', 'myapp', 'latest');
    // Standby re-seeded FROM the restored primary: (standbyIp, primaryIp, key, name).
    expect(configureStandbyReplication).toHaveBeenCalledWith(
      '10.0.0.2',
      '10.0.0.1',
      '/tmp/key',
      'myapp',
    );
  });

  it('does NOT re-seed for single-region compose (no standby)', async () => {
    const restoreCompose = vi.fn().mockResolvedValue(undefined);
    const configureStandbyReplication = vi.fn().mockResolvedValue(true);
    const s = makeSpinner();

    await runComposeRestore({
      ...baseArgs,
      s,
      envConfig: {
        deployMode: 'compose',
        servers: [{ ip: '10.0.0.1', role: 'primary' }],
      },
      restoreCompose,
      configureStandbyReplication,
    });

    expect(restoreCompose).toHaveBeenCalledOnce();
    expect(configureStandbyReplication).not.toHaveBeenCalled();
  });

  it('skips re-seed (and does not throw) when compose-ha config has no standby entry', async () => {
    const restoreCompose = vi.fn().mockResolvedValue(undefined);
    const configureStandbyReplication = vi.fn().mockResolvedValue(true);
    const s = makeSpinner();

    await runComposeRestore({
      ...baseArgs,
      s,
      envConfig: {
        deployMode: 'compose-ha',
        servers: [{ ip: '10.0.0.1', role: 'primary' }],
      },
      restoreCompose,
      configureStandbyReplication,
    });

    expect(restoreCompose).toHaveBeenCalledOnce();
    expect(configureStandbyReplication).not.toHaveBeenCalled();
  });

  it('does NOT fail the restore when the standby re-seed throws (primary is restored + serving)', async () => {
    const restoreCompose = vi.fn().mockResolvedValue(undefined);
    const configureStandbyReplication = vi
      .fn()
      .mockRejectedValue(new Error('pg_basebackup connection refused'));
    const s = makeSpinner();

    // The re-seed failure is swallowed (warned, not rethrown) so the restore
    // still resolves — only the standby is degraded, the restore goal is met.
    await expect(
      runComposeRestore({
        ...baseArgs,
        s,
        envConfig: {
          deployMode: 'compose-ha',
          servers: [
            { ip: '10.0.0.1', role: 'primary' },
            { ip: '10.0.0.2', role: 'standby' },
          ],
        },
        restoreCompose,
        configureStandbyReplication,
      }),
    ).resolves.toBeUndefined();

    expect(restoreCompose).toHaveBeenCalledOnce();
    expect(configureStandbyReplication).toHaveBeenCalledOnce();
  });

  it('rejects a local-file source before touching the server', async () => {
    const restoreCompose = vi.fn().mockResolvedValue(undefined);
    const configureStandbyReplication = vi.fn().mockResolvedValue(true);
    const s = makeSpinner();

    await expect(
      runComposeRestore({
        ...baseArgs,
        chosenSource: { kind: 'local', path: './b.tar.gz', name: 'b.tar.gz' },
        s,
        envConfig: { deployMode: 'compose-ha', servers: [] },
        restoreCompose,
        configureStandbyReplication,
      }),
    ).rejects.toThrow(/wal-g-based/);

    expect(restoreCompose).not.toHaveBeenCalled();
    expect(configureStandbyReplication).not.toHaveBeenCalled();
  });

  it('never re-seeds a role-swapped env: the tunnel would copy the standby from itself', async () => {
    // After a compose failover the retired node carries role standby, but
    // WireGuard's primary address (10.99.0.1) is still on it (it was born the
    // primary), and configureStandbyReplication always dials that address: a
    // re-seed here would basebackup the retired node from its own database.
    const restoreCompose = vi.fn().mockResolvedValue(undefined);
    const configureStandbyReplication = vi.fn().mockResolvedValue(true);
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    const s = makeSpinner();

    await runComposeRestore({
      ...baseArgs,
      serverIp: '10.0.0.2',
      s,
      envConfig: {
        deployMode: 'compose-ha',
        lastFailover: '2026-10-05T00:00:00.000Z',
        servers: [
          { name: 'myapp-prod-primary', ip: '10.0.0.1', role: 'standby' },
          { name: 'myapp-prod-standby', ip: '10.0.0.2', role: 'primary' },
        ],
      },
      restoreCompose,
      configureStandbyReplication,
    });

    expect(restoreCompose).toHaveBeenCalledWith('10.0.0.2', '/tmp/key', 'myapp', 'latest');
    expect(configureStandbyReplication).not.toHaveBeenCalled();
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toMatch(/cannot resync/);
    expect(text).toMatch(/failover has swapped/);
    warn.mockRestore();
  });

  it('skips the re-seed on an older config without stack names when a failover came after the last deploy', async () => {
    const restoreCompose = vi.fn().mockResolvedValue(undefined);
    const configureStandbyReplication = vi.fn().mockResolvedValue(true);
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    const s = makeSpinner();

    await runComposeRestore({
      ...baseArgs,
      serverIp: '10.0.0.2',
      s,
      envConfig: {
        deployMode: 'compose-ha',
        deployedAt: '2026-10-01T00:00:00.000Z',
        lastFailover: '2026-10-05T00:00:00.000Z',
        servers: [
          { ip: '10.0.0.1', role: 'standby' },
          { ip: '10.0.0.2', role: 'primary' },
        ],
      },
      restoreCompose,
      configureStandbyReplication,
    });

    expect(configureStandbyReplication).not.toHaveBeenCalled();
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toMatch(/failed over .* after its last deploy/);
    expect(text).toContain('vibecarbon destroy prod');
    expect(text).toContain('vibecarbon restore prod');
    warn.mockRestore();
  });

  it('still re-seeds when the last deploy came after the last failover (reconverged)', async () => {
    const restoreCompose = vi.fn().mockResolvedValue(undefined);
    const configureStandbyReplication = vi.fn().mockResolvedValue(true);
    await runComposeRestore({
      ...baseArgs,
      s: makeSpinner(),
      envConfig: {
        deployMode: 'compose-ha',
        deployedAt: '2026-10-06T00:00:00.000Z',
        lastFailover: '2026-10-05T00:00:00.000Z',
        servers: [
          { ip: '10.0.0.1', role: 'primary' },
          { ip: '10.0.0.2', role: 'standby' },
        ],
      },
      restoreCompose,
      configureStandbyReplication,
    });
    expect(configureStandbyReplication).toHaveBeenCalledOnce();
  });
});
