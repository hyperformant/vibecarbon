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

vi.mock('../../../src/lib/ssh.js', () => ({
  getPostgresPod: vi.fn().mockResolvedValue('supabase-supabase-db-0'),
  sshKubectl: vi.fn().mockResolvedValue(''),
  sshRun: vi.fn().mockResolvedValue(''),
  getSSHKeyPath: vi.fn(),
}));

const { runK8sRestore } = await import('../../../src/restore.js');
const ssh = await import('../../../src/lib/ssh.js');

function makeSpinner() {
  return { start: vi.fn(), stop: vi.fn(), message: vi.fn() };
}

// k8s-HA env: identifyServers reads ha.primary/ha.standby (masterIp + supabaseIp
// + the persisted supabasePrivateIp — the local WireGuard-relay endpoint).
const haEnvConfig = {
  deployMode: 'kubernetes',
  ha: {
    enabled: true,
    primary: {
      masterIp: '10.0.1.1',
      supabaseIp: '10.0.1.9',
      supabasePrivateIp: '10.0.1.2',
      region: 'hel1',
    },
    standby: {
      masterIp: '10.0.2.1',
      supabaseIp: '10.0.2.9',
      supabasePrivateIp: '10.0.1.2',
      region: 'nbg1',
    },
  },
};

const baseArgs = {
  chosenSource: { kind: 's3' as const, name: 'latest' },
  envName: 'prod',
  serverIp: '10.0.1.1', // restored primary master
  sshKeyPath: '/tmp/key',
};

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(call?.[2]).toContain('--timeout=120s');
    expect(call?.[3]).toMatchObject({ timeout: 130_000 });
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
      standbySupabaseIp: '10.0.2.9',
      standbySupabasePrivateIp: '10.0.1.2',
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

  it('fails loudly (no masterIp fallback) when the standby supabase node IP is missing', async () => {
    const reseedStandbyFromPrimary = vi.fn();
    const readReplicationState = vi.fn();
    const s = makeSpinner();

    const noStandbySupabase = {
      ...haEnvConfig,
      ha: {
        ...haEnvConfig.ha,
        standby: { masterIp: '10.0.2.1', region: 'nbg1' }, // supabaseIp missing
      },
    };

    // The node-side PGDATA swap targets the standby SUPABASE node; falling back
    // to the master would swap on the wrong filesystem — must refuse instead.
    await expect(
      runK8sRestore({
        ...baseArgs,
        s,
        envConfig: noStandbySupabase,
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
