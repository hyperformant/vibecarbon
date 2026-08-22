/**
 * Pilot-light failover: standby worker provisioning half (Task 9).
 *
 * `vibecarbon failover` on a pilot-light HA topology must first bring the
 * standby cluster's worker floor 0→N through the hardened IaC converge seam
 * (src/lib/iac/converge-cluster.js), wait for those nodes to register Ready,
 * then let the caller (Task 10) scale the app tier up. Provisioning is the
 * ONLY step in the failover that adds cloud capacity, so its failure handling
 * is load-bearing: ANY failure (converge throw OR workers never Ready) must
 * converge the standby back to 0 workers — leaving the still-serving PRIMARY
 * completely untouched — and abort with a distinct AbortProvisioningError so
 * the flow never proceeds to promote/scale/flip DNS onto half-provisioned
 * capacity.
 *
 * These tests drive the exported building blocks directly with injected deps
 * (`converge`, `kubectl`, `sleep`) so no Pulumi/SSH ever runs.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AbortProvisioningError,
  failoverHA,
  preflightPilotFailover,
  provisionStandbyCapacity,
  swapHaRoles,
  waitForStandbyCaughtUp,
  waitForWorkersReady,
} from '../../../src/failover.js';

/** `kubectl get nodes --no-headers` output with `n` Ready worker rows (+ master). */
function readyLines(n: number): string {
  return [
    'proj-e4-standby-master   Ready   control-plane   10m   v1.30',
    ...Array.from(
      { length: n },
      (_, i) => `proj-e4-standby-worker-${i}   Ready   <none>   5m   v1.30`,
    ),
  ].join('\n');
}

/** A kubectl stub that always reports `n` Ready workers. */
function readyKubectl(n: number) {
  return vi.fn(async () => readyLines(n));
}

/** Shared provisionStandbyCapacity args; each test supplies its own `deps`. */
const base = {
  envName: 'e4',
  projectConfig: { projectName: 'proj' },
  envConfig: {
    s3: { bucket: 'b', region: 'nbg1', endpoint: 'https://x', stateBucket: 'sb' },
    ha: {
      standby: { stack: 'e4-standby', region: 'ash', masterIp: '10.0.0.9' },
    },
  },
  servers: {
    primary: { ip: '10.0.0.1' },
    standby: { ip: '10.0.0.9', supabaseIp: '10.0.0.10' },
  },
  workerSpec: { count: 2, serverType: 'cx23' },
};

describe('provisionStandbyCapacity', () => {
  it('provisions workers via the IaC seam with the persisted spec', async () => {
    const converge = vi.fn(async () => ({ outputs: {} }));
    const result = await provisionStandbyCapacity({
      ...base,
      workerSpec: { count: 2, serverType: 'cx23' },
      deps: { converge, kubectl: readyKubectl(2) },
    });
    expect(result).toEqual({ provisioned: true });
    expect(converge).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterEnv: 'e4-standby',
        overrides: expect.objectContaining({ minWorkers: 2, workerServerType: 'cx23' }),
      }),
    );
  });

  it('-server-type override wins over the persisted worker serverType', async () => {
    const converge = vi.fn(async () => ({ outputs: {} }));
    await provisionStandbyCapacity({
      ...base,
      workerSpec: { count: 2, serverType: 'cx23' },
      serverTypeOverride: 'cpx31',
      deps: { converge, kubectl: readyKubectl(2) },
    });
    expect(converge).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({ minWorkers: 2, workerServerType: 'cpx31' }),
      }),
    );
  });

  // I5: pin the standby's persisted region-resolved master/supabase types (and
  // the failover action word) on the converge, so buildProgramConfig's
  // current-type slots match the standby's reality and the converge never plans
  // an in-place resize of the standby's master/db node mid-failover.
  it('pins the persisted standby master/supabase types + failover action on every converge', async () => {
    const converge = vi.fn(async () => ({ outputs: {} }));
    await provisionStandbyCapacity({
      ...base,
      envConfig: {
        ...base.envConfig,
        ha: {
          standby: {
            stack: 'e4-standby',
            region: 'ash',
            masterIp: '10.0.0.9',
            masterServerType: 'cpx31',
            supabaseServerType: 'cpx41',
          },
        },
      },
      deps: { converge, kubectl: readyKubectl(2) },
    });
    // Both the up (call 0) and any revert carry the type pins + failover action.
    expect(converge).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'failover',
        overrides: expect.objectContaining({
          minWorkers: 2,
          workerServerType: 'cx23',
          masterServerType: 'cpx31',
          supabaseServerType: 'cpx41',
        }),
      }),
    );
  });

  it('generic abort: converge failure reverts to 0 workers, throws, mutates nothing else', async () => {
    const kubectl = vi.fn();
    const converge = vi
      .fn()
      .mockRejectedValueOnce(new Error('resource_unavailable'))
      .mockResolvedValueOnce({ outputs: {} });
    const err = await provisionStandbyCapacity({
      ...base,
      deps: { converge, kubectl },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AbortProvisioningError);
    expect(err.message).toMatch(/aborted/i);
    // Two converge calls: the up, then the revert to 0.
    expect(converge).toHaveBeenCalledTimes(2);
    expect(converge.mock.calls[1][0].overrides.minWorkers).toBe(0);
    // Provisioning failed before workers came up → zero cluster mutations.
    expect(kubectl).not.toHaveBeenCalled();
  });

  // x86-64 standardization (2026-07-30). The persisted
  // `ha.standbyWorkerSpec.serverType` flows verbatim into the converge
  // (buildProgramConfig's workerType slot) without passing any filtered option
  // list, so on an environment deployed before the standardization it is the
  // one remaining way an ARM SKU can reach real hardware. It is REJECTED, not
  // rescued — and rejected before the converge seam is resolved, so a DR run
  // aborts with the primary still serving instead of quiescing it and only
  // discovering at "wait for the promoted API" that the amd64 app image cannot
  // exec on arm64 nodes.
  describe('ARM persisted worker spec', () => {
    it('aborts BEFORE any converge — nothing provisioned, nothing to revert', async () => {
      const converge = vi.fn(async () => ({ outputs: {} }));
      const kubectl = vi.fn();
      const err = await provisionStandbyCapacity({
        ...base,
        workerSpec: { count: 2, serverType: 'cax21' },
        deps: { converge, kubectl },
      }).catch((e) => e);

      expect(err).toBeInstanceOf(AbortProvisioningError);
      // The distinguishing property vs. the generic abort: ZERO converge calls,
      // so there is no up AND no revert.
      expect(converge).not.toHaveBeenCalled();
      expect(kubectl).not.toHaveBeenCalled();
    });

    it('names the source, a same-size x86 substitute, and the replace+restore fix', async () => {
      const err = await provisionStandbyCapacity({
        ...base,
        workerSpec: { count: 2, serverType: 'cax21' },
        deps: { converge: vi.fn(), kubectl: vi.fn() },
      }).catch((e) => e);

      const report = (err.logLines ?? []).join('\n');
      expect(report).toContain('ha.standbyWorkerSpec.serverType');
      // cax21 is 4 vCPU / 8 GB — the substitute must match it, not shrink to
      // a 2 GB catalog default. cpx32 (not cpx31): cax only ever existed in
      // the EU, where the whole cpx*1 line is unorderable since 2026-01-01.
      expect(report).toContain('cpx32');
      expect(report).not.toContain('cpx11');
      expect(report).toMatch(/vibecarbon failover e4 -server-type cpx32/);
      // Hetzner cannot rescale across architectures, so the durable fix is a
      // node replacement, not a resize.
      expect(report).toMatch(/restore/i);
    });

    it('an amd64 -server-type override unblocks the failover', async () => {
      const converge = vi.fn(async () => ({ outputs: {} }));
      await provisionStandbyCapacity({
        ...base,
        workerSpec: { count: 2, serverType: 'cax21' },
        serverTypeOverride: 'cpx31',
        deps: { converge, kubectl: readyKubectl(2) },
      });
      expect(converge).toHaveBeenCalledWith(
        expect.objectContaining({
          overrides: expect.objectContaining({ minWorkers: 2, workerServerType: 'cpx31' }),
        }),
      );
    });

    it('an ARM -server-type override is rejected too, and blamed on the flag', async () => {
      const converge = vi.fn();
      const err = await provisionStandbyCapacity({
        ...base,
        workerSpec: { count: 2, serverType: 'cx23' },
        serverTypeOverride: 'cax11',
        deps: { converge, kubectl: vi.fn() },
      }).catch((e) => e);

      expect(err).toBeInstanceOf(AbortProvisioningError);
      expect(converge).not.toHaveBeenCalled();
      const report = (err.logLines ?? []).join('\n');
      expect(report).toContain('-server-type');
      expect(report).not.toContain('standbyWorkerSpec');
    });
  });

  // The worker spec is one of THREE persisted types this function feeds to the
  // converge: `ha.standby.masterServerType` and `ha.standby.supabaseServerType`
  // land in the same `overrides` object and reach buildProgramConfig just as
  // verbatim. Guarding only the worker type held on a uniformly-ARM legacy env
  // (the worker guard fires first) but not on a hand-mixed one, so the stated
  // "no ARM type reaches Pulumi" invariant was two-thirds unenforced.
  describe('ARM persisted standby node types', () => {
    const withStandby = (extra: Record<string, string>) => ({
      ...base.envConfig,
      ha: { standby: { ...base.envConfig.ha.standby, ...extra } },
    });

    it.each([
      ['masterServerType', 'standby master', 'cax21', 'cpx32'],
      ['supabaseServerType', 'standby database', 'cax31', 'cpx42'],
    ])(
      'rejects an ARM %s before any converge, naming the key and an x86 equivalent',
      async (key, role, armType, suggestion) => {
        const converge = vi.fn(async () => ({ outputs: {} }));
        const err = await provisionStandbyCapacity({
          ...base,
          // x86 workers: this env is only reachable through the new assertions,
          // since the worker guard passes.
          workerSpec: { count: 2, serverType: 'cx23' },
          envConfig: withStandby({ [key]: armType }),
          deps: { converge, kubectl: vi.fn() },
        }).catch((e) => e);

        expect(err).toBeInstanceOf(AbortProvisioningError);
        expect(converge).not.toHaveBeenCalled();
        expect(err.message).toContain(role);
        const report = (err.logLines ?? []).join('\n');
        expect(report).toContain(`ha.standby.${key}`);
        // Same armToAmd64Equivalent behaviour as the worker path — by spec, not
        // by numeric suffix (cpx11 would be 2 GB, below the supported floor).
        expect(report).toContain(suggestion);
        expect(report).not.toContain('cpx11');
      },
    );

    it('does not offer -server-type as the fix for a node type it cannot override', async () => {
      const err = await provisionStandbyCapacity({
        ...base,
        workerSpec: { count: 2, serverType: 'cx23' },
        envConfig: withStandby({ masterServerType: 'cax21' }),
        deps: { converge: vi.fn(), kubectl: vi.fn() },
      }).catch((e) => e);

      const report = (err.logLines ?? []).join('\n');
      // Mid-outage, an operator must not be told to re-run with a flag that
      // overrides the WORKER type and would abort again identically.
      expect(report).not.toMatch(/Re-run with an explicit x86 worker type/);
      expect(report).toMatch(/cannot unblock this one/);
      expect(report).toMatch(/restore/i);
    });

    it('a mixed topology is caught even when the worker type is x86', async () => {
      const converge = vi.fn(async () => ({ outputs: {} }));
      const err = await provisionStandbyCapacity({
        ...base,
        serverTypeOverride: 'cpx31',
        envConfig: withStandby({ masterServerType: 'cpx31', supabaseServerType: 'cax41' }),
        deps: { converge, kubectl: readyKubectl(2) },
      }).catch((e) => e);

      expect(err).toBeInstanceOf(AbortProvisioningError);
      expect(err.message).toContain('standby database');
      expect(converge).not.toHaveBeenCalled();
    });

    it('all-x86 standby node types still converge normally', async () => {
      const converge = vi.fn(async () => ({ outputs: {} }));
      await provisionStandbyCapacity({
        ...base,
        envConfig: withStandby({ masterServerType: 'cpx31', supabaseServerType: 'cpx41' }),
        deps: { converge, kubectl: readyKubectl(2) },
      });
      expect(converge).toHaveBeenCalledWith(
        expect.objectContaining({
          overrides: expect.objectContaining({
            masterServerType: 'cpx31',
            supabaseServerType: 'cpx41',
          }),
        }),
      );
    });
  });

  it('revert failure reports leftover resources (stack + next command) and still throws', async () => {
    const kubectl = vi.fn();
    const converge = vi.fn().mockRejectedValue(new Error('resource_unavailable'));
    const err = await provisionStandbyCapacity({
      ...base,
      deps: { converge, kubectl },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AbortProvisioningError);
    expect(converge).toHaveBeenCalledTimes(2);
    const report = (err.logLines ?? []).join('\n');
    expect(report).toContain('e4-standby');
    expect(report).toMatch(/vibecarbon failover/);
    expect(report).toMatch(/vibecarbon destroy/);
    expect(kubectl).not.toHaveBeenCalled();
  });
});

describe('waitForWorkersReady', () => {
  it('resolves once the Ready worker count reaches the target', async () => {
    const responses = [readyLines(0), readyLines(1), readyLines(2)];
    let call = 0;
    const kubectl = vi.fn(async () => responses[Math.min(call++, responses.length - 1)]);
    const sleep = vi.fn(async () => {});

    const ready = await waitForWorkersReady('10.0.0.9', '/key', 2, { deps: { kubectl, sleep } });

    expect(ready).toBe(2);
    expect(kubectl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // Polls node list, no headers.
    expect(kubectl).toHaveBeenCalledWith(['get', 'nodes', '--no-headers']);
  });

  it('throws when the ready budget is exceeded', async () => {
    const kubectl = vi.fn(async () => readyLines(0));
    const sleep = vi.fn(async () => {});
    await expect(
      waitForWorkersReady('10.0.0.9', '/key', 2, { budgetMs: -1, deps: { kubectl, sleep } }),
    ).rejects.toThrow(/not Ready: 0\/2/);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('waitForStandbyCaughtUp (planned zero-data-loss gate)', () => {
  const servers = { primary: { ip: '10.0.0.1' }, standby: { ip: '10.0.0.9' } };
  const baseDeps = () => ({
    getPostgresPod: vi.fn(async () => 'supabase-supabase-db-0'),
    isStreaming: vi.fn(async () => true),
    sleep: vi.fn(async () => {}),
  });
  // kubectl stub: answers the primary's pg_current_wal_lsn() capture with
  // `primaryLsn`, and each standby pg_wal_lsn_diff(...) >= 0 check with the next
  // element of `standbyResponses` ('t' = caught up, 'f' = still lagging).
  const makeKubectl = (primaryLsn: string, standbyResponses: string[]) => {
    let i = 0;
    return vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      const sql = argv[argv.length - 1];
      if (sql === 'SELECT pg_current_wal_lsn()') return primaryLsn;
      return standbyResponses[Math.min(i++, standbyResponses.length - 1)];
    });
  };

  it('returns once the standby has replayed past the captured primary LSN', async () => {
    const deps = { ...baseDeps(), kubectl: makeKubectl('0/3000000', ['t']) };
    await expect(waitForStandbyCaughtUp(servers, '/key', { deps })).resolves.toBeUndefined();
    // Captured the primary target once, then a single standby check (no sleep).
    expect(deps.kubectl).toHaveBeenCalledTimes(2);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('polls while the standby lags, then returns when it catches up', async () => {
    const deps = { ...baseDeps(), kubectl: makeKubectl('0/3000000', ['f', 'f', 't']) };
    await expect(
      waitForStandbyCaughtUp(servers, '/key', { deps, intervalMs: 1 }),
    ).resolves.toBeUndefined();
    // 1 primary capture + 3 standby checks; slept between the 3 checks.
    expect(deps.kubectl).toHaveBeenCalledTimes(4);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it('throws when the standby never catches up within the attempt budget', async () => {
    const deps = { ...baseDeps(), kubectl: makeKubectl('0/3000000', ['f']) };
    await expect(
      waitForStandbyCaughtUp(servers, '/key', { deps, attempts: 3, intervalMs: 1 }),
    ).rejects.toThrow(/did not replay|zero-data-loss/i);
    expect(deps.sleep).toHaveBeenCalledTimes(2); // slept between attempts 1→2, 2→3
  });

  it('is N/A when the standby is not streaming (a full reseed copies all state)', async () => {
    const kubectl = vi.fn(async () => 't');
    const deps = {
      getPostgresPod: vi.fn(),
      isStreaming: vi.fn(async () => false),
      sleep: vi.fn(),
      kubectl,
    };
    await expect(waitForStandbyCaughtUp(servers, '/key', { deps })).resolves.toBeUndefined();
    // Returned before touching postgres — no LSN capture, no pod resolution.
    expect(kubectl).not.toHaveBeenCalled();
    expect(deps.getPostgresPod).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Task 10: failoverHA step order (quiesce-before-promote, persisted scale-up,
// terminal role-swap). Drives the exported orchestrator with injected step deps
// so no ssh / iac / config write ever runs — the closure-injection pattern from
// readiness-gate.test.ts, one level up.
// ============================================================================

/** Persisted scale-up list shape (Task 7): app + supabase-* + CA in kube-system. */
const SCALE_UP_LIST = [
  { name: 'app', namespace: 'vibecarbon', replicas: 2 },
  { name: 'supabase-supabase-auth', namespace: 'vibecarbon', replicas: 1 },
  { name: 'supabase-supabase-rest', namespace: 'vibecarbon', replicas: 1 },
  { name: 'cluster-autoscaler', namespace: 'kube-system', replicas: 1 },
];

interface RunOpts {
  primaryReachable: boolean;
  promoteThrows?: boolean;
  alreadyPromoted?: boolean;
  manualDns?: boolean;
  provisionThrows?: unknown;
  catchUpThrows?: boolean;
  /** The wal-g write-guard move could not be proven on the promoted cluster. */
  walgRoleFails?: boolean;
}

/**
 * Drive failoverHA with fully-injected step deps, returning the recorded step
 * order plus the arguments a few steps were called with. Each fake pushes a
 * canonical step name; scaleDeployments is disambiguated by its `label`.
 */
async function runFailoverHA(opts: RunOpts) {
  const {
    primaryReachable,
    promoteThrows = false,
    alreadyPromoted = false,
    manualDns = false,
    provisionThrows,
    catchUpThrows = false,
    walgRoleFails = false,
  } = opts;
  const order: string[] = [];
  let thrown: unknown;
  const captured: Record<string, unknown> = {};
  const servers = {
    primary: { ip: '10.0.0.1', floatingIp: '10.0.0.1', region: 'nbg1' },
    standby: { ip: '10.0.0.9', floatingIp: '10.0.0.99', supabaseIp: '10.0.0.10', region: 'ash' },
  };
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    order.push(`exit(${code})`);
    throw new Error('__exit__');
  }) as never);

  const deps = {
    identify: () => servers,
    getKeyPath: () => '/fake/key',
    keyExists: () => true,
    preflight: async () => {
      order.push('preflight');
      return {
        workerSpec: { count: 2, serverType: 'cx23' },
        scaleUpList: SCALE_UP_LIST,
        standbyStack: 'e4-standby',
        creds: { apiToken: 'threaded-token' },
      };
    },
    provision: async (a: { deps?: { creds?: unknown } }) => {
      captured.provisionCreds = a?.deps?.creds;
      order.push('provision');
      if (provisionThrows) throw provisionThrows;
      return { provisioned: true as const };
    },
    isPrimaryReady: async () => primaryReachable,
    catchUp: async () => {
      order.push('catchup');
      if (catchUpThrows) {
        throw new Error("standby did not replay the primary's final WAL — aborting failover");
      }
    },
    scale: async (_ip: string, _key: string, list: unknown, replicas: unknown, label: string) => {
      if (/un-quiesce/.test(label)) order.push('unquiesce');
      else if (/^quiesce primary/.test(label)) order.push('quiesce');
      else if (/scale up promoted/.test(label)) {
        order.push('scaleUp');
        captured.scaleUp = { list, replicas };
      } else if (/scale-down old primary/.test(label)) {
        order.push('scaleDownOldPrimary');
        captured.scaleDown = { list, replicas };
      }
    },
    reseedPromote: async () => {
      if (alreadyPromoted) {
        order.push('alreadyPromoted');
        return { alreadyPromoted: true as const };
      }
      if (primaryReachable) order.push('reseed');
      if (promoteThrows) throw new Error('promotion could not be confirmed — aborting failover');
      order.push('promote');
      return undefined;
    },
    restoreWalgRole: async (a: { promotedIp: string; oldPrimaryIp: string }) => {
      captured.walgRoleArgs = a;
      order.push('walgRole');
      return walgRoleFails
        ? { ok: false as const, error: new Error('wal-g audit: stale standby write-guard') }
        : { ok: true as const };
    },
    gate: async (
      _domain: string,
      _ip: string,
      _key: string,
      _s: unknown,
      gopts: { scaleUpList?: unknown },
    ) => {
      captured.gateScaleUpList = gopts?.scaleUpList;
      order.push('rollout');
      order.push('apiProbe');
    },
    swapRoles: (envName: string) => {
      captured.swapEnv = envName;
      order.push('saveConfig');
    },
  };

  const strategy = manualDns
    ? {}
    : {
        getAuth: async () => ({ token: 't', zoneId: 'z' }),
        updateDns: async () => {
          order.push('dns');
        },
      };

  const envConfig = {
    domain: 'app.example.com',
    region: 'nbg1',
    secondaryRegion: 'ash',
    ha: { primary: { masterIp: '10.0.0.1' }, standby: { masterIp: '10.0.0.9' } },
  };
  const parsed = { dryRun: false, yes: true, serverType: null };
  const tracker = { spinner: () => ({ start: () => {}, stop: () => {} }) };

  try {
    // biome-ignore lint/suspicious/noExplicitAny: injected test deps bag.
    await failoverHA('e4', envConfig, {}, parsed, tracker, strategy, deps as any);
  } catch (err) {
    /* abort paths throw / process.exit — the order array is already recorded */
    thrown = err;
  } finally {
    exitSpy.mockRestore();
  }
  return { order, captured, thrown };
}

describe('failoverHA step order', () => {
  it('planned mode: provision → quiesce → catch-up → reseed+promote → walg-role → scale-up → gate → dns → persist swap', async () => {
    const { order } = await runFailoverHA({ primaryReachable: true });
    expect(order).toEqual([
      'preflight',
      'provision',
      'quiesce',
      'catchup',
      'reseed',
      'promote',
      'walgRole',
      'scaleUp',
      'rollout',
      'apiProbe',
      'dns',
      'saveConfig',
    ]);
    // The wal-g write-guard moves onto the promoted cluster BETWEEN promotion
    // and scale-up: the env change rolls the db pod, and the app tier is still
    // at zero replicas there, so the roll disturbs no traffic. After scale-up it
    // would bounce the database under a live app tier instead.
    expect(order.indexOf('promote')).toBeLessThan(order.indexOf('walgRole'));
    expect(order.indexOf('walgRole')).toBeLessThan(order.indexOf('scaleUp'));
    // TRUE zero-data-loss upgrade: the primary app tier is quiesced BEFORE the
    // standby is promoted, and the catch-up gate sits BETWEEN quiesce and
    // promote so no committed write can be left unreplayed at promotion.
    expect(order.indexOf('quiesce')).toBeLessThan(order.indexOf('catchup'));
    expect(order.indexOf('catchup')).toBeLessThan(order.indexOf('promote'));
    // No standalone scale-down in planned mode — the quiesce already stopped it.
    expect(order).not.toContain('scaleDownOldPrimary');
  });

  it('unplanned mode: no quiesce, no reseed; scale-down old primary is best-effort before dns', async () => {
    const { order } = await runFailoverHA({ primaryReachable: false });
    expect(order).not.toContain('quiesce');
    // The zero-data-loss catch-up gate is planned-only (needs a queryable
    // primary) — an unplanned failover skips it.
    expect(order).not.toContain('catchup');
    expect(order).not.toContain('reseed');
    // Split-brain prevention still runs, but AFTER the gate and BEFORE dns.
    expect(order.indexOf('scaleDownOldPrimary')).toBeGreaterThan(order.indexOf('apiProbe'));
    expect(order.indexOf('scaleDownOldPrimary')).toBeLessThan(order.indexOf('dns'));
    expect(order.indexOf('promote')).toBeLessThan(order.indexOf('scaleUp'));
  });

  // The bug this guards: failover swapped ha.primary↔ha.standby in the project
  // config but nothing re-rendered WALG_ROLE, so the promoted cluster kept the
  // standby write-guard and its base backups (and, once the k8s archive wrapper
  // carries the same guard, its WAL) silently stopped.
  it('moves the wal-g write-guard onto the promoted cluster and demotes the old primary', async () => {
    const { order, captured } = await runFailoverHA({ primaryReachable: true });
    expect(order).toContain('walgRole');
    expect(captured.walgRoleArgs).toMatchObject({
      promotedIp: '10.0.0.9', // the standby that was just promoted
      oldPrimaryIp: '10.0.0.1',
    });
  });

  it('a wal-g write-guard failure completes the failover but fails the command', async () => {
    const { order, thrown } = await runFailoverHA({ primaryReachable: true, walgRoleFails: true });
    // Everything after the failed step still runs — aborting post-promotion
    // would strand a promoted cluster behind un-flipped DNS.
    expect(order).toContain('scaleUp');
    expect(order).toContain('dns');
    expect(order).toContain('saveConfig');
    // …but the command must not report success.
    expect((thrown as Error)?.message).toMatch(/FAILOVER COMPLETED, BACKUPS DID NOT/);
    // The throw is TERMINAL: it comes after the persisted role swap, never before.
    expect(order[order.length - 1]).toBe('saveConfig');
  });

  it('a healthy wal-g write-guard move leaves the failover clean (no throw)', async () => {
    const { thrown } = await runFailoverHA({ primaryReachable: true });
    expect(thrown).toBeUndefined();
  });

  it('promote failure in planned mode un-quiesces the primary and aborts (no dns, no swap, no scale-up)', async () => {
    const { order } = await runFailoverHA({ primaryReachable: true, promoteThrows: true });
    // The aborted planned failover must NOT leave the primary quiesced.
    expect(order).toContain('unquiesce');
    expect(order.indexOf('unquiesce')).toBeGreaterThan(order.indexOf('quiesce'));
    // Nothing past the promote ran: no scale-up, no gate, no dns, no swap.
    expect(order).not.toContain('scaleUp');
    expect(order).not.toContain('dns');
    expect(order).not.toContain('saveConfig');
  });

  it('catch-up timeout in planned mode un-quiesces the primary and aborts (no promote/scale/dns/swap)', async () => {
    const { order } = await runFailoverHA({ primaryReachable: true, catchUpThrows: true });
    // The gate ran and threw; the aborted planned failover must NOT leave the
    // primary quiesced.
    expect(order).toContain('catchup');
    expect(order).toContain('unquiesce');
    expect(order.indexOf('unquiesce')).toBeGreaterThan(order.indexOf('quiesce'));
    // Nothing past the gate ran: no reseed/promote, no scale-up, no dns, no swap.
    expect(order).not.toContain('promote');
    expect(order).not.toContain('scaleUp');
    expect(order).not.toContain('dns');
    expect(order).not.toContain('saveConfig');
  });

  it('already-promoted standby (convergent rerun): reseed AND promote skipped, later steps still run', async () => {
    const { order } = await runFailoverHA({ primaryReachable: true, alreadyPromoted: true });
    expect(order).not.toContain('reseed');
    expect(order).not.toContain('promote');
    // The rest of the flow is convergent and still executes.
    expect(order).toContain('scaleUp');
    expect(order).toContain('dns');
    expect(order).toContain('saveConfig');
  });

  it('scale-up uses the persisted list (with namespaces, CA in kube-system), not a hardcoded list', async () => {
    const { captured } = await runFailoverHA({ primaryReachable: true });
    const scaleUp = captured.scaleUp as { list: typeof SCALE_UP_LIST; replicas: unknown };
    expect(scaleUp.list).toBe(SCALE_UP_LIST);
    expect(scaleUp.replicas).toBe('up');
    expect(scaleUp.list.find((d) => d.name === 'cluster-autoscaler')?.namespace).toBe(
      'kube-system',
    );
    // The readiness gate receives the same persisted list to rollout-status each.
    expect(captured.gateScaleUpList).toBe(SCALE_UP_LIST);
  });

  it('threads preflight-resolved creds into provisioning (single S3 prompt per failover)', async () => {
    const { captured } = await runFailoverHA({ primaryReachable: true });
    expect(captured.provisionCreds).toEqual({ apiToken: 'threaded-token' });
  });

  it('provisioning abort is a clean exit: primary untouched, no promote/scale/dns/swap', async () => {
    const { order } = await runFailoverHA({
      primaryReachable: true,
      provisionThrows: new AbortProvisioningError('boom', { logLines: ['leftover'] }),
    });
    expect(order).toEqual(['preflight', 'provision', 'exit(1)']);
  });

  it('persists the role swap only at the very end (after dns)', async () => {
    const { order, captured } = await runFailoverHA({ primaryReachable: true });
    expect(order[order.length - 1]).toBe('saveConfig');
    expect(order.indexOf('saveConfig')).toBeGreaterThan(order.indexOf('dns'));
    expect(captured.swapEnv).toBe('e4');
  });
});

describe('preflightPilotFailover exit branches', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits(1) when the pilot-light config is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    // No ha.standbyWorkerSpec / scaleUpList / standby.stack → config-presence gate.
    await expect(preflightPilotFailover('e4', { ha: {} })).rejects.toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits(1) when the standby stack state backend is unreachable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    const envConfig = {
      s3: { bucket: 'b' },
      ha: {
        standbyWorkerSpec: { count: 2, serverType: 'cx23' },
        scaleUpList: SCALE_UP_LIST,
        standby: { stack: 'e4-standby' },
      },
    };
    await expect(
      preflightPilotFailover('e4', envConfig, {
        resolveCreds: async () => ({ apiToken: 't', s3Creds: null }),
        readStackOutputs: async () => {
          throw new Error('state backend unreachable');
        },
      }),
    ).rejects.toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('returns the persisted pieces + resolved creds on a reachable backend', async () => {
    const creds = { apiToken: 't', s3Creds: null, Provider: {} };
    const out = await preflightPilotFailover(
      'e4',
      {
        ha: {
          standbyWorkerSpec: { count: 2, serverType: 'cx23' },
          scaleUpList: SCALE_UP_LIST,
          standby: { stack: 'e4-standby' },
        },
      },
      {
        resolveCreds: async () => creds,
        readStackOutputs: async () => ({ workerIps: [] }),
      },
    );
    expect(out).toMatchObject({ standbyStack: 'e4-standby', scaleUpList: SCALE_UP_LIST, creds });
  });
});

describe('swapHaRoles', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('swaps stacks + regions wholesale, flags degraded, preserves scale config', () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-swap-'));
    const config = {
      projectName: 'proj',
      environments: {
        e4: {
          region: 'nbg1',
          secondaryRegion: 'ash',
          replication: 'streaming',
          degraded: false,
          ha: {
            enabled: true,
            failoverRegion: 'ash',
            primary: { masterIp: '10.0.0.1', region: 'nbg1', stack: 'e4-primary' },
            standby: { masterIp: '10.0.0.9', region: 'ash', stack: 'e4-standby' },
            standbyWorkerSpec: { count: 2, serverType: 'cx23' },
            scaleUpList: SCALE_UP_LIST,
          },
        },
      },
    };
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(config));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    swapHaRoles('e4');

    const out = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8'));
    const env = out.environments.e4;
    // Primary/standby objects swapped wholesale (stack fields ride along).
    expect(env.ha.primary.stack).toBe('e4-standby');
    expect(env.ha.standby.stack).toBe('e4-primary');
    // Top-level regions swapped.
    expect(env.region).toBe('ash');
    expect(env.secondaryRegion).toBe('nbg1');
    // Honest DR posture until a reconverge deploy re-establishes streaming.
    expect(env.replication).toBe('degraded');
    expect(env.degraded).toBe(true);
    // Role-agnostic pilot-light config is preserved untouched.
    expect(env.ha.standbyWorkerSpec).toEqual({ count: 2, serverType: 'cx23' });
    expect(env.ha.scaleUpList).toEqual(SCALE_UP_LIST);
  });
});
