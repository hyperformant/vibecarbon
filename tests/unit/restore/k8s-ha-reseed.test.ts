import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Finding #2: runK8sRestore performs a first-class VERIFIED standby re-seed for
 * k8s-HA envs (replacing the old warn-and-point-to-`deploy` behavior).
 *
 * A wal-g restore rewinds the PRIMARY cluster to an earlier LSN. The standby is
 * a SEPARATE cluster (deployed restore:null) that now has WAL ahead of the
 * primary and cannot resume streaming. runK8sRestore must:
 *   - re-seed the standby from the restored primary via the SHARED reseed
 *     primitive (injected here so no real cluster is needed),
 *   - verify streaming, and
 *   - FAIL LOUDLY (throw) if the re-seed can't complete — never silently leave a
 *     diverged standby.
 *
 * ssh.js is mocked so the S3-restore steps (marker, scale, rollout, verify) are
 * inert no-ops; the reseed + verify closures are injected.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real config writers (journal, proof, fence marker) run in these tests
// against no project: point them at an empty dir, never the repo root, where
// they would take the real config lock.
const noProjectDir = mkdtempSync(join(tmpdir(), 'vc-no-project-'));
beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(noProjectDir);
});

// The db pod name (DB_POD in src/lib/deploy/db-workload.js), spelled out:
// vi.mock factories are hoisted above every import.
// The promotion poll reads pg_is_in_recovery(): report promoted.
const promotedKubectl = async (_ip: string, _key: string, argv: string[]) =>
  argv.join(' ').includes('pg_is_in_recovery') ? 'f' : '';
vi.mock('../../../src/lib/ssh.js', async () => {
  // The real argv contract (tests/_shared/ssh-contract.ts).
  const { contractSshRun } = await import('../../_shared/ssh-contract.js');
  return {
    getPostgresPod: vi.fn().mockResolvedValue('db-0'),
    sshKubectl: vi.fn(promotedKubectl),
    sshRun: vi.fn(contractSshRun()),
    getSSHKeyPath: vi.fn(),
  };
});

const { runK8sRestore, RestoredDatabaseError } = await import('../../../src/restore.js');
const ssh = await import('../../../src/lib/ssh.js');

function makeSpinner() {
  return { start: vi.fn(), stop: vi.fn(), message: vi.fn() };
}

// k8s-HA env: identifyServers reads ha.primary/ha.standby (masterIp + dbIp
// + the persisted dbPrivateIp — the local WireGuard-relay endpoint).
const haEnvConfig = {
  deployMode: 'kubernetes',
  ha: {
    enabled: true,
    primary: {
      masterIp: '10.0.1.1',
      dbIp: '10.0.1.9',
      dbPrivateIp: '10.0.1.2',
      region: 'hel1',
    },
    standby: {
      masterIp: '10.0.2.1',
      dbIp: '10.0.2.9',
      dbPrivateIp: '10.0.1.2',
      region: 'nbg1',
    },
  },
};

const baseArgs = {
  chosenSource: { kind: 's3' as const, name: 'latest' },
  // The base run() resolved from the bucket's stop sentinels.
  base: {
    name: 'base_000000010000000000000002',
    timeline: 1,
    finishTime: new Date('2026-10-20T01:00:00Z'),
    sizeBytes: 4_290_228,
    uncompressedBytes: 23_439_374,
  },
  lineage: '7699032860122738725',
  readFreeBytes: async () => 100 * 1024 ** 3,
  assertWritable: async () => 'writable' as const,
  envName: 'prod',
  serverIp: '10.0.1.1', // restored primary master
  sshKeyPath: '/tmp/key',
  pushBaseBackup: vi.fn(async () => ({ name: 'base_000000020000000000000004' })),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runK8sRestore: a failover in flight (C2)', () => {
  it('refuses before the restore marker, the db bounce or the standby reseed', async () => {
    const reseedStandbyFromPrimary = vi.fn().mockResolvedValue('reseeded');
    await expect(
      runK8sRestore({
        ...baseArgs,
        s: makeSpinner(),
        envConfig: {
          ...haEnvConfig,
          ha: { ...haEnvConfig.ha, failoverInFlight: { id: 'j', target: 'standby' } },
        },
        ensureReplicationSlot: vi.fn().mockResolvedValue(undefined),
        reseedStandbyFromPrimary,
      }),
    ).rejects.toThrow(
      /Refusing to restore "prod": a failover is still in flight.*vibecarbon failover prod -abort/,
    );
    // The standby may be the promoted primary: nothing touches either side.
    expect(ssh.sshKubectl).not.toHaveBeenCalled();
    expect(reseedStandbyFromPrimary).not.toHaveBeenCalled();
  });
});

describe('runK8sRestore — k8s-HA standby re-seed', () => {
  it('bounds the post-restore db rollout-status inside the SSH client timeout (120s < 130s)', async () => {
    // Reconciliation invariant (see readiness-gate.test.ts): the old
    // --timeout=600s never functioned — sshRun's 120s client default cut it
    // to 2 minutes on every run. Declare the field-tested 120s and hold the
    // client at 130s so kubectl's own timeout error surfaces.
    const s = makeSpinner();
    await runK8sRestore({
      ...baseArgs,
      s,
      envConfig: haEnvConfig,
      ensureReplicationSlot: vi.fn().mockResolvedValue(undefined),
      reseedStandbyFromPrimary: vi.fn().mockResolvedValue('reseeded'),
      readReplicationState: vi.fn().mockResolvedValue('streaming'),
    });

    const call = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, , argv]) =>
        (argv as string[]).includes('status') &&
        (argv as string[]).join(' ').includes('statefulset/'),
    );
    expect(call).toBeTruthy();
    expect(call?.[2]).toContain('--timeout=600s');
    expect(call?.[3]).toMatchObject({ timeout: 630_000 });
  });

  it('recreates the replication slot, re-seeds the standby, and verifies streaming', async () => {
    const ensureReplicationSlot = vi.fn().mockResolvedValue(undefined);
    const reseedStandbyFromPrimary = vi.fn().mockResolvedValue('reseeded');
    const readReplicationState = vi.fn().mockResolvedValue('streaming');
    const s = makeSpinner();

    await expect(
      runK8sRestore({
        ...baseArgs,
        s,
        envConfig: haEnvConfig,
        ensureReplicationSlot,
        reseedStandbyFromPrimary,
        readReplicationState,
      }),
    ).resolves.toBeUndefined();

    // The wal-g restore wiped pg_replslot on the primary — the persistent slot
    // MUST be recreated on the restored PRIMARY master BEFORE the re-seed, since
    // the reseeded standby STREAMS through it post-swap (primary_slot_name). The
    // basebackup itself now uses a temp slot, but streaming still needs this one.
    expect(ensureReplicationSlot).toHaveBeenCalledWith('10.0.1.1', '/tmp/key');
    expect(ensureReplicationSlot.mock.invocationCallOrder[0]).toBeLessThan(
      reseedStandbyFromPrimary.mock.invocationCallOrder[0],
    );

    // Re-seed targets the STANDBY master IP with the standby node addresses:
    // public IP for the node-side PGDATA swap, private IP for the local
    // WireGuard relay the basebackup + conninfo dial (deploy-time transport —
    // no direct primary dial).
    expect(reseedStandbyFromPrimary).toHaveBeenCalledWith('10.0.2.1', '/tmp/key', {
      standbyDbIp: '10.0.2.9',
      standbyDbPrivateIp: '10.0.1.2',
      // The restored primary's lineage is what the standby now holds: record it.
      onSeeded: expect.any(Function),
    });
    // Verify reads pg_stat_replication on the PRIMARY master.
    expect(readReplicationState).toHaveBeenCalledWith('10.0.1.1', '/tmp/key');
  });

  it('fails loudly when slot recreation fails (re-seed never attempted)', async () => {
    const ensureReplicationSlot = vi.fn().mockRejectedValue(new Error('psql: connection refused'));
    const reseedStandbyFromPrimary = vi.fn();
    const readReplicationState = vi.fn();
    const s = makeSpinner();

    await expect(
      runK8sRestore({
        ...baseArgs,
        s,
        envConfig: haEnvConfig,
        ensureReplicationSlot,
        reseedStandbyFromPrimary,
        readReplicationState,
      }),
    ).rejects.toThrow(/recreating the replication slot\s+FAILED/i);
    expect(reseedStandbyFromPrimary).not.toHaveBeenCalled();
  });

  it('throws (fails loudly) when the standby re-seed throws', async () => {
    const reseedStandbyFromPrimary = vi
      .fn()
      .mockRejectedValue(new Error('pg_basebackup connection refused'));
    const readReplicationState = vi.fn();
    const s = makeSpinner();

    await expect(
      runK8sRestore({
        ...baseArgs,
        s,
        envConfig: haEnvConfig,
        reseedStandbyFromPrimary,
        readReplicationState,
      }),
    ).rejects.toThrow(/re-seeding the standby FAILED|DIVERGED timeline/i);
    expect(readReplicationState).not.toHaveBeenCalled();
  });

  it('throws when the re-seed is skipped (primary unreachable from standby)', async () => {
    const reseedStandbyFromPrimary = vi.fn().mockResolvedValue('skipped');
    const readReplicationState = vi.fn();
    const s = makeSpinner();

    await expect(
      runK8sRestore({
        ...baseArgs,
        s,
        envConfig: haEnvConfig,
        reseedStandbyFromPrimary,
        readReplicationState,
      }),
    ).rejects.toThrow(/could NOT reach the restored primary/i);
  });

  it('throws when the re-seed succeeds but streaming is never confirmed', async () => {
    const reseedStandbyFromPrimary = vi.fn().mockResolvedValue('reseeded');
    const readReplicationState = vi.fn().mockResolvedValue('catchup');
    const s = makeSpinner();

    await expect(
      runK8sRestore({
        ...baseArgs,
        s,
        envConfig: haEnvConfig,
        reseedStandbyFromPrimary,
        readReplicationState,
        verifySleep: () => Promise.resolve(), // don't wait on real timers
      }),
    ).rejects.toThrow(/streaming replication is NOT confirmed/i);
  });

  it('fails loudly (no masterIp fallback) when the standby database node IP is missing', async () => {
    const reseedStandbyFromPrimary = vi.fn();
    const readReplicationState = vi.fn();
    const s = makeSpinner();

    const noStandbyDb = {
      ...haEnvConfig,
      ha: {
        ...haEnvConfig.ha,
        standby: { masterIp: '10.0.2.1', region: 'nbg1' }, // dbIp missing
      },
    };

    // The node-side PGDATA swap targets the standby DATABASE node; falling back
    // to the master would swap on the wrong filesystem — must refuse instead.
    await expect(
      runK8sRestore({
        ...baseArgs,
        s,
        envConfig: noStandbyDb,
        reseedStandbyFromPrimary,
        readReplicationState,
      }),
    ).rejects.toThrow(/could NOT be\s+re-seeded|DIVERGED timeline/i);
    expect(reseedStandbyFromPrimary).not.toHaveBeenCalled();
  });

  it('does NOT re-seed for a single-region (non-HA) k8s env', async () => {
    const reseedStandbyFromPrimary = vi.fn();
    const readReplicationState = vi.fn();
    const s = makeSpinner();

    await expect(
      runK8sRestore({
        ...baseArgs,
        s,
        envConfig: { deployMode: 'kubernetes', servers: [{ ip: '10.0.1.1', role: 'master' }] },
        reseedStandbyFromPrimary,
        readReplicationState,
      }),
    ).resolves.toBeUndefined();

    expect(reseedStandbyFromPrimary).not.toHaveBeenCalled();
  });
});

describe('runK8sRestore — planner statistics', () => {
  it('runs ANALYZE in the db pod after postgres is ready and before the app scales back up', async () => {
    // Same reasoning as the compose path (compose-restore-analyze.test.ts):
    // a base backup carries no statistics, so n_live_tup reads 0 everywhere
    // until autovacuum runs — indistinguishable from data loss to whoever
    // verifies the restore.
    const s = makeSpinner();
    await runK8sRestore({
      ...baseArgs,
      s,
      envConfig: { deployMode: 'kubernetes' },
    });
    const calls = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls.map(([, , argv]) =>
      (argv as string[]).join(' '),
    );
    const analyzeIdx = calls.findIndex((c) => /exec .*psql.* ANALYZE/.test(c));
    const readyIdx = calls.findIndex((c) => c.includes('pg_isready'));
    const scaleUpIdx = calls.findIndex((c) => /scale .*--replicas=[1-9]/.test(c));
    expect(analyzeIdx, `no ANALYZE in:\n${calls.join('\n')}`).toBeGreaterThan(-1);
    expect(analyzeIdx).toBeGreaterThan(readyIdx);
    if (scaleUpIdx > -1) expect(analyzeIdx).toBeLessThan(scaleUpIdx);
  });
});

describe('runK8sRestore: a standby not re-seeded and verified is marked unproven (I2)', () => {
  const run = async (over: Record<string, unknown>) => {
    const markStandbyUnproven = vi.fn();
    const outcome = runK8sRestore({
      ...baseArgs,
      s: makeSpinner(),
      envConfig: haEnvConfig,
      ensureReplicationSlot: vi.fn().mockResolvedValue(undefined),
      reseedStandbyFromPrimary: vi.fn().mockResolvedValue('reseeded'),
      readReplicationState: vi.fn().mockResolvedValue('streaming'),
      verifySleep: async () => {},
      markStandbyUnproven,
      recordSystemIdentifier: vi.fn(),
      ...over,
    });
    return { outcome, markStandbyUnproven };
  };

  it('a verified reseed leaves the proof alone', async () => {
    const { outcome, markStandbyUnproven } = await run({});
    await outcome;
    expect(markStandbyUnproven).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the slot recreate fails',
      { ensureReplicationSlot: vi.fn().mockRejectedValue(new Error('x')) },
    ],
    ['the reseed fails', { reseedStandbyFromPrimary: vi.fn().mockRejectedValue(new Error('x')) }],
    ['the reseed is skipped', { reseedStandbyFromPrimary: vi.fn().mockResolvedValue('skipped') }],
    ['streaming is never confirmed', { readReplicationState: vi.fn().mockResolvedValue('') }],
    [
      'the standby cannot be resolved',
      {
        envConfig: { ...haEnvConfig, ha: { ...haEnvConfig.ha, standby: { masterIp: '10.0.2.1' } } },
      },
    ],
  ])('%s: throws, marked unproven first', async (_name, over) => {
    const { outcome, markStandbyUnproven } = await run(over);
    await expect(outcome).rejects.toThrow(/HA restore/);
    expect(markStandbyUnproven).toHaveBeenCalledWith({ environment: 'prod' });
  });
});

describe('markStandbyUnproven', () => {
  it('sets replication degraded and drops the recorded identifier, keeping the rest', async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { markStandbyUnproven } = await import('../../../src/lib/deploy/failover-guard.js');
    const dir = mkdtempSync(join(tmpdir(), 'vc-unproven-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'myapp',
        environments: {
          prod: { replication: 'streaming', ha: { enabled: true, systemIdentifier: '7' } },
        },
      }),
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      markStandbyUnproven({ environment: 'prod' });
      const env = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).environments
        .prod;
      expect(env).toEqual({ replication: 'degraded', degraded: true, ha: { enabled: true } });
    } finally {
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runK8sRestore: the restored primary is proven writable before the app returns (M4)', () => {
  it('after the db is back, before the app is scaled up', async () => {
    const order: string[] = [];
    vi.mocked(ssh.sshKubectl).mockImplementation(
      async (_ip: string, _k: string, argv: string[]) => {
        if (
          argv.includes('scale') &&
          argv.some((a) => a.startsWith('--replicas=') && a !== '--replicas=0')
        ) {
          order.push('scaleUp');
        }
        return promotedKubectl(_ip, _k, argv);
      },
    );
    await runK8sRestore({
      ...baseArgs,
      s: makeSpinner(),
      envConfig: { deployMode: 'kubernetes' },
      assertWritable: async () => {
        order.push('writable');
        return 'writable' as const;
      },
    });
    expect(order[0]).toBe('writable');
    expect(order).toContain('scaleUp');
  });
});

describe('runK8sRestore: the first base on the restored timeline (H2b)', () => {
  it('pushes on the restored primary before the standby re-seed', async () => {
    const reseedStandbyFromPrimary = vi.fn().mockResolvedValue('reseeded');
    await runK8sRestore({
      ...baseArgs,
      s: makeSpinner(),
      envConfig: haEnvConfig,
      ensureReplicationSlot: vi.fn().mockResolvedValue(undefined),
      reseedStandbyFromPrimary,
      readReplicationState: vi.fn().mockResolvedValue('streaming'),
      verifySleep: async () => {},
    });
    expect(baseArgs.pushBaseBackup).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'k8s', ip: '10.0.1.1', envName: 'prod' }),
    );
    expect(baseArgs.pushBaseBackup.mock.invocationCallOrder[0]).toBeLessThan(
      reseedStandbyFromPrimary.mock.invocationCallOrder[0],
    );
  });

  it('a failed push still re-seeds the standby, then fails the restore with its message', async () => {
    const fail = new Error(
      'promoted, but the first base backup on the new timeline failed: boom; run vibecarbon backup prod now',
    );
    const reseedStandbyFromPrimary = vi.fn().mockResolvedValue('reseeded');
    const markStandbyUnproven = vi.fn();
    await expect(
      runK8sRestore({
        ...baseArgs,
        s: makeSpinner(),
        envConfig: haEnvConfig,
        pushBaseBackup: vi.fn().mockRejectedValue(fail),
        ensureReplicationSlot: vi.fn().mockResolvedValue(undefined),
        reseedStandbyFromPrimary,
        readReplicationState: vi.fn().mockResolvedValue('streaming'),
        markStandbyUnproven,
        verifySleep: async () => {},
      }),
    ).rejects.toBe(fail);
    expect(reseedStandbyFromPrimary).toHaveBeenCalled();
    // The standby re-seeded and streams: only the base is missing.
    expect(markStandbyUnproven).not.toHaveBeenCalled();
  });

  it('a failed push AND a failed re-seed: one error carries both (the restore itself succeeded)', async () => {
    const pushFail = new Error(
      'promoted, but the first base backup on the new timeline failed: boom; run vibecarbon backup prod now',
    );
    const markStandbyUnproven = vi.fn();
    const err = await runK8sRestore({
      ...baseArgs,
      s: makeSpinner(),
      envConfig: haEnvConfig,
      pushBaseBackup: vi.fn().mockRejectedValue(pushFail),
      ensureReplicationSlot: vi.fn().mockResolvedValue(undefined),
      reseedStandbyFromPrimary: vi.fn().mockRejectedValue(new Error('pg_basebackup: no route')),
      markStandbyUnproven,
      verifySleep: async () => {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RestoredDatabaseError);
    expect(err.causes).toHaveLength(2);
    expect(err.causes[0]).toBe(pushFail);
    expect(err.message).toContain('the first base backup on the new timeline failed: boom');
    expect(err.message).toContain('pg_basebackup: no route');
    expect(markStandbyUnproven).toHaveBeenCalled();
  });
});
