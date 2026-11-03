/**
 * Regression (findings #1 + #2 + the 2026-07-06 pod-kill + WG-relay fixes):
 * the k8s failover/restore standby re-seed must
 *   - read REPL_PASSWORD from the `vibecarbon-infra-secrets` k8s Secret (NOT a
 *     compose-style `.env.local`, which k8s nodes never have),
 *   - HARD-ERROR when the password is missing (abort — never silently skip),
 *   - target the standby the FRESH config names, and refuse when the clusters
 *     disagree with it (the configured primary reporting the standby intent),
 *   - reseed IN PLACE (Task A4): guard the running pod first, drop the source
 *     primary's .vc-discard, stage into $PGDATA/.vc-reseed while postgres
 *     runs, stop postgres once (`kill -INT 1`, the kubelet restarts the
 *     container in the same pod and db-guard.sh swaps the tree in), prove the
 *     swap through .vc-reseeded-from, wait for recovery. Zero attach
 *     transitions: no scale, no helper pod, no detach wait,
 *   - report `skipped` only when the stage printed RESEED_SKIPPED, and treat a
 *     busy stage as a terminal refusal,
 *   - dial the standby's LOCAL WireGuard relay (own database-node private IP :
 *     repl-gateway port 15433) for the probe, basebackup, AND primary_conninfo.
 *
 * ssh.js is mocked so the logic is exercised without a real cluster.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/ssh.js', async () => {
  // The real argv contract (tests/_shared/ssh-contract.ts).
  const { contractSshRun } = await import('../../_shared/ssh-contract.js');
  return {
    getPostgresPod: vi.fn(),
    sshKubectl: vi.fn(),
    sshRun: vi.fn(contractSshRun(() => undefined)),
    getSSHKeyPath: vi.fn(),
  };
});

const ssh = await import('../../../src/lib/ssh.js');
const { getReplPasswordFromSecret, reseedStandbyOrAbort, reseedStandbyFromPrimary } = await import(
  '../../../src/failover.js'
);
const {
  DB_STS_BOOT_TIMEOUT_S,
  ensureReplicationSlot,
  isStandbyStreaming,
  RESEED_BASEBACKUP_FLOOR_BYTES_PER_S,
  ReseedStageBusyError,
  ReseedStageTimeoutError,
} = await import('../../../src/lib/deploy/replication.js');

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

// The standby's node addresses: public (ssh target) and private (the local
// repl-gateway relay endpoint the basebackup dials).
const STANDBY_OPTS = { standbyDbIp: '10.0.0.8', standbyDbPrivateIp: '10.0.1.2' };
const PRIMARY_IP = '10.0.0.1';
const STANDBY_IP = '10.0.0.2';
const SYSID = '7412345678901234567';

/** The env config as .vibecarbon.json holds it now (read fresh by the reseed). */
const ENV = {
  ha: {
    enabled: true,
    primary: { masterIp: PRIMARY_IP },
    standby: { masterIp: STANDBY_IP, dbIp: '10.0.0.8', dbPrivateIp: '10.0.1.2' },
  },
};

const GUARD_POD = (o: { rc: number; cid: string }) =>
  JSON.stringify({
    metadata: { uid: 'u1' },
    spec: {
      containers: [
        {
          name: 'db',
          command: ['sh', '/usr/local/bin/db-guard.sh'],
          volumeMounts: [
            { name: 'w', mountPath: '/usr/local/bin/db-guard.sh', subPath: 'db-guard.sh' },
            { name: 'data', mountPath: '/var/lib/vibecarbon/role', subPath: 'vibecarbon-role' },
          ],
          env: [
            {
              name: 'VC_WALG_ROLE_INTENT',
              valueFrom: {
                configMapKeyRef: { name: 'vibecarbon-db-role', key: 'VC_WALG_ROLE_INTENT' },
              },
            },
          ],
        },
      ],
    },
    status: {
      containerStatuses: [
        { name: 'db', restartCount: o.rc, containerID: o.cid, ready: true, state: { running: {} } },
      ],
    },
  });

type InPlaceOverrides = {
  markerGrep?: string;
  intent?: string;
  primaryIntent?: string;
  stageOut?: string;
  stageError?: Error;
  reseededFrom?: string;
  recovery?: string;
  primaryDiscard?: string;
  dbSize?: string;
  stopError?: Error;
  disarmOut?: string;
  onCall?: (c: string) => void;
  onStage?: (o: { timeout?: number; input: string }) => void;
};

/**
 * sshKubectl answering an in-place reseed: the guard reads (pod uid u1,
 * restartCount 0, then 1 after the stop), the stage (RESEED_STAGED with the
 * attempt read from the stage script), .vc-reseeded-from, recovery and the
 * system identifier. Every call is recorded as `<ip> <argv> <stdin>`.
 */
function inPlaceSsh(o: InPlaceOverrides = {}) {
  let stopped = false;
  let attempt = '';
  return async (ip: string, _k: string, argv: string[], opts: { input?: string } = {}) => {
    const cmd = argv.join(' ');
    o.onCall?.(`${ip} ${cmd} ${opts?.input ?? ''}`);
    if (cmd.includes('get secret')) return b64('pw');
    if (cmd.includes('configmap vibecarbon-db-role')) {
      return ip === PRIMARY_IP ? (o.primaryIntent ?? 'primary') : (o.intent ?? 'standby');
    }
    if (cmd.includes('get pod db-0')) {
      return GUARD_POD(stopped ? { rc: 1, cid: 'c2' } : { rc: 0, cid: 'c1' });
    }
    if (cmd.includes('db-guard.sh') && cmd.includes('grep -c'))
      return o.markerGrep ?? '1\nin_recovery=t';
    if (cmd.includes('kill -INT 1')) {
      if (o.stopError) throw o.stopError;
      stopped = true;
      return '';
    }
    if (cmd.includes('RESEED_DISARMED')) {
      if (o.disarmOut === undefined) return 'RESEED_DISARMED';
      throw Object.assign(new Error('exit 1'), { stdout: o.disarmOut, status: 1 });
    }
    if (ip === PRIMARY_IP && cmd.includes('.vc-discard'))
      return o.primaryDiscard ?? 'VC_DISCARD_GONE';
    if (ip === PRIMARY_IP && cmd.includes('pg_database_size')) return o.dbSize ?? '1048576';
    if (cmd.includes('pg_isready')) return 'accepting connections';
    if (argv.includes('exec') && opts?.input?.includes('pg_basebackup')) {
      o.onStage?.({ timeout: (opts as { timeout?: number }).timeout, input: opts.input });
      attempt = /RESEED_STAGED (\S+)"/.exec(opts.input)?.[1] ?? '';
      if (o.stageError) throw o.stageError;
      return o.stageOut ?? `RESEED_STAGED ${attempt}`;
    }
    if (cmd.includes('.vc-reseeded-from')) return o.reseededFrom ?? attempt;
    if (cmd.includes('pg_is_in_recovery')) return o.recovery ?? 't';
    if (cmd.includes('pg_control_system')) return SYSID;
    return '';
  };
}

/** The real reseedStandbyFromPrimary over a mocked sshKubectl; resolves its result. */
async function runReseed(impl: ReturnType<typeof inPlaceSsh>, opts: Record<string, unknown> = {}) {
  (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(impl);
  return reseedStandbyFromPrimary(STANDBY_IP, '/k', {
    ...STANDBY_OPTS,
    primaryIp: PRIMARY_IP,
    envName: 'prod',
    readEnvConfig: () => ENV,
    sleep: async () => {},
    attachWatchPollMs: 60_000,
    ...opts,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (ssh.getPostgresPod as ReturnType<typeof vi.fn>).mockResolvedValue('db-0');
});

describe('getReplPasswordFromSecret', () => {
  it('decodes the base64 secret value from vibecarbon-infra-secrets', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValue(b64('s3cret-pw'));
    await expect(getReplPasswordFromSecret('10.0.0.2', '/k')).resolves.toBe('s3cret-pw');
    // Reads the Secret via jsonpath — the same source the db uses.
    const args = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(args).toEqual(
      expect.arrayContaining([
        'get',
        'secret',
        'vibecarbon-infra-secrets',
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

describe('reseedStandbyFromPrimary (in place)', () => {
  it('never scales, never applies a helper pod, never waits for a detach', async () => {
    const calls: string[] = [];
    await expect(runReseed(inPlaceSsh({ onCall: (c) => calls.push(c) }))).resolves.toBe('reseeded');
    const all = calls.join('\n');
    expect(all).not.toMatch(/scale|vibecarbon-pgdata-swap|volumeattachment|delete pod/);
    expect(all).toMatch(/kill -INT 1/);
  });

  it('guards BEFORE staging: an old pod refuses with the deploy hint, no pg_basebackup, no stop', async () => {
    const calls: string[] = [];
    await expect(
      runReseed(inPlaceSsh({ markerGrep: '0', onCall: (c) => calls.push(c) })),
    ).rejects.toThrow(/vibecarbon deploy prod/);
    expect(calls.some((c) => c.includes('pg_basebackup'))).toBe(false);
    expect(calls.some((c) => c.includes('kill -INT'))).toBe(false);
    // Nothing touched the primary either.
    expect(calls.some((c) => c.startsWith(PRIMARY_IP))).toBe(false);
  });

  it('a swap that did not happen fails loud, never reports reseeded', async () => {
    await expect(runReseed(inPlaceSsh({ reseededFrom: 'other' }))).rejects.toThrow(
      /swap did not run/,
    );
    await expect(runReseed(inPlaceSsh({ reseededFrom: '' }))).rejects.toThrow(/swap did not run/);
  });

  it('still reports skipped when the stage never reached the primary (no restart)', async () => {
    const calls: string[] = [];
    await expect(
      runReseed(inPlaceSsh({ stageOut: 'RESEED_SKIPPED', onCall: (c) => calls.push(c) })),
    ).resolves.toBe('skipped');
    expect(calls.some((c) => c.includes('kill -INT'))).toBe(false);
  });

  it('records the seeded system identifier exactly as before', async () => {
    const onSeeded = vi.fn();
    await runReseed(inPlaceSsh(), { onSeeded });
    expect(onSeeded).toHaveBeenCalledWith(SYSID);
  });

  it('runs in order: guard, primary discard, stage, stop, swap proof, recovery, standby discard', async () => {
    const calls: string[] = [];
    await runReseed(inPlaceSsh({ onCall: (c) => calls.push(c) }));
    const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
    const guard = at(/grep -c.*db-guard\.sh/);
    const primaryDiscard = at(new RegExp(`^${PRIMARY_IP} .*\\.vc-discard`));
    const stage = at(/pg_basebackup/);
    const stop = at(/kill -INT 1/);
    const proof = at(/\.vc-reseeded-from/);
    const recovery = calls.findIndex((c, i) => i > proof && /pg_is_in_recovery/.test(c));
    const standbyDiscard = at(
      new RegExp(`^${STANDBY_IP} .*rm -rf /var/lib/postgresql/data/\\.vc-discard`),
    );
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(primaryDiscard).toBeGreaterThan(guard);
    expect(stage).toBeGreaterThan(primaryDiscard);
    expect(stop).toBeGreaterThan(stage);
    expect(proof).toBeGreaterThan(stop);
    expect(recovery).toBeGreaterThan(proof);
    expect(standbyDiscard).toBeGreaterThan(recovery);
  });

  it('stages in the running db over stdin: in-place mode, the relay, the password never in argv', async () => {
    const calls: Array<{ argv: string[]; input?: string }> = [];
    const cluster = inPlaceSsh();
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(async (ip, k, argv, opts) => {
      calls.push({ argv, input: opts?.input });
      return cluster(ip, k, argv, opts);
    });
    await reseedStandbyFromPrimary(STANDBY_IP, '/k', {
      ...STANDBY_OPTS,
      primaryIp: PRIMARY_IP,
      envName: 'prod',
      readEnvConfig: () => ENV,
      sleep: async () => {},
    });
    const stage = calls.find((c) => c.input?.includes('pg_basebackup'));
    expect(stage?.argv).toEqual(['-n', 'vibecarbon', 'exec', '-i', 'db-0', '-c', 'db', '--', 'sh']);
    const script = stage?.input ?? '';
    expect(script).toContain('/var/lib/postgresql/data/.vc-reseed');
    expect(script).not.toContain('.reseed_staging');
    expect(script).toMatch(/RESEED_STAGED \S+/);
    expect(script).toContain('-h 10.0.1.2 -p 15433');
    expect(script).toContain(
      "primary_conninfo = 'host=10.0.1.2 port=15433 user=replicator password=pw " +
        "sslmode=disable application_name=standby'",
    );
    expect(script).not.toMatch(/-S \S/);
    expect(script).toContain("PGPASSWORD='pw'");
    // One reachability probe from inside the standby db, as the single-shot
    // pre-check it replaces: an unreachable primary skips at once.
    expect(script).toContain('for probe_i in $(seq 1 1); do');
    expect(calls.every((c) => !c.argv.join(' ').includes('pw'))).toBe(true);
  });

  it('a busy stage is a terminal refusal: one stage, no stop, never retried', async () => {
    const calls: string[] = [];
    const busy = Object.assign(new Error('Command failed: ssh ... RESEED_REFUSED busy'), {
      stdout: 'RESEED_REFUSED busy\n',
      status: 1,
    });
    const err = await runReseed(
      inPlaceSsh({ stageError: busy, onCall: (c) => calls.push(c) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ReseedStageBusyError);
    expect(err.message).toMatch(/earlier reseed stage is still running/);
    expect(err.message).toMatch(/Wait for it to finish, then rerun/);
    expect(calls.filter((c) => c.includes('pg_basebackup'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('kill -INT'))).toBe(false);
  });

  it('the source primary drops its .vc-discard before the stage; one it cannot drop refuses the stage', async () => {
    const calls: string[] = [];
    await runReseed(inPlaceSsh({ onCall: (c) => calls.push(c) }));
    const drop = calls.find((c) => c.startsWith(`${PRIMARY_IP} `) && c.includes('.vc-discard'));
    expect(drop).toMatch(
      /exec db-0 -c db -- sh -c rm -rf \/var\/lib\/postgresql\/data\/\.vc-discard/,
    );

    const refused: string[] = [];
    await expect(
      runReseed(inPlaceSsh({ primaryDiscard: 'VC_DISCARD_LEFT', onCall: (c) => refused.push(c) })),
    ).rejects.toThrow(/\.vc-discard/);
    expect(refused.some((c) => c.includes('pg_basebackup'))).toBe(false);
    expect(refused.some((c) => c.includes('kill -INT'))).toBe(false);
  });

  it('targets the configured standby from FRESH config: a mismatch refuses before any remote call', async () => {
    for (const env of [
      { ha: { ...ENV.ha, standby: { ...ENV.ha.standby, masterIp: '10.0.0.77' } } },
      { ha: { ...ENV.ha, primary: { masterIp: '10.0.0.66' } } },
      undefined,
    ]) {
      const calls: string[] = [];
      await expect(
        runReseed(inPlaceSsh({ onCall: (c) => calls.push(c) }), { readEnvConfig: () => env }),
      ).rejects.toThrow(/reseed refused/);
      expect(calls).toEqual([]);
    }
    await expect(runReseed(inPlaceSsh(), { envName: undefined })).rejects.toThrow(/envName/);
  });

  it('refuses when the clusters disagree with the config: the configured primary reports the standby intent', async () => {
    const calls: string[] = [];
    await expect(
      runReseed(inPlaceSsh({ primaryIntent: 'standby', onCall: (c) => calls.push(c) })),
    ).rejects.toThrow(/configured primary.*standby/);
    expect(calls.some((c) => c.includes('pg_basebackup'))).toBe(false);
    expect(calls.some((c) => c.includes('.vc-discard'))).toBe(false);
  });

  it('refuses when the configured standby reports a non-standby intent (the guard), before any stage', async () => {
    const calls: string[] = [];
    await expect(
      runReseed(inPlaceSsh({ intent: 'primary', onCall: (c) => calls.push(c) })),
    ).rejects.toThrow(/role intent is primary/);
    expect(calls.some((c) => c.includes('pg_basebackup'))).toBe(false);
  });

  it('bounds the stage by the primary database size: the floor for a small db', async () => {
    const stages: Array<{ timeout?: number; input: string }> = [];
    await runReseed(inPlaceSsh({ dbSize: '1048576', onStage: (x) => stages.push(x) }));
    expect(stages).toHaveLength(1);
    expect(stages[0].timeout).toBe(2 * DB_STS_BOOT_TIMEOUT_S * 1000);
    expect(stages[0].input).toContain(`timeout -s KILL ${DB_STS_BOOT_TIMEOUT_S} pg_basebackup`);
  });

  it('a large db scales both bounds, the remote deadline strictly below the client one', async () => {
    const size = 50 * 1024 ** 3;
    const remoteS = Math.ceil(size / RESEED_BASEBACKUP_FLOOR_BYTES_PER_S);
    expect(remoteS).toBeGreaterThan(DB_STS_BOOT_TIMEOUT_S);
    const stages: Array<{ timeout?: number; input: string }> = [];
    await runReseed(inPlaceSsh({ dbSize: String(size), onStage: (x) => stages.push(x) }));
    expect(stages[0].input).toContain(`timeout -s KILL ${remoteS} pg_basebackup`);
    expect(stages[0].timeout).toBe(2 * remoteS * 1000);
    expect(remoteS * 1000).toBeLessThan(stages[0].timeout ?? 0);
  });

  it('a primary whose size cannot be read refuses before the stage', async () => {
    const calls: string[] = [];
    await expect(
      runReseed(inPlaceSsh({ dbSize: 'ERROR: x', onCall: (c) => calls.push(c) })),
    ).rejects.toThrow(/database size/);
    expect(calls.some((c) => c.includes('pg_basebackup'))).toBe(false);
  });

  it('a stage past its remote deadline is a clean timeout naming the size and bounds, with no stop', async () => {
    const calls: string[] = [];
    const timedOut = Object.assign(new Error('Command failed: ssh ... RESEED_TIMEOUT 600'), {
      stdout: 'RESEED_TIMEOUT 600\n',
      status: 1,
    });
    const err = await runReseed(
      inPlaceSsh({ stageError: timedOut, dbSize: '1048576', onCall: (c) => calls.push(c) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ReseedStageTimeoutError);
    expect(err.message).toMatch(/did not finish within 600s/);
    expect(err.message).toMatch(/1\.0 MiB/);
    expect(err.message).toMatch(/client bound 1200s/);
    expect(err.message).toMatch(/nothing was staged/i);
    expect(calls.filter((c) => c.includes('pg_basebackup'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('kill -INT'))).toBe(false);
  });

  it('a stop the container refuses disarms the staged tree under the lock, and says so', async () => {
    const calls: string[] = [];
    const refused = Object.assign(new Error('exit 3'), {
      stdout: 'RESEED_STOP_REFUSED postgres is not in recovery (pg_is_in_recovery: f)\n',
      status: 3,
    });
    const err = await runReseed(
      inPlaceSsh({ stopError: refused, onCall: (c) => calls.push(c) }),
    ).catch((e) => e);
    expect(err.message).toMatch(/nothing was stopped/);
    expect(err.message).toMatch(/staged tree was disarmed/);
    const stage = calls.findIndex((c) => c.includes('pg_basebackup'));
    const disarm = calls.findIndex((c) => c.includes('RESEED_DISARMED'));
    expect(disarm).toBeGreaterThan(stage);
    const attempt = /RESEED_STAGED (\S+)"/.exec(calls[stage])?.[1];
    expect(calls[disarm]).toContain('flock -n 9');
    expect(calls[disarm]).toContain(`" != ${attempt} ]`);
  });

  it('a disarm that cannot run says the staged tree is still armed and swaps on the next restart', async () => {
    const refused = Object.assign(new Error('exit 3'), {
      stdout: 'RESEED_STOP_REFUSED could not confirm the db is in recovery (psql did not answer)\n',
      status: 3,
    });
    await expect(
      runReseed(inPlaceSsh({ stopError: refused, disarmOut: 'RESEED_DISARM_REFUSED busy\n' })),
    ).rejects.toThrow(/still armed[\s\S]*next restart/);
  });

  it('HARD-ERRORS (does not silently skip) when the password is missing', async () => {
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockResolvedValue('');
    await expect(
      reseedStandbyFromPrimary(STANDBY_IP, '/k', {
        ...STANDBY_OPTS,
        primaryIp: PRIMARY_IP,
        envName: 'prod',
        readEnvConfig: () => ENV,
      }),
    ).rejects.toThrow(/REPL_PASSWORD not found/);
  });

  it('HARD-ERRORS when the standby database node IP is unknown', async () => {
    await expect(runReseed(inPlaceSsh(), { standbyDbIp: undefined })).rejects.toThrow(
      /standby database node IP is unknown/,
    );
  });

  it('HARD-ERRORS when the private IP is not persisted (no 10.0.1.2 fallback)', async () => {
    await expect(runReseed(inPlaceSsh(), { standbyDbPrivateIp: undefined })).rejects.toThrow(
      /standbyDbPrivateIp is required/,
    );
  });

  it('dials the PERSISTED relay host (threaded, never assumed)', async () => {
    const calls: string[] = [];
    await expect(
      runReseed(inPlaceSsh({ onCall: (c) => calls.push(c) }), { standbyDbPrivateIp: '10.10.0.7' }),
    ).resolves.toBe('reseeded');
    expect(calls.find((c) => c.includes('pg_basebackup'))).toContain('-h 10.10.0.7 -p 15433');
  });

  it('a reseed whose system identifier is unreadable fails rather than recording nothing', async () => {
    const base = inPlaceSsh();
    const onSeeded = vi.fn();
    await expect(
      runReseed(
        async (ip, k, argv, opts) =>
          argv.join(' ').includes('pg_control_system') ? 'ERROR: x' : base(ip, k, argv, opts),
        { onSeeded },
      ),
    ).rejects.toThrow(/system identifier could not be read/);
    expect(onSeeded).not.toHaveBeenCalled();
  });

  it('classifies "Hot standby mode is disabled" as a CONFIG error (not timing)', async () => {
    const base = inPlaceSsh();
    let t = 0;
    await expect(
      runReseed(
        async (ip, k, argv, opts) => {
          const cmd = argv.join(' ');
          if (cmd.includes('pg_is_in_recovery') && !cmd.includes('db-guard.sh')) {
            throw new Error(
              'Command failed: psql — FATAL: the database system is not accepting ' +
                'connections\nDETAIL: Hot standby mode is disabled.',
            );
          }
          return base(ip, k, argv, opts);
        },
        { now: () => (t += 60_000) },
      ),
    ).rejects.toThrow(/hot_standby is OFF/);
  });

  it('fails loudly when the swapped standby never enters recovery', async () => {
    let t = 0;
    const base = inPlaceSsh();
    await expect(
      runReseed(
        async (ip, k, argv, opts) => {
          const cmd = argv.join(' ');
          if (cmd.includes('pg_is_in_recovery') && !cmd.includes('db-guard.sh')) return 'f';
          return base(ip, k, argv, opts);
        },
        { now: () => (t += 60_000) },
      ),
    ).rejects.toThrow(/never entered\s+recovery/i);
  });
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

describe('reseedStandbyOrAbort: skip re-seed when standby already streaming', () => {
  const servers = { primary: { ip: '10.0.0.1' }, standby: { ip: '10.0.0.2' } };

  it('SKIPS the pg_basebackup re-seed (no scale-to-zero, no bash exec) and never promotes', async () => {
    const calls: string[][] = [];
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(
      async (_ip: string, _k: string, argv: string[]) => {
        calls.push(argv);
        if (argv.join(' ').includes('pg_stat_wal_receiver')) return 'streaming';
        return '';
      },
    );
    const s = { start: vi.fn(), stop: vi.fn() };

    await reseedStandbyOrAbort(servers, '/k', s);

    // No re-seed happened: streaming parity means no basebackup, no quiesce.
    expect(calls.some((a) => a.includes('bash'))).toBe(false);
    expect(calls.some((a) => a.join(' ').includes('pg_basebackup'))).toBe(false);
    expect(calls.some((a) => a.join(' ').includes('--replicas=0'))).toBe(false);
    expect(ssh.sshRun).not.toHaveBeenCalled();
    // The primary-reachability probe is not even needed once streaming is seen.
    expect(calls.some((a) => a.join(' ').includes('pg_isready'))).toBe(false);
    // Promotion is failoverHA's step, behind the replica proof and the journal.
    expect(calls.some((a) => a.join(' ').includes('pg_ctl promote'))).toBe(false);
  });
});

describe('reseedStandbyOrAbort: a busy stage aborts before promotion, naming the rerun', () => {
  it('says the earlier stage still runs and names `vibecarbon failover <env>` to rerun once it finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-reseed-busy-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ projectName: 'p', environments: { prod: ENV } }),
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const busy = Object.assign(new Error('Command failed'), {
      stdout: 'RESEED_REFUSED busy\n',
      status: 1,
    });
    const cluster = inPlaceSsh({ stageError: busy });
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockImplementation(async (ip, k, argv, opts) =>
      argv.join(' ').includes('pg_stat_wal_receiver') ? '' : cluster(ip, k, argv, opts),
    );
    const servers = {
      primary: { ip: PRIMARY_IP },
      standby: { ip: STANDBY_IP, dbIp: '10.0.0.8', dbPrivateIp: '10.0.1.2' },
    };
    try {
      const err = await reseedStandbyOrAbort(
        servers,
        '/k',
        { start: vi.fn(), stop: vi.fn() },
        { envName: 'prod' },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/^Failover aborted before promotion: /);
      expect(err.message).toMatch(/earlier reseed stage is still running/);
      expect(err.message).toContain('rerun `vibecarbon failover prod`');
      expect(err.message).not.toMatch(/redeploy/);
    } finally {
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
