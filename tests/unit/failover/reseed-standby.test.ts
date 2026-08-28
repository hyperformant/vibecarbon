/**
 * Regression (findings #1 + #2 + the 2026-07-06 pod-kill + WG-relay fixes):
 * the k8s failover/restore standby re-seed must
 *   - read REPL_PASSWORD from the `vibecarbon-secrets` k8s Secret (NOT a
 *     compose-style `.env.local`, which k8s nodes never have),
 *   - HARD-ERROR when the password is missing (abort — never silently skip),
 *   - SKIP (no destructive work) when the primary is unreachable,
 *   - NEVER run an in-pod `pg_ctl stop` (the postmaster is the container's
 *     PID 1 — stopping it kills the pod and kubelet reboots it as a fresh
 *     independent primary). Instead: stage the basebackup while postgres runs,
 *     scale the StatefulSet to zero, swap PGDATA in a short-lived HELPER POD
 *     that mounts the released PVC (uniform for local-path AND CSI volumes),
 *     scale back up, and confirm recovery,
 *   - dial the standby's LOCAL WireGuard relay (own supabase-node private IP :
 *     repl-gateway port 15433) for the probe, basebackup, AND primary_conninfo
 *     — the deploy-time transport. The old direct `primary:5432` dial is dead
 *     post-WireGuard (firewall admits only UDP 51821).
 *
 * ssh.js is mocked so the logic is exercised without a real cluster.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/ssh.js', () => ({
  getPostgresPod: vi.fn(),
  sshKubectl: vi.fn(),
  sshRun: vi.fn(),
  getSSHKeyPath: vi.fn(),
}));

const ssh = await import('../../../src/lib/ssh.js');
const { getReplPasswordFromSecret, reseedAndPromoteOrAbort, reseedStandbyFromPrimary } =
  await import('../../../src/failover.js');
const { ensureReplicationSlot, isStandbyPromoted, isStandbyStreaming } = await import(
  '../../../src/lib/deploy/replication.js'
);

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

// The standby's node addresses: public (ssh target for the node-side swap) and
// private (the local repl-gateway relay endpoint the basebackup dials).
const STANDBY_OPTS = { standbySupabaseIp: '10.0.0.8', standbySupabasePrivateIp: '10.0.1.2' };

// The swap-pod inputs come from the db pod spec: PVC claimName, the subPath the
// chart mounts the volume at (postgres-data), and the db container image (reused
// for the swap pod). No PV node-path walk — the swap runs in a helper pod that
// mounts the PVC, so local-path AND csi.hetzner.cloud volumes work identically.
const DB_IMAGE = 'supabase/postgres:15.8.1.060';
const POD_JSON = JSON.stringify({
  spec: {
    containers: [
      {
        name: 'supabase-db',
        image: DB_IMAGE,
        volumeMounts: [
          {
            name: 'postgres-volume',
            mountPath: '/var/lib/postgresql/data',
            subPath: 'postgres-data',
          },
        ],
      },
    ],
    volumes: [
      {
        name: 'postgres-volume',
        persistentVolumeClaim: { claimName: 'data-supabase-supabase-db-0' },
      },
    ],
  },
});
// In the swap pod the whole PVC is mounted (no subPath) at /pgdata-vol, so PGDATA
// is <mount-root>/<subPath>.
const PGDATA_IN_POD = '/pgdata-vol/postgres-data';

/** Happy-path sshKubectl behavior for the full reseed sequence. */
function happyKubectl(
  overrides: {
    recovery?: string;
    swapLog?: string;
    swapPhase?: string;
    swapConditions?: Array<{ type: string; reason?: string; message?: string }>;
  } = {},
) {
  return async (_ip: string, _k: string, argv: string[]) => {
    const cmd = argv.join(' ');
    if (cmd.includes('get secret')) return b64('pw');
    if (cmd.includes('pg_isready')) return 'accepting connections';
    // helper-pod swap lifecycle (must precede the generic db-pod matchers).
    // The status poll is shell-safe `get pod ... -o json` (JS-parsed) — the old
    // jsonpath's |/?() metachars were a remote bash syntax error through the
    // joined-argv ssh transport.
    if (cmd.includes('get pod vibecarbon-pgdata-swap') && cmd.includes('-o json'))
      return JSON.stringify({
        status: {
          phase: overrides.swapPhase ?? 'Succeeded',
          conditions: overrides.swapConditions ?? [],
        },
      });
    if (cmd.includes('logs vibecarbon-pgdata-swap')) return overrides.swapLog ?? 'RESEED_SWAPPED';
    if (cmd.includes('get pod') && cmd.includes('-o json')) return POD_JSON;
    if (cmd.includes('--ignore-not-found')) return ''; // db pod gone / swap-pod delete
    if (cmd.includes('pg_is_in_recovery')) return overrides.recovery ?? 't';
    return '';
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (ssh.getPostgresPod as ReturnType<typeof vi.fn>).mockResolvedValue('supabase-supabase-db-0');
});

describe('getReplPasswordFromSecret', () => {
  it('decodes the base64 secret value from vibecarbon-secrets', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValue(b64('s3cret-pw'));
    await expect(getReplPasswordFromSecret('10.0.0.2', '/k')).resolves.toBe('s3cret-pw');
    // Reads the Secret via jsonpath — the same source the db uses.
    const args = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(args).toEqual(
      expect.arrayContaining([
        'get',
        'secret',
        'vibecarbon-secrets',
        '-o',
        'jsonpath={.data.REPL_PASSWORD}',
      ]),
    );
  });

  it('returns null when the key is absent', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValue('');
    await expect(getReplPasswordFromSecret('10.0.0.2', '/k')).resolves.toBeNull();
  });
});

describe('ensureReplicationSlot', () => {
  it('idempotently creates the physical slot over stdin (IF-NOT-EXISTS guard)', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValue('');
    await ensureReplicationSlot('10.0.0.1', '/k');

    const call = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls.find(([, , argv]) =>
      (argv as string[]).includes('psql'),
    );
    expect(call).toBeTruthy();
    const [ip, , argv, opts] = call as [string, string, string[], { input?: string }];
    expect(ip).toBe('10.0.0.1');
    // Errors must surface (a missing slot would fail the reseed minutes later).
    expect(argv).toEqual(expect.arrayContaining(['psql', '-v', 'ON_ERROR_STOP=1']));
    // SQL travels over stdin; same slot + guard shape as primary-init.sql.
    expect(opts.input).toContain("pg_create_physical_replication_slot('vibecarbon_standby_slot')");
    expect(opts.input).toContain('IF NOT EXISTS');
    expect(opts.input).toContain("slot_name = 'vibecarbon_standby_slot'");
  });
});

describe('reseedStandbyFromPrimary', () => {
  it('HARD-ERRORS (does not silently skip) when the password is missing', async () => {
    // First sshKubectl call = get secret → empty.
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');
    await expect(reseedStandbyFromPrimary('10.0.0.2', '/k', STANDBY_OPTS)).rejects.toThrow(
      /REPL_PASSWORD not found/,
    );
  });

  it('HARD-ERRORS when the standby supabase node IP is unknown (node-side swap target)', async () => {
    await expect(
      reseedStandbyFromPrimary('10.0.0.2', '/k', {
        standbySupabaseIp: undefined,
        standbySupabasePrivateIp: '10.0.1.2',
      }),
    ).rejects.toThrow(/standby supabase node IP is unknown/);
  });

  it('returns "skipped" WITHOUT any destructive work when the primary is unreachable', async () => {
    const calls: string[][] = [];
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      async (_ip: string, _k: string, argv: string[]) => {
        calls.push(argv);
        if (argv.includes('get')) return b64('pw'); // secret read
        if (argv.join(' ').includes('pg_isready')) throw new Error('no response'); // unreachable
        return '';
      },
    );
    await expect(reseedStandbyFromPrimary('10.0.0.2', '/k', STANDBY_OPTS)).resolves.toBe('skipped');
    // No `bash`-piped basebackup exec, no scale-to-zero, no node-side swap.
    expect(calls.some((a) => a.includes('bash'))).toBe(false);
    expect(calls.some((a) => a.includes('--replicas=0'))).toBe(false);
    expect(ssh.sshRun).not.toHaveBeenCalled();
  });

  it('probes the LOCAL WireGuard relay, not the primary public IP', async () => {
    const calls: string[][] = [];
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      async (ip: string, k: string, argv: string[]) => {
        calls.push(argv);
        return happyKubectl()(ip, k, argv);
      },
    );
    await reseedStandbyFromPrimary('10.0.0.2', '/k', STANDBY_OPTS);

    const probe = calls.find((a) => a.includes('pg_isready'));
    expect(probe).toBeTruthy();
    // -h <standby node private IP> -p 15433 (relay), NOT a public IP : 5432.
    expect(probe).toEqual(expect.arrayContaining(['-h', '10.0.1.2', '-p', '15433']));
    expect(probe?.join(' ')).not.toContain('5432');
  });

  it('bounds the post-swap db rollout-status inside the SSH client timeout (300s < 310s)', async () => {
    // Reconciliation invariant (see readiness-gate.test.ts): kubectl's
    // --timeout must sit inside the SSH client timeout so kubectl's own
    // error surfaces instead of a generic SSH kill. (An earlier 300s was
    // silently capped by sshRun's 120s default; the pinned 120s that
    // replaced it then flaked on healthy post-swap boots — perf slices
    // measured 165.8s on a green rig, run 29378289779 — so the budget is
    // back to 300s WITH the matching explicit client cap.)
    const calls: Array<{ argv: string[]; opts?: { timeout?: number } }> = [];
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      async (ip: string, k: string, argv: string[], opts: { timeout?: number } = {}) => {
        calls.push({ argv, opts });
        return happyKubectl()(ip, k, argv);
      },
    );
    await reseedStandbyFromPrimary('10.0.0.2', '/k', STANDBY_OPTS);

    const status = calls.find(
      (c) => c.argv.includes('status') && c.argv.join(' ').includes('statefulset/'),
    );
    expect(status).toBeTruthy();
    const timeoutArg = status?.argv.find((a) => a.startsWith('--timeout='));
    expect(timeoutArg).toBe('--timeout=300s');
    const clientTimeout = status?.opts?.timeout ?? 0;
    expect(clientTimeout).toBe(310_000);
    // The invariant itself, independent of the concrete numbers.
    expect(clientTimeout).toBeGreaterThan(300 * 1000);
  });

  it('reseeds via stage → scale-0 → helper-pod swap → scale-1 → recovery confirm', async () => {
    const kubectlCalls: { cmd: string; input?: string }[] = [];
    let stagedScript = '';
    let swapManifest = '';
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      async (ip: string, k: string, argv: string[], opts: { input?: string } = {}) => {
        kubectlCalls.push({ cmd: argv.join(' '), input: opts?.input });
        if (argv.includes('bash') && argv.includes('exec') && opts?.input)
          stagedScript = opts.input;
        if (argv.join(' ').includes('apply -f -') && opts?.input) swapManifest = opts.input;
        return happyKubectl()(ip, k, argv);
      },
    );

    await expect(reseedStandbyFromPrimary('10.0.0.2', '/k', STANDBY_OPTS)).resolves.toBe(
      'reseeded',
    );

    const joined = kubectlCalls.map((c) => c.cmd).join('\n');
    // The RCA'd killer is gone: NO in-pod pg_ctl stop (and no pg_ctl start —
    // the StatefulSet controller owns the lifecycle now).
    expect(joined).not.toMatch(/pg_ctl stop/);
    expect(joined).not.toMatch(/pg_ctl start/);
    // No node-path walk — the swap is a helper pod, so CSI volumes work too.
    expect(joined).not.toMatch(/get pv /);

    // Staged basebackup: hardened, into the PGDATA-resident staging subdir,
    // WITHOUT the destructive in-place swap (the helper pod does that).
    expect(stagedScript).toMatch(/set -e -o pipefail/);
    expect(stagedScript).toContain('/var/lib/postgresql/data/.reseed_staging');
    expect(stagedScript).toMatch(/pg_basebackup/);
    expect(stagedScript).not.toMatch(/find \/var\/lib\/postgresql\/data -mindepth 1 -delete/);
    // The reseed basebackup uses a TEMPORARY slot (no -S): the standby's own
    // walreceiver may still hold the persistent slot, and -S against an active
    // slot errors "slot is active for PID" (live RCA compose-ha 2026-07-07).
    expect(stagedScript).not.toMatch(/-S \S/);
    // The persistent slot is still wired for POST-SWAP streaming.
    expect(stagedScript).toContain("primary_slot_name = 'vibecarbon_standby_slot'");
    // Password is delivered via stdin (PGPASSWORD in the script), never argv.
    expect(stagedScript).toContain("PGPASSWORD='pw'");

    // WireGuard relay transport — same as the deploy-time seed: basebackup dials
    // the standby's OWN node private IP on the repl-gateway port, and the pinned
    // primary_conninfo matches buildPrimaryConninfo byte-for-byte.
    expect(stagedScript).toContain('-h 10.0.1.2 -p 15433');
    expect(stagedScript).toContain(
      "primary_conninfo = 'host=10.0.1.2 port=15433 user=replicator password=pw " +
        "sslmode=disable application_name=standby'",
    );
    expect(stagedScript).not.toContain('-p 5432');

    // Scale to 0 before the swap, back to 1 after.
    const cmds = kubectlCalls.map((c) => c.cmd);
    const scale0 = cmds.findIndex((c) => c.includes('--replicas=0'));
    const scale1 = cmds.findIndex((c) => c.includes('--replicas=1'));
    expect(scale0).toBeGreaterThanOrEqual(0);
    expect(scale1).toBeGreaterThan(scale0);

    // The swap runs in a helper pod (NOT a node-side ssh — sshRun is unused).
    expect(ssh.sshRun).not.toHaveBeenCalled();
    // Its manifest mounts the SAME PVC (claimName), reuses the db image, and its
    // command runs the swap script against PGDATA=<mount-root>/<subPath>.
    expect(swapManifest).toContain('data-supabase-supabase-db-0');
    expect(swapManifest).toContain(DB_IMAGE);
    expect(swapManifest).toContain('/pgdata-vol');
    expect(swapManifest).toContain(`PGDATA='${PGDATA_IN_POD}'`);
    // The swap-pod apply happens after scale-0 and before scale-1.
    const swapIdx = cmds.findIndex((c) => c.includes('apply -f -'));
    expect(swapIdx).toBeGreaterThan(scale0);
    expect(swapIdx).toBeLessThan(scale1);
    // The one-shot swap pod is cleaned up.
    expect(cmds.some((c) => c.includes('delete pod vibecarbon-pgdata-swap'))).toBe(true);

    // Recovery was confirmed on the reseeded standby.
    expect(cmds.some((c) => c.includes('pg_is_in_recovery'))).toBe(true);
  });

  it('HARD-ERRORS when the private IP is not persisted (no 10.0.1.2 fallback)', async () => {
    // The IaC value is only deterministic on Hetzner — DO assigns VPC
    // addresses dynamically, so a Hetzner-shaped fallback makes the
    // reachability probe fail closed into 'skipped' (promotion without
    // re-seed). A missing persisted value must abort, not assume.
    await expect(
      reseedStandbyFromPrimary('10.0.0.2', '/k', { standbySupabaseIp: '10.0.0.8' }),
    ).rejects.toThrow(/standbySupabasePrivateIp is required/);
  });

  it('dials the PERSISTED relay host (threaded, never assumed)', async () => {
    let stagedScript = '';
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      async (ip: string, k: string, argv: string[], opts: { input?: string } = {}) => {
        if (argv.includes('bash') && opts?.input) stagedScript = opts.input;
        return happyKubectl()(ip, k, argv);
      },
    );
    await expect(
      reseedStandbyFromPrimary('10.0.0.2', '/k', {
        standbySupabaseIp: '10.0.0.8',
        standbySupabasePrivateIp: '10.10.0.7',
      }),
    ).resolves.toBe('reseeded');
    expect(stagedScript).toContain('-h 10.10.0.7 -p 15433');
  });

  it('scales back up and throws when the pod-gone staging vanished (swap reports SKIPPED)', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      happyKubectl({ swapLog: 'RESEED_SKIPPED' }),
    );

    await expect(reseedStandbyFromPrimary('10.0.0.2', '/k', STANDBY_OPTS)).rejects.toThrow(
      /no verified staging/,
    );

    // The StatefulSet was still scaled back to 1 (standby never left down).
    const calls = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, , argv]: [string, string, string[]]) => argv.join(' '),
    );
    expect(calls.some((c) => c.includes('--replicas=1'))).toBe(true);
  });

  it('fails FAST with the scheduler message when the swap pod is Unschedulable, and scales back up', async () => {
    const schedMsg =
      '0/3 nodes are available: 1 node(s) had untolerated taint {dedicated: supabase}, ' +
      '2 node(s) had volume node affinity conflict.';
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      happyKubectl({
        swapPhase: 'Pending',
        swapConditions: [{ type: 'PodScheduled', reason: 'Unschedulable', message: schedMsg }],
      }),
    );

    // Terminal on the FIRST poll (a taint/affinity conflict never self-heals):
    // no budget wait, and the error names the exact scheduler conflict.
    await expect(reseedStandbyFromPrimary('10.0.0.2', '/k', STANDBY_OPTS)).rejects.toThrow(
      /could not be scheduled[\s\S]*untolerated taint \{dedicated: supabase\}/,
    );

    const calls = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, , argv]: [string, string, string[]]) => argv.join(' '),
    );
    // finally-scale-1: the standby is never left down.
    expect(calls.some((c) => c.includes('--replicas=1'))).toBe(true);
    // The one-shot swap pod is still cleaned up.
    expect(calls.some((c) => c.includes('delete pod vibecarbon-pgdata-swap'))).toBe(true);
  });

  it('classifies "Hot standby mode is disabled" as a CONFIG error (not timing)', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      async (ip: string, k: string, argv: string[]) => {
        if (argv.join(' ').includes('pg_is_in_recovery')) {
          // sshKubectl throws on psql non-zero exit; the FATAL detail rides
          // the error message.
          throw new Error(
            'Command failed: psql — FATAL: the database system is not accepting ' +
              'connections\nDETAIL: Hot standby mode is disabled.',
          );
        }
        return happyKubectl()(ip, k, argv);
      },
    );

    vi.useFakeTimers();
    try {
      const promise = reseedStandbyFromPrimary('10.0.0.2', '/k', STANDBY_OPTS);
      const assertion = expect(promise).rejects.toThrow(/hot_standby is OFF/);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it('fails loudly when the swapped standby never enters recovery', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      happyKubectl({ recovery: 'f' }),
    );

    // Drive the recovery poll's sleeps with fake timers (real budget ≈ 2 min).
    vi.useFakeTimers();
    try {
      const promise = reseedStandbyFromPrimary('10.0.0.2', '/k', STANDBY_OPTS);
      const assertion = expect(promise).rejects.toThrow(/never entered\s+recovery/i);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  }, 20000);
});

describe('isStandbyStreaming (k8s standby-side wal-receiver signal)', () => {
  it('returns true only when pg_stat_wal_receiver.status is "streaming"', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValue('streaming\n');
    await expect(isStandbyStreaming('10.0.0.9', '/k')).resolves.toBe(true);
    // Reads the STANDBY's own walreceiver view (works even if the primary is down).
    const argv = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls[0][2] as string[];
    expect(argv.join(' ')).toContain('SELECT status FROM pg_stat_wal_receiver');
  });

  it('returns false when no walreceiver row exists (not streaming)', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValue('');
    await expect(isStandbyStreaming('10.0.0.9', '/k')).resolves.toBe(false);
  });

  it('returns false (never throws) when the exec fails', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pod down'));
    await expect(isStandbyStreaming('10.0.0.9', '/k')).resolves.toBe(false);
  });
});

describe('isStandbyPromoted (k8s standby-side recovery signal)', () => {
  it('returns true only when pg_is_in_recovery() reports "f" (out of recovery)', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValue('f\n');
    await expect(isStandbyPromoted('10.0.0.2', '/k')).resolves.toBe(true);
    const argv = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls[0][2] as string[];
    expect(argv.join(' ')).toContain('SELECT pg_is_in_recovery()');
  });

  it('returns false while still in recovery ("t")', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValue('t');
    await expect(isStandbyPromoted('10.0.0.2', '/k')).resolves.toBe(false);
  });

  it('returns false (never throws) when the exec fails', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pod down'));
    await expect(isStandbyPromoted('10.0.0.2', '/k')).resolves.toBe(false);
  });
});

describe('reseedAndPromoteOrAbort — skip re-seed when standby already streaming', () => {
  const servers = { primary: { ip: '10.0.0.1' }, standby: { ip: '10.0.0.2' } };

  it('SKIPS the pg_basebackup re-seed (no scale-to-zero, no bash exec) and promotes', async () => {
    const calls: string[][] = [];
    // Stateful recovery signal: the standby is in recovery (streaming) until
    // pg_ctl promote lands. isStandbyPromoted (the FIRST guard) must therefore
    // see 't' and fall through to the streaming-skip + promote path.
    let promoted = false;
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      async (_ip: string, _k: string, argv: string[]) => {
        calls.push(argv);
        const cmd = argv.join(' ');
        if (cmd.includes('pg_stat_wal_receiver')) return 'streaming';
        if (cmd.includes('pg_ctl promote')) {
          promoted = true;
          return '';
        }
        if (cmd.includes('pg_is_in_recovery')) return promoted ? 'f' : 't';
        return '';
      },
    );
    const s = { start: vi.fn(), stop: vi.fn() };

    await reseedAndPromoteOrAbort(servers, '/k', s);

    // No re-seed happened: streaming parity means no basebackup, no quiesce.
    expect(calls.some((a) => a.includes('bash'))).toBe(false);
    expect(calls.some((a) => a.join(' ').includes('pg_basebackup'))).toBe(false);
    expect(calls.some((a) => a.join(' ').includes('--replicas=0'))).toBe(false);
    expect(ssh.sshRun).not.toHaveBeenCalled();
    // The primary-reachability probe is not even needed once streaming is seen.
    expect(calls.some((a) => a.join(' ').includes('pg_isready'))).toBe(false);
    // Promotion still ran and was confirmed.
    expect(calls.some((a) => a.join(' ').includes('pg_ctl promote'))).toBe(true);
  });

  it('short-circuits (no streaming probe, no reseed, no promote) when the standby is ALREADY promoted', async () => {
    // Convergent rerun after a mid-flow crash: the standby already exited
    // recovery. The alreadyPromoted guard is FIRST — without it a rerun would
    // pg_basebackup OVER a promoted database.
    const calls: string[][] = [];
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      async (_ip: string, _k: string, argv: string[]) => {
        calls.push(argv);
        if (argv.join(' ').includes('pg_is_in_recovery')) return 'f';
        return '';
      },
    );
    const s = { start: vi.fn(), stop: vi.fn() };

    await expect(reseedAndPromoteOrAbort(servers, '/k', s)).resolves.toEqual({
      alreadyPromoted: true,
    });
    // The guard runs BEFORE the streaming probe / reseed / promote.
    expect(calls.some((a) => a.join(' ').includes('pg_stat_wal_receiver'))).toBe(false);
    expect(calls.some((a) => a.join(' ').includes('pg_basebackup'))).toBe(false);
    expect(calls.some((a) => a.join(' ').includes('pg_ctl promote'))).toBe(false);
    expect(ssh.sshRun).not.toHaveBeenCalled();
  });
});

describe('stale-VolumeAttachment recovery on the post-swap rollout wait (d4 run 6)', () => {
  const STALE_EVENT = JSON.stringify({
    items: [
      {
        reason: 'FailedMount',
        message:
          'MountVolume.MountDevice failed for volume "pvc-x" : rpc error: formatting disk ' +
          'failed: exit status 1 cmd: mkfs.ext4 -F /dev/disk/by-id/x output: "The file ' +
          '/dev/disk/by-id/x does not exist and no size was specified."',
      },
    ],
  });
  const PVC_LIST = JSON.stringify({
    items: [{ metadata: { name: 'data-supabase-supabase-db-0' }, spec: { volumeName: 'pvc-x' } }],
  });
  const VA_LIST = JSON.stringify({
    items: [
      { metadata: { name: 'csi-stale-1' }, spec: { source: { persistentVolumeName: 'pvc-x' } } },
    ],
  });

  function kubectlWith(opts: { staleEvents: boolean; rolloutFailsTimes: number }) {
    let rolloutCalls = 0;
    let rolloutFailed = false;
    let vaDeleted = false;
    const deleted: string[] = [];
    const fn = vi.fn(async (ip: string, k: string, argv: string[]) => {
      const cmd = argv.join(' ');
      if (cmd.includes('rollout status')) {
        rolloutCalls += 1;
        if (rolloutCalls <= opts.rolloutFailsTimes) {
          rolloutFailed = true;
          throw new Error('error: timed out waiting for the condition');
        }
        return '';
      }
      if (cmd.includes('get events')) return opts.staleEvents ? STALE_EVENT : '{"items":[]}';
      if (cmd.includes('get pvc')) return PVC_LIST;
      // The stale attachment materializes only in the wedged window (after
      // the rollout timeout, before the repair) — the PREVENTION waits during
      // the swap see a clear listing, mirroring a run where detach settles.
      if (cmd.includes('get volumeattachment'))
        return rolloutFailed && !vaDeleted ? VA_LIST : '{"items":[]}';
      if (cmd.includes('delete volumeattachment')) {
        vaDeleted = true;
        deleted.push(argv[2]);
        return '';
      }
      return happyKubectl()(ip, k, argv);
    });
    return { fn, deleted, rolloutCalls: () => rolloutCalls };
  }

  it('repairs ONCE and re-waits when the timeout carries the mkfs-on-missing-device signature', async () => {
    const { fn, deleted, rolloutCalls } = kubectlWith({ staleEvents: true, rolloutFailsTimes: 1 });
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(fn);
    await expect(
      reseedStandbyFromPrimary('10.0.0.2', '/k', {
        standbySupabaseIp: '10.0.0.8',
        standbySupabasePrivateIp: '10.10.0.7',
      }),
    ).resolves.toBe('reseeded');
    expect(deleted).toEqual(['csi-stale-1']);
    expect(rolloutCalls()).toBe(2);
  });

  it('a timeout WITHOUT the signature rethrows untouched — no blind retry', async () => {
    const { fn, deleted } = kubectlWith({ staleEvents: false, rolloutFailsTimes: 99 });
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(fn);
    await expect(
      reseedStandbyFromPrimary('10.0.0.2', '/k', {
        standbySupabaseIp: '10.0.0.8',
        standbySupabasePrivateIp: '10.10.0.7',
      }),
    ).rejects.toThrow(/timed out waiting/);
    expect(deleted).toEqual([]);
  });

  it('repair is one-shot: a second timeout after the repair is the final verdict', async () => {
    const { fn, rolloutCalls } = kubectlWith({ staleEvents: true, rolloutFailsTimes: 99 });
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(fn);
    await expect(
      reseedStandbyFromPrimary('10.0.0.2', '/k', {
        standbySupabaseIp: '10.0.0.8',
        standbySupabasePrivateIp: '10.10.0.7',
      }),
    ).rejects.toThrow(/timed out waiting/);
    expect(rolloutCalls()).toBe(2);
  });

  it('the detach-settle wait runs BEFORE the helper-pod swap and before the scale-up', async () => {
    const sequence: string[] = [];
    const fn = vi.fn(async (ip: string, k: string, argv: string[]) => {
      const cmd = argv.join(' ');
      if (cmd.includes('get volumeattachment')) {
        sequence.push('detach-wait');
        return '{"items":[]}';
      }
      if (cmd.includes('get pvc')) return PVC_LIST;
      if (cmd.includes('apply') || cmd.includes('get pod vibecarbon-pgdata-swap'))
        sequence.push('swap');
      if (cmd.includes('--replicas=1')) sequence.push('scale-up');
      return happyKubectl()(ip, k, argv);
    });
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(fn);
    await reseedStandbyFromPrimary('10.0.0.2', '/k', {
      standbySupabaseIp: '10.0.0.8',
      standbySupabasePrivateIp: '10.10.0.7',
    });
    expect(sequence.indexOf('detach-wait')).toBeGreaterThan(-1);
    expect(sequence.indexOf('detach-wait')).toBeLessThan(sequence.indexOf('swap'));
    expect(sequence.lastIndexOf('detach-wait')).toBeLessThan(sequence.indexOf('scale-up'));
  });
});
