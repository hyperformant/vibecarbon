import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// --- Mock the exec + environment seams so setupReplication runs offline. ---
// The standby's db pod as the in-place reseed reads it (Task A5): the
// db-guard wrapper command and mount, the role mount, the intent env, a
// running db container. uid u1 throughout (restarted in place, never
// recreated), restartCount 0 then 1 once the stop has been sent.
function guardPod(o: { rc: number; cid: string; uid?: string; ready?: boolean }) {
  return JSON.stringify(
    {
      metadata: { name: 'db-0', uid: o.uid ?? 'u1' },
      spec: {
        containers: [
          {
            name: 'db',
            image: 'postgres:17',
            command: ['sh', '/usr/local/bin/db-guard.sh'],
            volumeMounts: [
              { name: 'w', mountPath: '/usr/local/bin/db-guard.sh', subPath: 'db-guard.sh' },
              {
                name: 'postgres-volume',
                mountPath: '/var/lib/vibecarbon/role',
                subPath: 'vibecarbon-role',
              },
              {
                name: 'postgres-volume',
                mountPath: '/var/lib/postgresql/data',
                subPath: 'postgres-data',
              },
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
        phase: 'Running',
        containerStatuses: [
          {
            name: 'db',
            restartCount: o.rc,
            containerID: o.cid,
            ready: o.ready ?? true,
            state: { running: {} },
          },
        ],
      },
    },
    null,
    2,
  );
}

const STS_JSON = JSON.stringify({
  spec: {
    template: {
      spec: {
        containers: [
          {
            name: 'db',
            ports: [
              {
                name: 'postgres',
                containerPort: 5432,
                protocol: 'TCP',
                hostPort: 5433,
                hostIP: '127.0.0.1',
              },
            ],
          },
        ],
      },
    },
  },
});

/**
 * One ssh argv as a matchable line: the reseed's remote kubectl string is
 * shEscaped token by token (standbyKubectlCommand), so its quotes are dropped
 * here; the raw argv keeps them for the tests that pin the quoting.
 */
const flat = (argv: string[]) =>
  (Array.isArray(argv) ? argv.join(' ') : String(argv)).replace(/'\\''/g, "'").replace(/'/g, '');

/** The source primary's database: one lineage, promoted once (timeline 2). */
const SOURCE_SYSID = '7412345678901234567';
const SOURCE_ROW = `1048576|${SOURCE_SYSID}|00000002`;
/** What the guard exec prints on the standby (DB_GUARD_MARKER_GREP). */
const guardOut = (o: { recovery: string; slots: number; ident: string }) =>
  `1\nin_recovery=${o.recovery}\nslots=${o.slots}\nident=${o.ident}`;
/** A fresh standby cluster: its own initdb (another system identifier), no slots. */
const FRESH = guardOut({ recovery: 'f', slots: 0, ident: '7000000000000000001|00000001' });
/** A retired old primary: the same database on an older timeline, with its slots. */
const RETIRED = guardOut({ recovery: 'f', slots: 2, ident: `${SOURCE_SYSID}|00000001` });
/** A standby promoted outside vibecarbon: the same database on a NEWER timeline. */
const PROMOTED_OUTSIDE = guardOut({ recovery: 'f', slots: 0, ident: `${SOURCE_SYSID}|00000003` });

type InPlaceOverrides = {
  /** The source primary's size and lineage row (`<bytes>|<sysid>|<timeline>`). */
  sourceRow?: string;
  /** The guard's exec output: the marker count, in_recovery, slots, ident. */
  markerGrep?: string;
  /** The standby cluster's intent ConfigMap. */
  intent?: string;
  /** The primary cluster's intent ConfigMap. */
  primaryIntent?: string;
  /** The stage's stdout; default RESEED_STAGED <the attempt it was given>. */
  stageOut?: string;
  stageError?: Error;
  /** pg_is_in_recovery on the standby after the swap. */
  recovery?: string;
  /** The stop recreates the pod (new uid) instead of restarting it in place. */
  recreateAs?: string;
};

/**
 * The happy in-place exec: the streaming probe reads "not streaming" until
 * the stop (`kill -INT 1`) has been sent, the standby pod restarts in place
 * (uid u1, restartCount 0 → 1, a new containerID), db-guard.sh records the
 * staged attempt in .vc-reseeded-from, and the standby is in recovery. The
 * guard's default reading is a fresh standby: its own primary until the swap
 * (in_recovery=f), the state every cold deploy seeds from.
 */
function inPlaceExec(o: InPlaceOverrides = {}) {
  let reseeded = false;
  let attempt = '';
  return async (argv: string[], opts: { input?: string } = {}) => {
    const cmd = flat(argv);
    const target = Array.isArray(argv) ? (argv.find((a) => a.startsWith('root@')) ?? '') : '';
    if (cmd.includes('kill -INT 1')) {
      reseeded = true;
      return '';
    }
    if (cmd.includes('configmap vibecarbon-db-role')) {
      return target === 'root@1.1.1.1' ? (o.primaryIntent ?? 'primary') : (o.intent ?? 'standby');
    }
    if (cmd.includes('vc-reseed-protocol') && cmd.includes('grep -c')) {
      return o.markerGrep ?? FRESH;
    }
    if (cmd.includes('get pod db-0') && cmd.includes('-o json')) {
      if (!reseeded) return guardPod({ rc: 0, cid: 'c1' });
      if (o.recreateAs) return guardPod({ rc: 0, cid: 'c9', uid: o.recreateAs });
      return guardPod({ rc: 1, cid: 'c2' });
    }
    if (cmd.includes('.vc-discard') && cmd.includes('VC_DISCARD_GONE')) return 'VC_DISCARD_GONE';
    if (cmd.includes('pg_database_size')) return o.sourceRow ?? SOURCE_ROW;
    if (opts?.input?.includes('.vc-reseed-ready')) {
      attempt = /RESEED_STAGED (\S+)"/.exec(opts.input)?.[1] ?? '';
      if (o.stageError) throw o.stageError;
      return o.stageOut ?? `RESEED_STAGED ${attempt}`;
    }
    if (cmd.includes('.vc-reseeded-from')) return reseeded ? attempt : '';
    if (cmd.includes('RESEED_DISARMED')) return 'RESEED_DISARMED';
    // The primary's db StatefulSet, rendered with its replication hostPort.
    if (cmd.includes('get statefulset db') && cmd.includes('-o json')) return STS_JSON;
    if (cmd.includes('pg_is_in_recovery')) return o.recovery ?? 't';
    if (cmd.includes('pg_stat_replication')) return reseeded ? 'streaming' : '';
    // The verified-streaming result records the standby's system identifier.
    if (cmd.includes('pg_control_system')) return '7412345678901234567';
    return '';
  };
}
const happyExec = inPlaceExec;

/** Drive a setupReplication(...) call under fake timers (the streaming probe
 * and verifyStreaming's own retry loop both sleep via setTimeout) and resolve
 * to its settlement without racing the fake-timer flush. */
async function runWithFakeTimers<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = work();
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    vi.useRealTimers();
  }
}

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCommandAsync: vi.fn(happyExec()),
  };
});

vi.mock('../../../src/lib/host-keys.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    knownHostsPathForKey: () => '/tmp/kh',
    seedKnownHosts: vi.fn(async () => {}),
  };
});

vi.mock('../../../src/lib/deploy/utils.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, readReplPassword: () => 'testreplpass' };
});

// Keep the WG constants/builders real; only stub the SSH-driven tunnel bring-up.
vi.mock('../../../src/lib/deploy/wireguard.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    exchangeAndBringUpTunnel: vi
      .fn()
      .mockResolvedValue({ primaryPubKey: 'AAA=', standbyPubKey: 'BBB=' }),
  };
});

const { runCommandAsync } = await import('../../../src/lib/command.js');
const { exchangeAndBringUpTunnel } = await import('../../../src/lib/deploy/wireguard.js');
const {
  setupReplication,
  standbyKubectlCommand,
  buildReplGatewaySocatArgs,
  renderReplGatewayManifest,
  reestablishReplicationTransport,
} = await import('../../../src/lib/deploy/k8s/ha/index.js');

const readFileSync = (await import('node:fs')).readFileSync;
const path = await import('node:path');
const url = await import('node:url');
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const MANIFEST = readFileSync(
  path.join(HERE, '../../../carbon/k8s/base/repl-gateway/repl-gateway.yaml'),
  'utf-8',
);

describe('buildReplGatewaySocatArgs', () => {
  it('primary binds the tunnel IP and relays to local postgres hostPort', () => {
    const { relayListen, relayTarget } = buildReplGatewaySocatArgs('primary', '10.0.1.2');
    expect(relayListen).toBe('TCP-LISTEN:15433,bind=10.99.0.1,fork,reuseaddr');
    expect(relayTarget).toBe('TCP:127.0.0.1:5433');
  });
  it('standby binds the local node private IP and relays into the tunnel', () => {
    const { relayListen, relayTarget } = buildReplGatewaySocatArgs('standby', '10.0.1.2');
    expect(relayListen).toBe('TCP-LISTEN:15433,bind=10.0.1.2,fork,reuseaddr');
    expect(relayTarget).toBe('TCP:10.99.0.1:15433');
  });
  it('rejects an unknown role', () => {
    expect(() => buildReplGatewaySocatArgs('sideways' as 'primary', '10.0.1.2')).toThrow(/role/);
  });
});

describe('renderReplGatewayManifest', () => {
  it('resolves every placeholder (nothing left for runtime)', () => {
    const out = renderReplGatewayManifest({
      template: MANIFEST,
      role: 'standby',
      nodePrivateIp: '10.0.1.2',
    });
    expect(out).not.toContain('__RELAY_LISTEN__');
    expect(out).not.toContain('__RELAY_TARGET__');
    expect(out).not.toContain('__DB_PRIVATE_IP__');
    expect(out).toContain('bind=10.0.1.2');
    expect(out).toContain('cidr: 10.0.1.2/32');
    expect(out).toContain('allow-db-repl-gateway-egress');
  });
});

describe('reestablishReplicationTransport — post-resize belt (item I-1)', () => {
  const opts = {
    primaryIp: '1.1.1.1',
    standbyIp: '2.2.2.2',
    primaryDbIp: '167.233.150.173',
    standbyDbIp: '157.180.115.19',
    primaryDbPrivateIp: '10.0.1.2',
    standbyDbPrivateIp: '10.0.1.2',
    sshKeyPath: '/tmp/key',
  };

  it('recreates wg0 then re-applies + restarts the gateway on both clusters', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(happyExec());
    vi.mocked(exchangeAndBringUpTunnel).mockClear();

    await reestablishReplicationTransport(opts);

    // Tunnel recreated once, with the database nodes' PUBLIC IPs (self-heals the unit too).
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledTimes(1);
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledWith({
      primaryIp: '167.233.150.173',
      standbyIp: '157.180.115.19',
      sshKeyPath: '/tmp/key',
    });

    const calls = vi.mocked(runCommandAsync).mock.calls;
    const joined = calls.map(([argv]) => (argv as string[]).join(' '));

    // Apply, then restart the Deployment on each cluster's MASTER: the
    // controller replaces the crash-looped pod with one that binds cleanly now
    // wg0 exists. The only pod delete is the legacy bare Pod's, by exact name,
    // inside the apply (repl-gateway-kind.test.ts pins it).
    for (const master of ['1.1.1.1', '2.2.2.2']) {
      const apply = joined.findIndex((c) => c.includes(master) && c.includes('apply -f -'));
      const restart = joined.findIndex(
        (c) => c.includes(master) && c.includes('rollout restart deployment/repl-gateway'),
      );
      expect(apply).toBeGreaterThanOrEqual(0);
      expect(restart).toBeGreaterThan(apply);
    }
    expect(
      joined
        .filter((c) => c.includes('delete pod repl-gateway'))
        .every((c) => c.includes('--ignore-not-found >/dev/null && kubectl apply -f -')),
    ).toBe(true);

    // The re-applied manifests carry the per-role relay direction.
    const applyInputs = calls
      .filter(([argv]) => (argv as string[]).join(' ').includes('apply -f -'))
      .map(([, o]) => (o as { input?: string }).input ?? '');
    expect(applyInputs.some((i) => i.includes('TCP:127.0.0.1:5433'))).toBe(true); // primary
    expect(applyInputs.some((i) => i.includes('TCP:10.99.0.1:15433'))).toBe(true); // standby

    // TRANSPORT ONLY — never re-seeds (no basebackup, no scale-to-zero dance).
    const everything = joined.join('\n');
    expect(everything).not.toContain('pg_basebackup');
    expect(everything).not.toContain('--replicas=0');
    expect(everything).not.toContain('scale statefulset');
  });

  it('requires primaryIp, standbyIp, and sshKeyPath', async () => {
    await expect(reestablishReplicationTransport({ ...opts, sshKeyPath: '' })).rejects.toThrow(
      /requires/,
    );
  });
});

describe('setupReplication — WireGuard repl-gateway transport', () => {
  const opts = {
    primaryIp: '1.1.1.1',
    standbyIp: '2.2.2.2',
    primaryDbIp: '167.233.150.173',
    standbyDbIp: '157.180.115.19',
    primaryDbPrivateIp: '10.0.1.2',
    standbyDbPrivateIp: '10.0.1.2',
    sshKeyPath: '/tmp/key',
  };

  it('applies the gateway to both clusters, brings up the tunnel, ships the netpol, no TLS', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(happyExec());
    vi.mocked(exchangeAndBringUpTunnel).mockClear();

    const res = await runWithFakeTimers(() => setupReplication(opts));
    expect(res.streaming).toBe(true);

    const calls = vi.mocked(runCommandAsync).mock.calls;
    // Gateway applies only: the reseed applies nothing.
    const applyCalls = calls.filter(([argv]) =>
      (argv as string[]).join(' ').includes('apply -f -'),
    );
    // One gateway apply per cluster.
    expect(applyCalls.length).toBe(2);

    const applyInputs = applyCalls.map(([, o]) => (o as { input?: string }).input ?? '');
    // Both applies carry the gateway Deployment + the additive egress NetworkPolicy.
    for (const input of applyInputs) {
      expect(input).toContain('kind: Deployment');
      expect(input).toContain('repl-gateway');
      expect(input).toContain('allow-db-repl-gateway-egress');
      expect(input).toContain('cidr: 10.0.1.2/32');
      expect(input).not.toContain('__RELAY_');
    }
    // Primary relays to local postgres; standby relays into the tunnel.
    expect(applyInputs.some((i) => i.includes('TCP:127.0.0.1:5433'))).toBe(true);
    expect(applyInputs.some((i) => i.includes('TCP:10.99.0.1:15433'))).toBe(true);

    // Tunnel bring-up called once, with the database nodes' PUBLIC IPs as endpoints.
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledTimes(1);
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledWith({
      primaryIp: '167.233.150.173',
      standbyIp: '157.180.115.19',
      sshKeyPath: '/tmp/key',
    });

    // The db hostPort the primary gateway relays to is READ, never patched:
    // it is rendered into the StatefulSet before its first apply, and a patch
    // would recreate the freshly attached primary db (DO e2e 2026-11-01).
    const joined = calls.map(([argv]) => (argv as string[]).join(' '));
    expect(joined.some((c) => c.includes('get statefulset db'))).toBe(true);
    expect(joined.some((c) => c.includes('patch statefulset db'))).toBe(false);

    // No TLS-era plumbing anywhere in the SSH stream.
    const everything = calls
      .map(
        ([argv, o]) => `${(argv as string[]).join(' ')} ${(o as { input?: string })?.input ?? ''}`,
      )
      .join('\n');
    expect(everything).not.toContain('repl-tls');
    expect(everything).not.toContain('vibecarbon-repl-tls');
    expect(everything).not.toMatch(/ALTER SYSTEM SET ssl/i);

    // The standby streams via its LOCAL gateway (private IP : gateway port), not
    // the primary's public IP.
    expect(everything).toContain('host=10.0.1.2 port=15433');
    expect(everything).not.toContain('port=5433 user=replicator password');
  }, 20000);

  it('pg_hba admits WG subnet + pod CIDR in a PGDATA-durable file (post-relay NAT source)', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(happyExec());
    await runWithFakeTimers(() => setupReplication(opts));

    // The hba setup script is piped into the primary db pod over stdin.
    const hbaCall = vi
      .mocked(runCommandAsync)
      .mock.calls.find(([, o]) => (o as { input?: string })?.input?.includes('SHOW hba_file'));
    expect(hbaCall).toBeTruthy();
    const script = (hbaCall?.[1] as { input?: string })?.input ?? '';

    // BOTH source CIDRs: the WG tunnel /30 AND the k3s pod CIDR — the relayed
    // connection is NAT'd into the pod network, so postgres sees the node's
    // cni0 gateway (live RCA: 10.42.2.1) as the source.
    expect(script).toContain('host replication replicator 10.99.0.0/30 scram-sha-256');
    expect(script).toContain('host replication replicator 10.42.0.0/16 scram-sha-256');
    expect(script).not.toContain('hostssl');

    // Durable location: the rules go into the hba file postgres actually
    // reads (SHOW hba_file), which on our image is PGDATA/pg_hba.conf on the
    // PVC; the script refuses any other location rather than appending to a
    // file a restart would revert. Appends are idempotent; the step-3 restart
    // loads them.
    expect(script).toContain('SHOW hba_file');
    expect(script).toContain('/var/lib/postgresql/data/*) ;;');
    expect(script).toMatch(/not under PGDATA[^\n]*exit 1/);
    expect(script).not.toContain('ALTER SYSTEM SET hba_file');
    expect(script).toContain('grep -qxF');

    // It targets the PRIMARY cluster (1.1.1.1), before the step-3 pod restart.
    const argv = ((hbaCall as unknown[])[0] as string[]).join(' ');
    expect(argv).toContain('1.1.1.1');
  }, 20000);

  it('reseeds in place: guard, stage in the running pod, SIGINT to PID 1, same pod back; never pg_ctl stop, never a volume transition', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec());
    const res = await runWithFakeTimers(() => setupReplication(opts));
    expect(res.streaming).toBe(true);
    const calls = vi.mocked(runCommandAsync).mock.calls;
    const joined = calls.map(([a]) => (a as string[]).join(' '));
    const everything = calls
      .map(([a, o]) => `${(a as string[]).join(' ')} ${(o as { input?: string })?.input ?? ''}`)
      .join('\n');
    expect(everything).not.toMatch(/pg_ctl stop/);
    expect(everything).not.toMatch(/--replicas=0|vibecarbon-pgdata-swap|volumeattachment/);
    const guard = joined.findIndex((c) => c.includes('vc-reseed-protocol'));
    const stage = calls.findIndex(([, o]) =>
      (o as { input?: string })?.input?.includes('.vc-reseed-ready'),
    );
    const stop = joined.findIndex((c) => c.includes('kill -INT 1'));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(stage).toBeGreaterThan(guard);
    expect(stop).toBeGreaterThan(stage);
    expect(joined[stop]).toContain(`root@${opts.standbyIp}`);
  }, 20000);

  it('the reseed pieces: self-heal first, the source primary checked, the stage over stdin, the proof, the discard', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec());
    const res = await runWithFakeTimers(() => setupReplication(opts));
    // Verified streaming carries the standby's identity for the deploy to
    // record as ha.systemIdentifier (failover's replica proof), read on the
    // standby master, the side failover promotes.
    expect(res.systemIdentifier).toBe('7412345678901234567');
    const calls = vi.mocked(runCommandAsync).mock.calls;
    const flatCalls = calls.map(([a]) => flat(a as string[]));
    expect(flatCalls.find((c) => c.includes('pg_control_system'))).toContain(
      `root@${opts.standbyIp}`,
    );

    // The replicas=0 self-heal stays: one no-op --replicas=1, before the guard
    // reads the pod (it repairs a rig an older CLI left at zero).
    const heal = flatCalls.findIndex((c) =>
      c.includes('scale statefulset db -n vibecarbon --replicas=1'),
    );
    const guard = flatCalls.findIndex((c) => c.includes('vc-reseed-protocol'));
    expect(heal).toBeGreaterThanOrEqual(0);
    expect(flatCalls[heal]).toContain(`root@${opts.standbyIp}`);
    expect(guard).toBeGreaterThan(heal);
    expect(flatCalls.filter((c) => c.includes('scale statefulset'))).toHaveLength(1);

    // The source primary (1.1.1.1): its intent read, its .vc-discard dropped
    // and its size read, all after the guard and before the stage.
    const stage = calls.findIndex(([, o]) =>
      (o as { input?: string })?.input?.includes('.vc-reseed-ready'),
    );
    const primaryIntent = flatCalls.findIndex(
      (c) => c.includes('root@1.1.1.1') && c.includes('configmap vibecarbon-db-role'),
    );
    const primaryDiscard = flatCalls.findIndex(
      (c) => c.includes('root@1.1.1.1') && c.includes('VC_DISCARD_GONE'),
    );
    expect(primaryIntent).toBeGreaterThan(guard);
    expect(primaryDiscard).toBeGreaterThan(primaryIntent);
    expect(stage).toBeGreaterThan(primaryDiscard);

    // The stage: piped into the running standby db (`exec -i ... -- sh`), into
    // $PGDATA/.vc-reseed, with the probe budget (12 × 10s), the explicit
    // conninfo through the standby's LOCAL relay, hot_standby pinned on.
    const stageArgv = flatCalls[stage];
    expect(stageArgv).toContain(`root@${opts.standbyIp}`);
    expect(stageArgv).toContain('kubectl -n vibecarbon exec -i db-0 -c db -- sh');
    const stageInput = (calls[stage][1] as { input?: string }).input ?? '';
    expect(stageInput).toContain('/var/lib/postgresql/data/.vc-reseed');
    expect(stageInput).not.toContain('.reseed_staging');
    expect(stageInput).toContain('seq 1 12');
    expect(stageInput).toContain('sleep 10');
    expect(stageInput).toContain('host=10.0.1.2 port=15433');
    expect(stageInput).toContain('hot_standby = on');
    // The client bound covers the probe budget on top of the transfer's.
    expect((calls[stage][1] as { timeout?: number }).timeout).toBeGreaterThan(1200 * 1000);

    // After the stop: the swap proof, then the recovery wait, then the old
    // tree (.vc-discard) goes. Never a second stop.
    const stop = flatCalls.findIndex((c) => c.includes('kill -INT 1'));
    const proof = flatCalls.findIndex((c) => c.includes('.vc-reseeded-from'));
    const discard = flatCalls.findIndex(
      (c) =>
        c.includes(`root@${opts.standbyIp}`) &&
        c.includes('rm -rf /var/lib/postgresql/data/.vc-discard'),
    );
    expect(proof).toBeGreaterThan(stop);
    expect(discard).toBeGreaterThan(proof);
    expect(flatCalls.filter((c) => c.includes('kill -INT 1'))).toHaveLength(1);
  }, 20000);

  it('the remote kubectl string keeps `sh -c <script>` as one argument (C13)', () => {
    const remote = standbyKubectlCommand([
      'exec',
      'db-0',
      '-n',
      'vibecarbon',
      '-c',
      'db',
      '--',
      'sh',
      '-c',
      'kill -INT 1',
    ]);
    const bin = mkdtempSync(join(tmpdir(), 'vc-kubectl-'));
    try {
      writeFileSync(
        join(bin, 'kubectl'),
        '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n',
      );
      chmodSync(join(bin, 'kubectl'), 0o755);
      const seen = spawnSync('sh', ['-c', remote], {
        encoding: 'utf-8',
        env: { PATH: `${bin}:${process.env.PATH}` },
      })
        .stdout.split('\n')
        .slice(0, -1);
      expect(seen.slice(-3)).toEqual(['sh', '-c', 'kill -INT 1']);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('every reseed kubectl the deploy sends survives the remote shell: the stop script is one argument', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec());
    await runWithFakeTimers(() => setupReplication(opts));
    const stopCall = vi
      .mocked(runCommandAsync)
      .mock.calls.map(([a]) => a as string[])
      .find((a) => a.join(' ').includes('kill -INT 1'));
    const remote = stopCall?.at(-1) ?? '';
    const bin = mkdtempSync(join(tmpdir(), 'vc-kubectl-'));
    try {
      writeFileSync(
        join(bin, 'kubectl'),
        '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n',
      );
      chmodSync(join(bin, 'kubectl'), 0o755);
      const seen = spawnSync('sh', ['-c', remote], {
        encoding: 'utf-8',
        env: { PATH: `${bin}:${process.env.PATH}` },
      })
        .stdout.split('\n')
        .slice(0, -1);
      expect(seen.slice(0, 9)).toEqual([
        '-n',
        'vibecarbon',
        'exec',
        'db-0',
        '-c',
        'db',
        '--',
        'sh',
        '-c',
      ]);
      expect(seen).toHaveLength(10);
      expect(seen[9]).toMatch(/kill -INT 1$/);
      expect(seen[9]).toContain('vc-reseed-protocol');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }, 20000);

  it("a standby pod without the wrapper after this deploy's apply fails by name (R12)", async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec({ markerGrep: '0' }));
    const err = await runWithFakeTimers(() => setupReplication(opts)).catch((e) => e);
    expect(String(err?.message)).toMatch(
      /not running the db-guard wrapper after this deploy's apply; check the db rollout/,
    );
    // Not the failover/restore hint: this IS the deploy.
    expect(String(err?.message)).not.toMatch(/predates in-place reseeds/);
    expect(String(err?.message)).not.toMatch(/replication slots/);
    const flatCalls = vi.mocked(runCommandAsync).mock.calls.map(([a]) => flat(a as string[]));
    expect(flatCalls.some((c) => c.includes('kill -INT 1'))).toBe(false);
    expect(flatCalls.some((c) => c.includes('pg_basebackup'))).toBe(false);
  }, 20000);

  it('a standby that ran as its own primary is reseeded anyway: the stop skips the recovery proof, the swap wipes its data directory', async () => {
    // A retired old primary the deploy's retired fence could not reach keeps
    // its inactive slots (`standby` was written, no slot drop). The cold
    // deploy reseeds it like a fresh standby: the swap replaces its whole
    // data directory (pg_replslot included) and the old tree is removed.
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec({ markerGrep: RETIRED }));
    const res = await runWithFakeTimers(() => setupReplication(opts));
    expect(res.streaming).toBe(true);
    const flatCalls = vi.mocked(runCommandAsync).mock.calls.map(([a]) => flat(a as string[]));
    const stop = flatCalls.find((c) => c.includes('kill -INT 1')) ?? '';
    expect(stop).toContain('vc-reseed-protocol');
    expect(stop).not.toContain('pg_is_in_recovery');
    const proof = flatCalls.findIndex((c) => c.includes('.vc-reseeded-from'));
    const discard = flatCalls.findIndex(
      (c) =>
        c.includes(`root@${opts.standbyIp}`) &&
        c.includes('rm -rf /var/lib/postgresql/data/.vc-discard'),
    );
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(discard).toBeGreaterThan(proof);
  }, 20000);

  it('a failed reseed of a standby holding replication slots says they may still retain WAL', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(
      inPlaceExec({
        markerGrep: RETIRED,
        stageError: Object.assign(new Error('Command failed: ssh ... exec -i db-0'), {
          stdout: 'pg_basebackup: error: connection refused\n',
          status: 1,
        }),
      }),
    );
    const err = await runWithFakeTimers(() => setupReplication(opts)).catch((e) => e);
    expect(String(err?.message)).toMatch(/Command failed/);
    expect(String(err?.message)).toMatch(
      /may still hold replication slots that retain WAL on its disk \(it held 2[\s\S]*rerun `vibecarbon deploy`/,
    );
    const flatCalls = vi.mocked(runCommandAsync).mock.calls.map(([a]) => flat(a as string[]));
    expect(flatCalls.some((c) => c.includes('kill -INT 1'))).toBe(false);
  }, 20000);

  it('a failed reseed of a fresh standby (no slots) makes no slot claim', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(
      inPlaceExec({
        stageError: Object.assign(new Error('Command failed: ssh ... exec -i db-0'), {
          stdout: 'pg_basebackup: error: connection refused\n',
          status: 1,
        }),
      }),
    );
    const err = await runWithFakeTimers(() => setupReplication(opts)).catch((e) => e);
    expect(String(err?.message)).toMatch(/Command failed/);
    expect(String(err?.message)).not.toMatch(/replication slots/);
  }, 20000);

  it('the lineage check: a fresh initdb (another system identifier) is reseeded', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec({ markerGrep: FRESH }));
    expect((await runWithFakeTimers(() => setupReplication(opts))).streaming).toBe(true);
    const flatCalls = vi.mocked(runCommandAsync).mock.calls.map(([a]) => flat(a as string[]));
    // The lineage rides the existing reads: the guard exec and the source's size read.
    const guard = flatCalls.find((c) => c.includes('vc-reseed-protocol') && c.includes('grep -c'));
    expect(guard).toContain('pg_replication_slots');
    expect(guard).toContain('pg_control_system()');
    const sourceRead = flatCalls.find((c) => c.includes('pg_database_size')) ?? '';
    expect(sourceRead).toContain('root@1.1.1.1');
    expect(sourceRead).toContain('pg_walfile_name(pg_current_wal_lsn())');
    expect(flatCalls.filter((c) => c.includes('kill -INT 1'))).toHaveLength(1);
  }, 20000);

  it('the lineage check: a retired old primary (same database, older timeline) is reseeded', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec({ markerGrep: RETIRED }));
    expect((await runWithFakeTimers(() => setupReplication(opts))).streaming).toBe(true);
    const flatCalls = vi.mocked(runCommandAsync).mock.calls.map(([a]) => flat(a as string[]));
    expect(flatCalls.filter((c) => c.includes('kill -INT 1'))).toHaveLength(1);
  }, 20000);

  it('the lineage check: a standby promoted outside vibecarbon (same database, newer timeline) is refused before anything is staged or stopped', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec({ markerGrep: PROMOTED_OUTSIDE }));
    const err = await runWithFakeTimers(() => setupReplication(opts)).catch((e) => e);
    expect(String(err?.message)).toMatch(
      /standby 2\.2\.2\.2 looks promoted outside vibecarbon[\s\S]*timeline 3[\s\S]*timeline 2[\s\S]*Nothing was staged or stopped[\s\S]*`vibecarbon failover /,
    );
    const calls = vi.mocked(runCommandAsync).mock.calls;
    expect(calls.some(([, o]) => (o as { input?: string })?.input?.includes('pg_basebackup'))).toBe(
      false,
    );
    expect(calls.some(([a]) => flat(a as string[]).includes('kill -INT 1'))).toBe(false);
  }, 20000);

  it('the lineage check: a standby outside recovery whose lineage cannot be read is not reseeded blind', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(
      inPlaceExec({ markerGrep: guardOut({ recovery: 'f', slots: 0, ident: '' }) }),
    );
    const err = await runWithFakeTimers(() => setupReplication(opts)).catch((e) => e);
    expect(String(err?.message)).toMatch(/system identifier and timeline could not be read/);
    const calls = vi.mocked(runCommandAsync).mock.calls;
    expect(calls.some(([, o]) => (o as { input?: string })?.input?.includes('pg_basebackup'))).toBe(
      false,
    );
  }, 20000);

  it('a failed reseed of a standby proven in recovery makes no slot claim', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(
      inPlaceExec({
        markerGrep: '1\nin_recovery=t',
        stageError: Object.assign(new Error('Command failed: ssh ... exec -i db-0'), {
          stdout: '',
          status: 1,
        }),
      }),
    );
    const err = await runWithFakeTimers(() => setupReplication(opts)).catch((e) => e);
    expect(String(err?.message)).toMatch(/Command failed/);
    expect(String(err?.message)).not.toMatch(/replication slots/);
  }, 20000);

  it('the source primary reporting another intent refuses before anything is staged', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec({ primaryIntent: 'standby' }));
    await expect(runWithFakeTimers(() => setupReplication(opts))).rejects.toThrow(
      /configured primary's cluster reports the standby intent/,
    );
    const calls = vi.mocked(runCommandAsync).mock.calls;
    expect(calls.some(([, o]) => (o as { input?: string })?.input?.includes('pg_basebackup'))).toBe(
      false,
    );
    expect(calls.some(([a]) => flat(a as string[]).includes('kill -INT 1'))).toBe(false);
  }, 20000);

  it('fails loud when a swapped reseed never enters recovery', async () => {
    vi.mocked(runCommandAsync).mockClear();
    // The swap ran, but the standby never reports pg_is_in_recovery()='t'.
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec({ recovery: 'f' }));
    const err = await runWithFakeTimers(() => setupReplication(opts)).catch((e) => e);
    expect(String(err?.message)).toMatch(/never entered\s+recovery/i);
    // The swap wiped the old data directory: no slot claim.
    expect(String(err?.message)).not.toMatch(/replication slots/);
  }, 20000);

  it('classifies "Hot standby mode is disabled" as a CONFIG error, not a timing failure', async () => {
    vi.mocked(runCommandAsync).mockClear();
    // The standby streams but refuses read-only connections: every
    // pg_is_in_recovery read fails with the FATAL text.
    const happy = inPlaceExec();
    vi.mocked(runCommandAsync).mockImplementation(async (argv: string[], o?: object) => {
      if (flat(argv).includes('SELECT pg_is_in_recovery()') && !flat(argv).includes('grep')) {
        throw new Error(
          'Command failed: psql: error: connection to server failed: FATAL: the database system ' +
            'is not accepting connections\nDETAIL: Hot standby mode is disabled.',
        );
      }
      return happy(argv, o);
    });
    await expect(runWithFakeTimers(() => setupReplication(opts))).rejects.toThrow(
      /hot_standby is OFF .* must pin hot_standby = on/s,
    );
  }, 20000);

  it('fails LOUD (relay host:port + attempts) on RESEED_SKIPPED, and stops nothing', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(inPlaceExec({ stageOut: 'RESEED_SKIPPED' }));
    const err = await runWithFakeTimers(() => setupReplication(opts)).catch((e) => e);
    expect(String(err?.message)).toMatch(
      /could not reach the primary via the local relay 10\.0\.1\.2:15433 after 12 attempts/,
    );
    const flatCalls = vi.mocked(runCommandAsync).mock.calls.map(([a]) => flat(a as string[]));
    expect(flatCalls.some((c) => c.includes('kill -INT 1'))).toBe(false);
    expect(flatCalls.some((c) => c.includes('--replicas=0'))).toBe(false);
  }, 20000);

  it('verify retries transient pg_stat_replication exec garbage instead of treating it as terminal', async () => {
    vi.mocked(runCommandAsync).mockClear();
    // This guards phase 5's strict-verify closure specifically (RCA
    // 2026-07-06): the FIRST post-reseed streaming-state read yields kubectl
    // error text (primary pod just recreated), second read succeeds — phase
    // 5 must retry, not report lastState="command terminated with exit code
    // 1". The unconditional streaming probe asks the identical question
    // BEFORE the reseed, so gate on the reseed signal (the in-place stop) so
    // the probe honestly sees "not streaming" and falls through to the
    // reseed; otherwise the probe's own retry would resolve the fast path and
    // phase 5's closure would never run at all.
    let reseeded = false;
    let postReseedReads = 0;
    let statReads = 0;
    const happy = inPlaceExec();
    vi.mocked(runCommandAsync).mockImplementation(async (argv: string[], o?: object) => {
      const cmd = flat(argv);
      if (cmd.includes('kill -INT 1')) reseeded = true;
      if (cmd.includes('pg_stat_replication')) {
        statReads += 1;
        if (!reseeded) return ''; // probe reads: never streaming pre-reseed
        postReseedReads += 1;
        return postReseedReads === 1 ? 'command terminated with exit code 1' : 'streaming';
      }
      return happy(argv, o);
    });
    const res = await runWithFakeTimers(() => setupReplication(opts));
    expect(res.streaming).toBe(true);
    expect(statReads).toBeGreaterThanOrEqual(2);
    // Reach-phase-5 accounting: at least 2 reads happened AFTER the reseed
    // signal fired (the garbage read + the streaming read).
    expect(postReseedReads).toBeGreaterThanOrEqual(2);
  }, 20000);

  it('a stop that recreates the pod waits its rollout under the attach watch, and stops early on a stale volume attachment, by name', async () => {
    // The in-place restart degrades into the watchDbAttach-wrapped rollout
    // wait when the pod comes back with a new uid (a recreate re-attaches the
    // volume: the DO e2e 2026-11-01 class). The rollout never ends, the new
    // db-0's events carry the missing-device signature, and the wait must
    // stop with it.
    vi.mocked(runCommandAsync).mockClear();
    const happy = inPlaceExec({ recreateAs: 'standby-db-uid' });
    const vol = 'pvc-1234';
    const staleEvents = JSON.stringify({
      items: [
        {
          involvedObject: { name: 'db-0', uid: 'standby-db-uid' },
          reason: 'FailedMount',
          message:
            `MountVolume.MountDevice failed for volume "${vol}" : formatting disk failed: ` +
            `mkfs.ext4 -F /dev/disk/by-id/scsi-0DO_Volume_${vol} does not exist and no size was specified`,
          count: 9,
          firstTimestamp: '2026-11-01T16:00:00Z',
          lastTimestamp: '2026-11-01T16:04:30Z',
        },
      ],
    });
    vi.mocked(runCommandAsync).mockImplementation(
      async (argv: string[], o: { signal?: AbortSignal; input?: string } = {}) => {
        const cmd = flat(argv);
        if (cmd.includes('rollout status statefulset/db')) {
          return new Promise((_r, reject) =>
            o.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          );
        }
        if (cmd.includes('involvedObject.uid=standby-db-uid')) return staleEvents;
        return happy(argv, o);
      },
    );
    await expect(setupReplication({ ...opts, attachWatchPollMs: 1 })).rejects.toThrow(
      /pvc-1234[\s\S]*stale volume attachment/,
    );
  }, 20000);
});
