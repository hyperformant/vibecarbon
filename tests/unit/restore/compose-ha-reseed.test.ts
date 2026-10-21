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

// The base run() resolved from the bucket's stop sentinels.
const BASE = {
  name: 'base_000000010000000000000002',
  timeline: 1,
  finishTime: new Date('2026-10-20T01:00:00Z'),
  sizeBytes: 4_290_228,
  uncompressedBytes: 23_439_374,
};

/** restoreCompose's 4th argument for BASE restored to `latest`. */
const restorePoint = () =>
  expect.objectContaining({
    backup: BASE.name,
    lineage: '7699032860122738725',
    target: 'latest',
    // Pinned to the lineage run() resolved (I1); the timeline line follows it.
    recoveryConf: expect.stringMatching(
      /export RESTORE_LINEAGE=7699032860122738725;[\s\S]*recovery_target_timeline = 'current'/,
    ),
    requiredBytes: BASE.uncompressedBytes,
    assertWritable: expect.any(Function),
  });

const baseArgs = {
  chosenSource: { kind: 's3' as const, name: 'latest' },
  base: BASE,
  // The lineage run() resolved (its archive folder holds BASE).
  lineage: '7699032860122738725',
  envName: 'prod',
  projectName: 'myapp',
  serverIp: '10.0.0.1', // primary (servers[0])
  sshKeyPath: '/tmp/key',
  // The post-reseed proof and the config writes (I2), inert by default.
  readStandbyState: async () => ({ inRecovery: true, systemIdentifier: '7412345678901234567' }),
  markStandbyUnproven: () => {},
  recordSystemIdentifier: () => {},
  assertWritable: async () => 'writable',
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
    expect(restoreCompose).toHaveBeenCalledWith('10.0.0.1', '/tmp/key', 'myapp', restorePoint());
    // Standby re-seeded FROM the restored primary: (standbyIp, primaryIp, key,
    // name), dialing the primary's own tunnel address (its stack's, wgIpOf).
    expect(configureStandbyReplication).toHaveBeenCalledWith(
      '10.0.0.2',
      '10.0.0.1',
      '/tmp/key',
      'myapp',
      { primaryHost: '10.99.0.1' },
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

  it('never re-seeds a role-swapped env: it names the role-aware deploy instead', async () => {
    // After a compose failover the retired node carries role standby and is
    // frozen at the failover; rebuilding it by role is the deploy's reconverge
    // (compose/ha-role-swap.js), so restore leaves it to that.
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

    expect(restoreCompose).toHaveBeenCalledWith('10.0.0.2', '/tmp/key', 'myapp', restorePoint());
    expect(configureStandbyReplication).not.toHaveBeenCalled();
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toMatch(/failed over/);
    expect(text).toContain('vibecarbon deploy prod');
    expect(text).toMatch(/rebuilds the standby/);
    expect(text).not.toContain('vibecarbon destroy');
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
    expect(text).toMatch(/failed over/);
    expect(text).toContain('vibecarbon deploy prod');
    expect(text).not.toContain('vibecarbon destroy');
    warn.mockRestore();
  });

  it('with a failover still in flight, refuses before touching the old primary (C2)', async () => {
    const restoreCompose = vi.fn().mockResolvedValue(undefined);
    const configureStandbyReplication = vi.fn().mockResolvedValue(true);
    await expect(
      runComposeRestore({
        ...baseArgs,
        s: makeSpinner(),
        envConfig: {
          deployMode: 'compose-ha',
          ha: { failoverInFlight: { id: 'j', target: 'standby' } },
          servers: [
            { name: 'myapp-prod-primary', ip: '10.0.0.1', role: 'primary' },
            { name: 'myapp-prod-standby', ip: '10.0.0.2', role: 'standby' },
          ],
        },
        restoreCompose,
        configureStandbyReplication,
      }),
    ).rejects.toThrow(
      /Refusing to restore "prod": a failover is still in flight.*vibecarbon failover prod -abort/,
    );
    // The fenced old primary is never rewound or restarted next to a standby
    // that may already be promoted.
    expect(restoreCompose).not.toHaveBeenCalled();
    expect(configureStandbyReplication).not.toHaveBeenCalled();
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

describe('runComposeRestore: a standby not re-seeded and verified is marked unproven (I2)', () => {
  const pair = {
    deployMode: 'compose-ha',
    servers: [
      { name: 'myapp-prod-primary', ip: '10.0.0.1', role: 'primary' },
      { name: 'myapp-prod-standby', ip: '10.0.0.2', role: 'standby' },
    ],
  };
  const run = async (over: Record<string, unknown>) => {
    const markStandbyUnproven = vi.fn();
    const recordSystemIdentifier = vi.fn();
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    await runComposeRestore({
      ...baseArgs,
      s: makeSpinner(),
      envConfig: pair,
      restoreCompose: vi.fn().mockResolvedValue(undefined),
      configureStandbyReplication: vi.fn().mockResolvedValue(true),
      markStandbyUnproven,
      recordSystemIdentifier,
      ...over,
    });
    warn.mockRestore();
    return { markStandbyUnproven, recordSystemIdentifier };
  };

  it('a verified reseed records the identifier and stays proven', async () => {
    const { markStandbyUnproven, recordSystemIdentifier } = await run({});
    expect(markStandbyUnproven).not.toHaveBeenCalled();
    expect(recordSystemIdentifier).toHaveBeenCalledWith(
      { environment: 'prod' },
      '7412345678901234567',
    );
  });

  it('a failed reseed marks it unproven', async () => {
    const { markStandbyUnproven } = await run({
      configureStandbyReplication: vi.fn().mockRejectedValue(new Error('basebackup failed')),
    });
    expect(markStandbyUnproven).toHaveBeenCalledWith({ environment: 'prod' });
  });

  it('a reseed that does not read back as a replica marks it unproven', async () => {
    const { markStandbyUnproven, recordSystemIdentifier } = await run({
      readStandbyState: async () => ({ inRecovery: false, systemIdentifier: '1' }),
    });
    expect(markStandbyUnproven).toHaveBeenCalledOnce();
    expect(recordSystemIdentifier).not.toHaveBeenCalled();
  });

  it('a skipped reseed (failed-over pair) marks it unproven', async () => {
    const { markStandbyUnproven } = await run({
      envConfig: {
        ...pair,
        deployedAt: '2026-10-01T00:00:00.000Z',
        lastFailover: '2026-10-05T00:00:00.000Z',
      },
    });
    expect(markStandbyUnproven).toHaveBeenCalledOnce();
  });
});

// Final review M4: a backup taken under a stranded write fence carries
// default_transaction_read_only=on, so the restored primary must be proven
// writable (or lifted) before anything else.
// restoreCompose runs the proof (before it drops the previous cluster), so the
// injected restoreCompose calls the assertWritable it is handed.
describe('runComposeRestore: the restored primary is proven writable first (M4)', () => {
  it('right after the restore, before the standby reseed', async () => {
    const order: string[] = [];
    await runComposeRestore({
      ...baseArgs,
      s: makeSpinner(),
      envConfig: {
        deployMode: 'compose-ha',
        servers: [
          { name: 'myapp-prod-primary', ip: '10.0.0.1', role: 'primary' },
          { name: 'myapp-prod-standby', ip: '10.0.0.2', role: 'standby' },
        ],
      },
      restoreCompose: vi.fn(async (_ip, _key, _project, point) => {
        order.push('restore');
        await point.assertWritable();
      }),
      configureStandbyReplication: vi.fn(async () => {
        order.push('reseed');
        return true;
      }),
      assertWritable: async () => {
        order.push('writable');
      },
    });
    expect(order).toEqual(['restore', 'writable', 'reseed']);
  });
});

describe('assertRestoredPrimaryWritable', () => {
  it('lifts a fence the backup carried, proving it off', async () => {
    const { assertRestoredPrimaryWritable } = await import('../../../src/restore.js');
    let setting = 'on';
    const sqls: string[] = [];
    const exec = vi.fn(async (sql: string) => {
      sqls.push(sql);
      if (sql.startsWith('ALTER SYSTEM RESET')) setting = 'off';
      if (sql.includes('current_setting')) return setting;
      return '';
    });
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    await assertRestoredPrimaryWritable({ environment: 'prod', envConfig: {}, exec });
    expect(sqls).toContain('ALTER SYSTEM RESET default_transaction_read_only');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /restored database: the primary was write-fenced/,
    );
    warn.mockRestore();
  });

  it('a lift that fails throws with the manual fix', async () => {
    const { assertRestoredPrimaryWritable } = await import('../../../src/restore.js');
    const exec = vi.fn(async (sql: string) => {
      if (sql.startsWith('ALTER')) throw new Error('permission denied');
      return 'on';
    });
    await expect(
      assertRestoredPrimaryWritable({ environment: 'prod', envConfig: {}, exec }),
    ).rejects.toThrow(/write-fenced and could not be lifted/);
  });
});
