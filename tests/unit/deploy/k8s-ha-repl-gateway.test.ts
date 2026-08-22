import { describe, expect, it, vi } from 'vitest';

// --- Mock the exec + environment seams so setupReplication runs offline. ---
// PGDATA swap-pod inputs come from the db pod spec: the PVC claimName, the
// subPath the chart mounts the volume at (/var/lib/postgresql/data via subPath
// `postgres-data`), and the db container image (reused for the swap pod). No PV
// node-path walk anymore — the swap runs in a helper pod that mounts the PVC, so
// it works for local-path AND csi.hetzner.cloud volumes alike.
const DB_IMAGE = 'supabase/postgres:15.8.1.060';
// Pretty-printed (null, 2) like real kubectl -o json output: the ha/index
// self-heal waits on the literal substring `"phase": "Running"` before reading
// the pod spec.
const POD_JSON = JSON.stringify(
  {
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
    status: { phase: 'Running' },
  },
  null,
  2,
);

// Shared happy-path exec behavior, incl. the helper-pod swap lifecycle
// (apply → status.phase=Succeeded via -o json → logs RESEED_SWAPPED → delete).
// `swapLog`/`swapPhase`/`swapConditions` let a test flip the swap-pod's
// reported sentinel/phase/scheduling state. The status poll answers `get pod
// ... -o json` (JS-parsed) — the old jsonpath's |/?() metachars were a remote
// bash syntax error through the joined-argv ssh transport.
function happyExec({
  swapLog = 'RESEED_SWAPPED',
  swapPhase = 'Succeeded',
  swapConditions = [] as Array<{ type: string; reason?: string; message?: string }>,
} = {}) {
  // The unconditional streaming probe ahead of the reseed block (fan-out
  // chaining + streaming fast-path) reads the SAME pg_stat_replication query
  // as the final verify. Track whether a reseed has actually run — scale-to-
  // zero is the unambiguous "reseed is underway" signal — so the probe
  // honestly reports "not yet streaming" beforehand (a never-seeded standby
  // has no replica connected) and 'streaming' only once a fresh basebackup
  // has been swapped in, same as a real rig. Scoped to this closure so every
  // fresh happyExec() call starts isolated.
  let reseeded = false;
  return async (argv: string[]) => {
    const cmd = Array.isArray(argv) ? argv.join(' ') : String(argv);
    if (cmd.includes('scale statefulset supabase-supabase-db') && cmd.includes('--replicas=0')) {
      reseeded = true;
    }
    // Swap-pod lifecycle (must precede the generic db-pod matchers below).
    if (cmd.includes('get pod vibecarbon-pgdata-swap') && cmd.includes('-o json'))
      return JSON.stringify({ status: { phase: swapPhase, conditions: swapConditions } });
    if (cmd.includes('logs vibecarbon-pgdata-swap')) return swapLog;
    // db pod spec → claimName/subPath/image resolution (+ the self-heal's
    // wait-for-Running reads the same JSON).
    if (cmd.includes('get pod') && cmd.includes('-o json')) return POD_JSON;
    // db pod-gone poll after scale-to-zero: report the pod as already gone.
    if (cmd.includes('get pod') && cmd.includes('--ignore-not-found')) return '';
    if (cmd.includes('pg_isready')) return 'IS_READY';
    if (cmd.includes('pg_is_in_recovery')) return 't';
    if (cmd.includes('pg_stat_replication')) return reseeded ? 'streaming' : '';
    return '';
  };
}

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
    expect(out).not.toContain('__SUPABASE_PRIVATE_IP__');
    expect(out).toContain('bind=10.0.1.2');
    expect(out).toContain('cidr: 10.0.1.2/32');
    expect(out).toContain('allow-db-repl-gateway-egress');
  });
});

describe('reestablishReplicationTransport — post-resize belt (item I-1)', () => {
  const opts = {
    primaryIp: '1.1.1.1',
    standbyIp: '2.2.2.2',
    primarySupabaseIp: '167.233.150.173',
    standbySupabaseIp: '157.180.115.19',
    primarySupabasePrivateIp: '10.0.1.2',
    standbySupabasePrivateIp: '10.0.1.2',
    sshKeyPath: '/tmp/key',
  };

  it('recreates wg0 then bounces + re-applies the gateway on both clusters', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(happyExec());
    vi.mocked(exchangeAndBringUpTunnel).mockClear();

    await reestablishReplicationTransport(opts);

    // Tunnel recreated once, with the supabase PUBLIC IPs (self-heals the unit too).
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledTimes(1);
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledWith({
      primaryIp: '167.233.150.173',
      standbyIp: '157.180.115.19',
      sshKeyPath: '/tmp/key',
    });

    const calls = vi.mocked(runCommandAsync).mock.calls;
    const joined = calls.map(([argv]) => (argv as string[]).join(' '));

    // Delete BEFORE apply on each cluster's MASTER (a bare Pod isn't recreated
    // by any controller, so delete-then-apply gives a fresh, cleanly-binding Pod).
    for (const master of ['1.1.1.1', '2.2.2.2']) {
      const del = joined.findIndex(
        (c) => c.includes(master) && c.includes('delete pod repl-gateway'),
      );
      const apply = joined.findIndex((c) => c.includes(master) && c.includes('apply -f -'));
      expect(del).toBeGreaterThanOrEqual(0);
      expect(apply).toBeGreaterThan(del);
    }

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
    primarySupabaseIp: '167.233.150.173',
    standbySupabaseIp: '157.180.115.19',
    primarySupabasePrivateIp: '10.0.1.2',
    standbySupabasePrivateIp: '10.0.1.2',
    sshKeyPath: '/tmp/key',
  };

  it('applies the gateway to both clusters, brings up the tunnel, ships the netpol, no TLS', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(happyExec());
    vi.mocked(exchangeAndBringUpTunnel).mockClear();

    const res = await runWithFakeTimers(() => setupReplication(opts));
    expect(res.streaming).toBe(true);

    const calls = vi.mocked(runCommandAsync).mock.calls;
    // Gateway applies only (exclude the helper-pod swap apply, which also uses
    // `apply -f -` but carries the vibecarbon-pgdata-swap Pod manifest).
    const applyCalls = calls.filter(
      ([argv, o]) =>
        (argv as string[]).join(' ').includes('apply -f -') &&
        !((o as { input?: string })?.input?.includes('vibecarbon-pgdata-swap') ?? false),
    );
    // One gateway apply per cluster.
    expect(applyCalls.length).toBe(2);

    const applyInputs = applyCalls.map(([, o]) => (o as { input?: string }).input ?? '');
    // Both applies carry the gateway Pod + the additive egress NetworkPolicy.
    for (const input of applyInputs) {
      expect(input).toContain('kind: Pod');
      expect(input).toContain('repl-gateway');
      expect(input).toContain('allow-db-repl-gateway-egress');
      expect(input).toContain('cidr: 10.0.1.2/32');
      expect(input).not.toContain('__RELAY_');
    }
    // Primary relays to local postgres; standby relays into the tunnel.
    expect(applyInputs.some((i) => i.includes('TCP:127.0.0.1:5433'))).toBe(true);
    expect(applyInputs.some((i) => i.includes('TCP:10.99.0.1:15433'))).toBe(true);

    // Tunnel bring-up called once, with the supabase PUBLIC IPs as endpoints.
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledTimes(1);
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledWith({
      primaryIp: '167.233.150.173',
      standbyIp: '157.180.115.19',
      sshKeyPath: '/tmp/key',
    });

    // The db hostPort patch is STILL applied (primary gateway relays to it).
    expect(
      calls.some(([argv]) =>
        (argv as string[]).join(' ').includes('patch statefulset supabase-supabase-db'),
      ),
    ).toBe(true);

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

    // Durable location: the supabase image's live hba (/etc, container-
    // ephemeral) is copied into PGDATA, hba_file is repointed via ALTER SYSTEM
    // (applied by the step-3 restart), and appends are idempotent.
    expect(script).toContain('SHOW hba_file');
    expect(script).toContain('HBA_DURABLE=/var/lib/postgresql/data/pg_hba.conf');
    expect(script).toContain('ALTER SYSTEM SET hba_file');
    expect(script).toContain('grep -qxF');

    // It targets the PRIMARY cluster (1.1.1.1), before the step-3 pod restart.
    const argv = ((hbaCall as unknown[])[0] as string[]).join(' ');
    expect(argv).toContain('1.1.1.1');
  }, 20000);

  it('reseeds via scale-to-zero + helper-pod swap — never in-pod pg_ctl stop or node-path walk', async () => {
    vi.mocked(runCommandAsync).mockClear();
    vi.mocked(runCommandAsync).mockImplementation(happyExec());

    const res = await runWithFakeTimers(() => setupReplication(opts));
    expect(res.streaming).toBe(true);

    const calls = vi.mocked(runCommandAsync).mock.calls;
    const joined = calls.map(([argv]) => (argv as string[]).join(' '));
    const everything = calls
      .map(
        ([argv, o]) => `${(argv as string[]).join(' ')} ${(o as { input?: string })?.input ?? ''}`,
      )
      .join('\n');

    // The RCA'd killer is gone: NO in-pod pg_ctl stop of the standby postmaster.
    expect(everything).not.toMatch(/pg_ctl stop/);
    // No node-path walk (PV local/hostPath) and no node-side `bash -s` swap — the
    // swap runs in a helper pod, so CSI volumes (no hostPath, detach on
    // scale-to-zero) work the same as local-path.
    expect(everything).not.toMatch(/get pv /);
    expect(everything).not.toMatch(/bash -s/);

    // Self-heal FIRST: a prior deploy that died mid-reseed can leave the sts at
    // replicas=0 with no db pod — scale to 1 and wait for Running BEFORE
    // reading the pod spec (a healthy rig no-ops through this).
    const heal1 = joined.findIndex((c) =>
      c.includes('scale statefulset supabase-supabase-db -n vibecarbon --replicas=1'),
    );
    const podRead = joined.findIndex((c) => c.includes('get pod supabase-supabase-db-0'));
    expect(heal1).toBeGreaterThanOrEqual(0);
    expect(podRead).toBeGreaterThan(heal1);

    // Clean StatefulSet-controller quiesce: scale to 0 THEN back to 1 (the
    // final scale-1 is the finally-block one, after the self-heal's).
    const scale0 = joined.findIndex((c) =>
      c.includes('scale statefulset supabase-supabase-db -n vibecarbon --replicas=0'),
    );
    const scale1 = joined.findLastIndex((c) =>
      c.includes('scale statefulset supabase-supabase-db -n vibecarbon --replicas=1'),
    );
    expect(scale0).toBeGreaterThan(heal1);
    expect(scale1).toBeGreaterThan(scale0);

    // The basebackup stages into a subdir of PGDATA (on the PVC) and does NOT
    // swap in-pod (swap:false) — the helper pod does the atomic swap.
    const stageCall = calls.find(([argv, o]) =>
      (argv as string[]).join(' ').includes('exec -i -n vibecarbon supabase-supabase-db-0 -- bash')
        ? (o as { input?: string })?.input?.includes('.reseed_staging')
        : false,
    );
    expect(stageCall).toBeTruthy();
    const stageInput = (stageCall?.[1] as { input?: string })?.input ?? '';
    expect(stageInput).toContain('/var/lib/postgresql/data/.reseed_staging');
    // swap:false → no in-pod destructive clear of the live PGDATA.
    expect(stageInput).not.toMatch(/find \/var\/lib\/postgresql\/data -mindepth 1 -delete/);
    // conninfo is folded into the staged basebackup (present at first boot).
    expect(stageInput).toContain('primary_conninfo');
    // hot_standby forced on in the staged auto.conf — the image's wal-g.conf
    // ships hot_standby=off, which would make the reseeded standby refuse
    // read-only connections while streaming fine.
    expect(stageInput).toContain('hot_standby = on');

    // The swap runs in a helper pod applied on the standby MASTER (2.2.2.2), NOT
    // an ssh to a node. Its manifest mounts the SAME PVC (claimName) and REUSES
    // the db image (already pulled on the node).
    const swapApply = calls.find(
      ([argv, o]) =>
        (argv as string[]).join(' ').includes('apply -f -') &&
        ((o as { input?: string })?.input?.includes('vibecarbon-pgdata-swap') ?? false),
    );
    expect(swapApply).toBeTruthy();
    expect(((swapApply as unknown[])[0] as string[]).join(' ')).toContain('2.2.2.2');
    const swapManifest = (swapApply?.[1] as { input?: string })?.input ?? '';
    expect(swapManifest).toContain('data-supabase-supabase-db-0'); // same PVC
    expect(swapManifest).toContain(DB_IMAGE); // image reuse (already pulled)
    expect(swapManifest).toContain('bash'); // command runs the swap script
    // Mount the WHOLE PVC (no subPath) at /pgdata-vol; PGDATA = <root>/<subPath>.
    expect(swapManifest).toContain('/pgdata-vol');
    expect(swapManifest).toContain("PGDATA='/pgdata-vol/postgres-data'");
    // The swap must happen AFTER scale-to-zero and BEFORE scale-back-up.
    const swapIdx = calls.indexOf(swapApply as (typeof calls)[number]);
    expect(swapIdx).toBeGreaterThan(scale0);
    expect(swapIdx).toBeLessThan(scale1);
    // The one-shot swap pod is cleaned up.
    expect(joined.some((c) => c.includes('delete pod vibecarbon-pgdata-swap'))).toBe(true);
  }, 20000);

  it('fails loud when a swapped reseed never enters recovery', async () => {
    vi.mocked(runCommandAsync).mockClear();
    // Same happy chain, but the standby never reports pg_is_in_recovery()='t'.
    vi.mocked(runCommandAsync).mockImplementation(async (argv: string[]) => {
      const cmd = Array.isArray(argv) ? argv.join(' ') : String(argv);
      if (cmd.includes('pg_is_in_recovery')) return 'f'; // never enters recovery
      return happyExec()(argv);
    });

    // The recovery poll sleeps between attempts — drive it with fake timers so
    // the test doesn't wait out the real ~2-minute budget.
    vi.useFakeTimers();
    try {
      const promise = setupReplication(opts);
      const assertion = expect(promise).rejects.toThrow(/never entered\s+recovery/i);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it('classifies "Hot standby mode is disabled" as a CONFIG error, not a timing failure', async () => {
    vi.mocked(runCommandAsync).mockClear();
    // The standby streams but refuses read-only connections: every
    // pg_is_in_recovery poll yields the FATAL text instead of t/f.
    vi.mocked(runCommandAsync).mockImplementation(async (argv: string[]) => {
      const cmd = Array.isArray(argv) ? argv.join(' ') : String(argv);
      if (cmd.includes('pg_is_in_recovery')) {
        return (
          'psql: error: connection to server failed: FATAL: the database system is not ' +
          'accepting connections\nDETAIL: Hot standby mode is disabled.'
        );
      }
      return happyExec()(argv);
    });

    vi.useFakeTimers();
    try {
      const promise = setupReplication(opts);
      const assertion = expect(promise).rejects.toThrow(/hot_standby is OFF .* wal-g\.conf/s);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it('probes with a retry budget and fails LOUD (relay host:port + attempts) on RESEED_SKIPPED', async () => {
    vi.mocked(runCommandAsync).mockClear();
    // Re-pin the happy implementation (an earlier test replaced it; mockClear
    // does not restore implementations).
    vi.mocked(runCommandAsync).mockImplementation(happyExec());

    // The staged script carries the probe retry loop (12 × 10s).
    await runWithFakeTimers(() => setupReplication(opts));
    const stageCall = vi
      .mocked(runCommandAsync)
      .mock.calls.find(([argv, o]) =>
        (argv as string[])
          .join(' ')
          .includes('exec -i -n vibecarbon supabase-supabase-db-0 -- bash')
          ? ((o as { input?: string })?.input?.includes('pg_basebackup') ?? false)
          : false,
      );
    const stageInput = (stageCall?.[1] as { input?: string })?.input ?? '';
    expect(stageInput).toContain('seq 1 12');
    expect(stageInput).toContain('sleep 10');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal bash ${probe_i} placeholder in the generated script
    expect(stageInput).toContain('probe attempt ${probe_i}/12');

    // Helper-pod swap logs RESEED_SKIPPED (probe never reached the primary): the
    // deploy path must fail FAST and name the relay endpoint + budget — never
    // quietly no-op into a guaranteed verify failure 10 minutes later.
    vi.mocked(runCommandAsync).mockImplementation(happyExec({ swapLog: 'RESEED_SKIPPED' }));
    await expect(runWithFakeTimers(() => setupReplication(opts))).rejects.toThrow(
      /could not reach the primary via the local relay 10\.0\.1\.2:15433 after 12 attempts/,
    );
    // finally-scale-1: even though the reseed threw, the sts was scaled back to
    // 1 AFTER the scale-0 — the rig is never left with zero standby dbs
    // (live-hit 2026-07-07: a failed swap left the sts at replicas=0).
    const skippedCmds = vi
      .mocked(runCommandAsync)
      .mock.calls.map(([argv]) => (argv as string[]).join(' '));
    const skipScale0 = skippedCmds.findIndex((c) => c.includes('--replicas=0'));
    const skipScale1 = skippedCmds.findLastIndex((c) => c.includes('--replicas=1'));
    expect(skipScale0).toBeGreaterThanOrEqual(0);
    expect(skipScale1).toBeGreaterThan(skipScale0);
  }, 20000);

  it('fails FAST with the scheduler message when the swap pod is Unschedulable, and still scales back up', async () => {
    vi.mocked(runCommandAsync).mockClear();
    const schedMsg =
      '0/3 nodes are available: 1 node(s) had untolerated taint {dedicated: supabase}, ' +
      '2 node(s) had volume node affinity conflict.';
    vi.mocked(runCommandAsync).mockImplementation(
      happyExec({
        swapPhase: 'Pending',
        swapConditions: [{ type: 'PodScheduled', reason: 'Unschedulable', message: schedMsg }],
      }),
    );

    // Terminal on the FIRST poll (a taint/affinity conflict never self-heals) —
    // the error names the exact scheduler conflict, not a generic timeout.
    await expect(runWithFakeTimers(() => setupReplication(opts))).rejects.toThrow(
      /could not be scheduled[\s\S]*untolerated taint \{dedicated: supabase\}/,
    );

    const cmds = vi
      .mocked(runCommandAsync)
      .mock.calls.map(([argv]) => (argv as string[]).join(' '));
    // The swap pod manifest carries the dedicated=supabase toleration (the
    // local-path PV pins the pod to the tainted supabase node).
    const swapApply = vi
      .mocked(runCommandAsync)
      .mock.calls.find(
        ([argv, o]) =>
          (argv as string[]).join(' ').includes('apply -f -') &&
          ((o as { input?: string })?.input?.includes('vibecarbon-pgdata-swap') ?? false),
      );
    const swapManifest = (swapApply?.[1] as { input?: string })?.input ?? '';
    expect(swapManifest).toContain('"tolerations"');
    expect(swapManifest).toContain('"dedicated"');
    expect(swapManifest).toContain('"supabase"');
    expect(swapManifest).toContain('"NoSchedule"');
    // finally-scale-1: the sts comes back up even on the unschedulable path.
    const scale0 = cmds.findIndex((c) => c.includes('--replicas=0'));
    const scale1 = cmds.findLastIndex((c) => c.includes('--replicas=1'));
    expect(scale0).toBeGreaterThanOrEqual(0);
    expect(scale1).toBeGreaterThan(scale0);
    // The one-shot swap pod is still cleaned up.
    expect(cmds.some((c) => c.includes('delete pod vibecarbon-pgdata-swap'))).toBe(true);
  }, 20000);

  it('verify retries transient pg_stat_replication exec garbage instead of treating it as terminal', async () => {
    vi.mocked(runCommandAsync).mockClear();
    // This guards phase 5's strict-verify closure specifically (RCA
    // 2026-07-06): the FIRST post-reseed streaming-state read yields kubectl
    // error text (primary pod just recreated), second read succeeds — phase
    // 5 must retry, not report lastState="command terminated with exit code
    // 1". The new unconditional streaming probe asks the identical question
    // BEFORE the reseed — gate on the reseed signal (--replicas=0, the same
    // one happyExec() keys off) so the probe honestly sees "not streaming"
    // and falls through to the serial reseed path; otherwise the probe's own
    // (more lenient) retry would resolve the fast path and phase 5's closure
    // would never run at all.
    let reseeded = false;
    let postReseedReads = 0;
    let statReads = 0;
    vi.mocked(runCommandAsync).mockImplementation(async (argv: string[]) => {
      const cmd = Array.isArray(argv) ? argv.join(' ') : String(argv);
      if (cmd.includes('scale statefulset supabase-supabase-db') && cmd.includes('--replicas=0')) {
        reseeded = true;
      }
      if (cmd.includes('pg_stat_replication')) {
        statReads += 1;
        if (!reseeded) return ''; // probe reads: never streaming pre-reseed
        postReseedReads += 1;
        return postReseedReads === 1 ? 'command terminated with exit code 1' : 'streaming';
      }
      return happyExec()(argv);
    });

    // The probe's retry delay (2s) and the verify's retry delay (5s) are both
    // driven with fake timers.
    vi.useFakeTimers();
    try {
      const promise = setupReplication(opts);
      const done = promise.then((r) => r);
      await vi.runAllTimersAsync();
      const res = await done;
      expect(res.streaming).toBe(true);
      expect(statReads).toBeGreaterThanOrEqual(2);
      // Reach-phase-5 accounting: at least 2 reads happened AFTER the reseed
      // signal fired (the garbage read + the streaming read) — proof that
      // this test actually exercised phase 5's retry closure, not just the
      // probe's. Without this, a probe-fast-path regression would go green
      // silently again (exactly what slipped through here the first time).
      expect(postReseedReads).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  }, 20000);
});
