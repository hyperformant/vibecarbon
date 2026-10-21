/**
 * Failover state matrix (HA-correctness Task 1, C1 + M3).
 *
 * The k8s-HA failover used to treat "the standby is not in recovery" as "a
 * previous run already promoted it". That one inference let three different
 * worlds promote stale or empty data, flip DNS and exit 0:
 *   - a failback right after a failover, before `vibecarbon deploy`
 *     reconverged (the "standby" is the old primary, holding no replica of
 *     the new data);
 *   - an unseeded standby finalized under `-allow-degraded` (a fresh initdb,
 *     a different database);
 *   - a retry after a promote that landed late, once the first run had
 *     already un-quiesced the old primary.
 *
 * Every promote decision now reads a persisted journal and a positive replica
 * proof (R1, R2), and an unconfirmed promote keeps the old primary fenced (R3).
 * This file drives `failoverHA` through each state with injected seams, so no
 * ssh, iac or config write runs; the journal helpers and the tri-state promote
 * are exercised on their own below.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real config writers (journal, proof, fence marker) run in these tests
// against no project: point them at an empty dir, never the repo root, where
// they would take the real config lock.
const noProjectDir = mkdtempSync(join(tmpdir(), 'vc-no-project-'));
beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(noProjectDir);
});

// The first base backup on the new timeline has its own tests
// (tests/unit/walg/post-promote-backup-census.test.ts, the step-order census);
// here it lands.
vi.mock('../../../src/lib/walg/post-promote-backup.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  pushBaseBackupAfterPromote: vi.fn(async () => ({ name: 'base_000000020000000000000004' })),
}));

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  getPostgresPod: vi.fn(async () => 'db-0'),
  sshKubectl: vi.fn(),
}));

const ssh = await import('../../../src/lib/ssh.js');
const { confirmUnprovenFailover, failoverHA, swapHaRoles } = await import(
  '../../../src/failover.js'
);
const {
  assertFailoverPreconditions,
  clearFailoverJournal,
  FailoverRefusedError,
  readReplicaState,
  writeFailoverJournal,
} = await import('../../../src/lib/deploy/failover-guard.js');
const { liftStrandedWriteFence } = await import('../../../src/lib/deploy/write-fence.js');
const { PROMOTE_DEADLINE_MS, promoteStandby } = await import(
  '../../../src/lib/deploy/replication.js'
);

const SYSID = '7412345678901234567';
const OTHER_SYSID = '7499999999999999999';

const SCALE_UP_LIST = [{ name: 'app', namespace: 'vibecarbon', replicas: 2 }];

type StandbyState = {
  inRecovery: boolean | null;
  systemIdentifier: string | null;
  replayLsn: string | null;
  receiverStatus: string | null;
  lastMsgAgeS: number | null;
};

const streamingStandby = (over: Partial<StandbyState> = {}): StandbyState => ({
  inRecovery: true,
  systemIdentifier: SYSID,
  replayLsn: '0/3000060',
  receiverStatus: 'streaming',
  lastMsgAgeS: 1,
  ...over,
});

const baseEnvConfig = (over: Record<string, unknown> = {}) => ({
  domain: 'app.example.com',
  region: 'nbg1',
  secondaryRegion: 'ash',
  replication: 'streaming',
  deployedAt: '2026-10-01T00:00:00.000Z',
  ...over,
  ha: {
    primary: { masterIp: '10.0.0.1' },
    standby: { masterIp: '10.0.0.9' },
    systemIdentifier: SYSID,
    ...((over.ha as Record<string, unknown>) ?? {}),
  },
});

interface RunOpts {
  primaryReachable?: boolean;
  standbyState?: StandbyState;
  primaryState?: StandbyState;
  envConfig?: Record<string, unknown>;
  /** The promote seam throws instead of returning a verdict. */
  promoteThrows?: boolean;
  /** What the promote seam resolves to. */
  promoteVerdict?: 'promoted' | 'not-issued' | 'unknown';
  /** Flags as parsed from the command line (-force-unproven, -allow-degraded, -y). */
  flags?: { forceUnproven?: boolean; allowDegraded?: boolean; yes?: boolean };
  /** The system identifier the reseed seam reports through onSeeded (null: no reseed ran). */
  seededSysid?: string | null;
  /** The catch-up gate throws (a streaming standby missed the deadline). */
  catchUpThrows?: boolean;
  /** What the catch-up gate reports (default: caught up). */
  caughtUp?: boolean;
  /** The quiesced pods never go away. */
  quiesceUnconfirmed?: boolean;
  /** The database write fence cannot be proven. */
  fenceThrows?: boolean;
  /** The reseeded standby still carries the fence. */
  standbyFenced?: boolean;
  /** The provider write throws. */
  dnsUpdateThrows?: boolean;
  /** What the provider reads back after the write (default: the flipped IP). */
  dnsReadsBack?: string[];
  /** What the wildcard reads back, when it differs from the apex. */
  wildcardReadsBack?: string[];
}

/**
 * Drive failoverHA with every step seam injected, recording each call as a
 * canonical step name. Mutating steps are the ones a refusal must never reach:
 * provision, quiesce, unquiesce, reseed, journal, promote, walgRole, scaleUp,
 * promoteIssuer, scaleDownOldPrimary, dns, saveConfig.
 */
async function run(opts: RunOpts = {}) {
  const {
    primaryReachable = true,
    // A dead primary stops streaming; one still streaming fresh WAL is alive
    // (R8, classify-failover.test.ts), so unplanned rows default to no receiver.
    standbyState = primaryReachable
      ? streamingStandby()
      : streamingStandby({ receiverStatus: null, lastMsgAgeS: null }),
    primaryState = streamingStandby({ inRecovery: false, receiverStatus: null }),
    envConfig = baseEnvConfig(),
    promoteVerdict = 'promoted',
    promoteThrows = false,
    flags = {},
    seededSysid = null,
    catchUpThrows = false,
    caughtUp = true,
    quiesceUnconfirmed = false,
    fenceThrows = false,
    standbyFenced = false,
    dnsUpdateThrows = false,
    dnsReadsBack,
    wildcardReadsBack,
  } = opts;
  const order: string[] = [];
  const captured: Record<string, unknown> = {};
  let thrown: unknown;
  const servers = {
    primary: { ip: '10.0.0.1', floatingIp: '10.0.0.1', region: 'nbg1' },
    standby: {
      ip: '10.0.0.9',
      floatingIp: '10.0.0.99',
      dbIp: '10.0.0.10',
      dbPrivateIp: '10.0.1.2',
      region: 'ash',
    },
  };
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    order.push(`exit(${code})`);
    throw new Error('__exit__');
  }) as never);

  const deps = {
    identify: () => servers,
    getKeyPath: () => '/fake/key',
    keyExists: () => true,
    confirmUnproven: async () => {
      order.push('confirmUnproven');
    },
    preflight: async () => {
      order.push('preflight');
      return {
        workerSpec: { count: 2, serverType: 'cx23' },
        scaleUpList: SCALE_UP_LIST,
        standbyStack: 'e4-standby',
        creds: {},
      };
    },
    provision: async () => {
      order.push('provision');
      return { provisioned: true as const };
    },
    isPrimaryReady: async () => primaryReachable,
    readStandbyState: async () => standbyState,
    readPrimaryState: async () => {
      order.push('readPrimary');
      return primaryState;
    },
    catchUp: async () => {
      order.push('catchup');
      if (catchUpThrows) throw new Error('zero-data-loss gate: the standby did not replay');
      return { caughtUp, lagBytes: caughtUp ? 0 : null, primaryLsn: '0/3000060' };
    },
    confirmQuiesced: async () => {
      order.push('quiesceConfirmed');
      return quiesceUnconfirmed
        ? { ok: false, remaining: ['app'] }
        : { ok: true, remaining: [] as string[] };
    },
    fenceWrites: async () => {
      order.push('dbFence');
      if (fenceThrows) throw new Error('write fence: 1 client session(s) outlived it');
    },
    unfenceWrites: async () => {
      order.push('dbUnfence');
      return true;
    },
    writeMarker: (_ctx: unknown, m: { node: string; ip: string }) => {
      order.push('marker');
      captured.marker = m;
    },
    clearMarker: () => {
      order.push('clearMarker');
    },
    liftStranded: (o: Parameters<typeof liftStrandedWriteFence>[0]) =>
      liftStrandedWriteFence({
        ...o,
        deps: {
          unfence: async () => {
            order.push('liftStranded');
            return true;
          },
          clearMarker: () => {
            order.push('clearMarker');
          },
        },
      }),
    psql: () => async () => '',
    assertUnfenced: async () => {
      order.push('assertUnfenced');
      if (standbyFenced) throw new Error('the reseeded standby carries the write fence');
    },
    scale: async (_ip: string, _key: string, _list: unknown, _replicas: unknown, label: string) => {
      if (/un-quiesce/.test(label)) order.push('unquiesce');
      else if (/^quiesce primary/.test(label)) order.push('quiesce');
      else if (/scale up promoted/.test(label)) order.push('scaleUp');
      else if (/scale-down old primary/.test(label)) order.push('scaleDownOldPrimary');
    },
    reseed: async (
      _srv: unknown,
      _key: unknown,
      _s: unknown,
      o: { onSeeded?: (sysid: string) => void; mustReseed?: boolean },
    ) => {
      order.push('reseed');
      captured.mustReseed = o?.mustReseed;
      if (seededSysid) o?.onSeeded?.(seededSysid);
    },
    writeJournal: async (_ctx: unknown, journal: Record<string, unknown>) => {
      captured.journal = journal;
      order.push('journal');
      return 'journal-id';
    },
    clearJournal: async () => {
      order.push('clearJournal');
    },
    promote: async () => {
      order.push('promote');
      if (promoteThrows) throw new Error('kubectl exec failed');
      return promoteVerdict;
    },
    restoreWalgRole: async () => {
      order.push('walgRole');
      return { promoted: { ok: true as const }, demoted: { ok: true as const } };
    },
    gate: async () => {
      order.push('gate');
    },
    promoteIssuer: async () => {
      order.push('promoteIssuer');
      return { patched: [] };
    },
    swapRoles: (_env: string, o?: { override?: string }) => {
      captured.swapOverride = o?.override;
      order.push('saveConfig');
    },
    // The backup-prefix fence write (backup-fence.test.ts pins its place).
    writeFence: async () => ({ ok: true }),
    recordFence: () => {},
    reconcileRetired: async () => {
      order.push('fenceRetired');
      return { fenced: [], unreachable: [] };
    },
  };
  let flippedTo: string | null = null;
  const strategy = {
    getAuth: async () => ({ token: 't', zoneId: 'z' }),
    updateDns: async (_auth: unknown, _domain: string, ip: string) => {
      order.push('dns');
      if (dnsUpdateThrows) throw new Error('Failed to create DNS record (HTTP 403)');
      flippedTo = ip;
    },
    readDns: async (_auth: unknown, name: string) => {
      if (name.startsWith('*.') && wildcardReadsBack) return wildcardReadsBack;
      return dnsReadsBack === undefined ? (flippedTo ? [flippedTo] : []) : dnsReadsBack;
    },
  };
  const parsed = { dryRun: false, yes: true, serverType: null, ...flags };
  const tracker = { spinner: () => ({ start: () => {}, stop: () => {} }) };
  try {
    // biome-ignore lint/suspicious/noExplicitAny: injected test deps bag.
    await failoverHA('e4', envConfig, {}, parsed, tracker, strategy, deps as any);
  } catch (err) {
    thrown = err;
  } finally {
    exitSpy.mockRestore();
  }
  return { order, captured, thrown: thrown as Error | undefined };
}

/** Steps a refusal must never reach: any quiesce, kubectl write or cloud change. */
const MUTATIONS = [
  'provision',
  'quiesce',
  'dbFence',
  'dbUnfence',
  'unquiesce',
  'reseed',
  'journal',
  'promote',
  'walgRole',
  'scaleUp',
  'promoteIssuer',
  'scaleDownOldPrimary',
  'dns',
  'saveConfig',
  'fenceRetired',
];
function expectNoMutation(order: string[]) {
  for (const step of MUTATIONS) expect(order, `refusal reached ${step}`).not.toContain(step);
}

describe('failoverHA state matrix', () => {
  afterEach(() => vi.restoreAllMocks());

  it('planned: quiesce, proven pods gone, then the database fence, all before the catch-up gate', async () => {
    const { order, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(order.indexOf('quiesce')).toBeLessThan(order.indexOf('quiesceConfirmed'));
    expect(order.indexOf('quiesceConfirmed')).toBeLessThan(order.indexOf('dbFence'));
    expect(order.indexOf('dbFence')).toBeLessThan(order.indexOf('catchup'));
    expect(order).not.toContain('dbUnfence');
  });

  it('an unconfirmed quiesce aborts before the database fence and the gate, and lifts it on a first run', async () => {
    const { order, thrown } = await run({ quiesceUnconfirmed: true });
    expect(thrown?.message).toMatch(/quiesced app tier on the primary did not stop/);
    expect(thrown?.message).toContain('rerun vibecarbon failover e4');
    expect(order).not.toContain('dbFence');
    expect(order).not.toContain('dbUnfence');
    expect(order).not.toContain('catchup');
    expect(order).not.toContain('promote');
    expect(order).toContain('unquiesce');
  });

  it('a database fence that cannot be proven aborts and lifts the fence (database first) on a first run', async () => {
    const { order, thrown } = await run({ fenceThrows: true });
    expect(thrown?.message).toMatch(/^Failover aborted: write fence/);
    expect(order).not.toContain('catchup');
    expect(order.indexOf('dbUnfence')).toBeLessThan(order.indexOf('unquiesce'));
  });

  it('the fence is recorded before it is applied; a first-run abort clears it after the un-fence', async () => {
    const { order, captured } = await run({ catchUpThrows: true });
    expect(captured.marker).toEqual({ node: '10.0.0.1', ip: '10.0.0.1' });
    expect(order.indexOf('quiesceConfirmed')).toBeLessThan(order.indexOf('marker'));
    expect(order.indexOf('marker')).toBeLessThan(order.indexOf('dbFence'));
    expect(order.indexOf('clearMarker')).toBeGreaterThan(order.indexOf('dbUnfence'));
  });

  it('SIGINT-equivalent rerun (marker, no journal): lifts the stranded fence first, then fails over', async () => {
    const { order, thrown } = await run({
      envConfig: baseEnvConfig({
        ha: { writeFence: { node: '10.0.0.1', ip: '10.0.0.1', at: 'x' } },
      }),
    });
    expect(thrown).toBeUndefined();
    expect(order.indexOf('liftStranded')).toBeLessThan(order.indexOf('quiesce'));
    expect(order.indexOf('clearMarker')).toBeLessThan(order.indexOf('marker'));
    expect(order).toContain('promote');
  });

  it('rerun with a marker and a journal: left to the journal flow, no lift', async () => {
    const { order } = await run({
      envConfig: baseEnvConfig({
        ha: {
          writeFence: { node: '10.0.0.1', ip: '10.0.0.1', at: 'x' },
          failoverInFlight: { target: 'standby', systemIdentifier: SYSID },
        },
      }),
    });
    expect(order).not.toContain('liftStranded');
  });

  it('journal at entry + catch-up throws: the primary stays quiesced and fenced', async () => {
    const { order, thrown } = await run({
      catchUpThrows: true,
      envConfig: baseEnvConfig({
        ha: { failoverInFlight: { target: 'standby', systemIdentifier: SYSID } },
      }),
    });
    expect(thrown?.message).toMatch(/zero-data-loss gate/);
    expect(order).not.toContain('unquiesce');
    expect(order).not.toContain('dbUnfence');
    expect(order).not.toContain('promote');
  });

  it('first run + catch-up throws: un-fences the database, then un-quiesces', async () => {
    const { order, thrown } = await run({ catchUpThrows: true });
    expect(thrown?.message).toMatch(/zero-data-loss gate/);
    expect(order.indexOf('dbUnfence')).toBeLessThan(order.indexOf('unquiesce'));
  });

  it('a standby the gate found not streaming must be reseeded, and the reseed is proven free of the fence', async () => {
    const { order, captured, thrown } = await run({ caughtUp: false, seededSysid: SYSID });
    expect(thrown).toBeUndefined();
    expect(captured.mustReseed).toBe(true);
    expect(order.indexOf('reseed')).toBeLessThan(order.indexOf('assertUnfenced'));
    expect(order.indexOf('assertUnfenced')).toBeLessThan(order.indexOf('journal'));
  });

  it('a reseeded standby that still carries the fence aborts before the journal', async () => {
    const { order, thrown } = await run({
      caughtUp: false,
      seededSysid: SYSID,
      standbyFenced: true,
    });
    expect(thrown?.message).toMatch(/carries the write fence/);
    expect(order).not.toContain('journal');
    expect(order).not.toContain('promote');
    expect(order).toContain('unquiesce');
  });

  it('a proven replica (in recovery, sysid matches, not degraded) promotes; journal first, cleared by the swap save', async () => {
    const { order, captured, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(order).toContain('promote');
    // The journal is written immediately before the promote seam ...
    expect(order.indexOf('journal')).toBe(order.indexOf('promote') - 1);
    expect(captured.journal).toEqual({
      target: 'standby',
      primaryLsn: '0/3000060',
      systemIdentifier: SYSID,
    });
    // ... and cleared by the terminal swap save, not by a separate write.
    expect(order).not.toContain('clearJournal');
    // Only the retired side's fence follows: it needs the swap saved.
    expect(order.slice(-2)).toEqual(['saveConfig', 'fenceRetired']);
  });

  it('out of recovery with a journal naming this target resumes: no reseed, no promote; DNS and swap run', async () => {
    const { order, thrown } = await run({
      standbyState: streamingStandby({ inRecovery: false, receiverStatus: null }),
      envConfig: baseEnvConfig({
        ha: {
          failoverInFlight: {
            id: 'j1',
            target: 'standby',
            startedAt: '2026-10-20T10:00:00.000Z',
            primaryLsn: '0/3000060',
            systemIdentifier: SYSID,
          },
        },
      }),
    });
    expect(thrown).toBeUndefined();
    expect(order).not.toContain('reseed');
    expect(order).not.toContain('promote');
    expect(order).not.toContain('journal');
    // A resumed run never un-fences the old primary: the standby is promoted.
    expect(order).not.toContain('unquiesce');
    expect(order).toContain('dns');
    expect(order).toContain('saveConfig');
  });

  it('out of recovery with no journal refuses as "not a replica", before any quiesce or write', async () => {
    const { order, thrown } = await run({
      standbyState: streamingStandby({ inRecovery: false, receiverStatus: null }),
    });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/not a replica/);
    expect(thrown?.message).toMatch(/vibecarbon deploy/);
    expectNoMutation(order);
  });

  it('replication degraded refuses before quiesce', async () => {
    const { order, thrown } = await run({
      envConfig: baseEnvConfig({ replication: 'degraded', degraded: true }),
    });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/degraded/);
    expect(thrown?.message).toMatch(/vibecarbon deploy/);
    expectNoMutation(order);
  });

  it('a failback before reconverge (roles swapped since the last deploy) refuses and names vibecarbon deploy', async () => {
    const { order, thrown } = await run({
      // The state a completed failover leaves behind: lastFailover after the
      // last deploy. swapHaRoles also flags replication degraded; the failback
      // reason must win, because it is the precise one.
      envConfig: baseEnvConfig({
        lastFailover: '2026-10-20T12:00:00.000Z',
        deployedAt: '2026-10-01T00:00:00.000Z',
        replication: 'degraded',
      }),
      standbyState: streamingStandby({ inRecovery: false, receiverStatus: null }),
    });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/vibecarbon deploy/);
    expect(thrown?.message).toMatch(/failover/);
    expectNoMutation(order);
  });

  it('a failover after a reconverging deploy is not a failback', async () => {
    const { thrown, order } = await run({
      envConfig: baseEnvConfig({
        lastFailover: '2026-10-20T12:00:00.000Z',
        deployedAt: '2026-10-20T13:00:00.000Z',
      }),
    });
    expect(thrown).toBeUndefined();
    expect(order).toContain('promote');
  });

  it('a system identifier mismatch refuses as "different database"', async () => {
    const { order, thrown } = await run({
      standbyState: streamingStandby({ systemIdentifier: OTHER_SYSID }),
    });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/different database/);
    expectNoMutation(order);
  });

  it('no recorded system identifier refuses an unplanned failover', async () => {
    const envConfig = baseEnvConfig();
    delete (envConfig.ha as Record<string, unknown>).systemIdentifier;
    const { order, thrown } = await run({ primaryReachable: false, envConfig });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/vibecarbon deploy/);
    expectNoMutation(order);
  });

  it('no recorded system identifier, planned with a streaming standby: allowed, compared live against the primary', async () => {
    const envConfig = baseEnvConfig();
    delete (envConfig.ha as Record<string, unknown>).systemIdentifier;
    const { order, thrown } = await run({ primaryReachable: true, envConfig });
    expect(thrown).toBeUndefined();
    expect(order).toContain('readPrimary');
    expect(order.indexOf('readPrimary')).toBeLessThan(order.indexOf('quiesce'));
    expect(order).toContain('promote');
  });

  it('no recorded system identifier, planned, the live primary differs: refuses as "different database"', async () => {
    const envConfig = baseEnvConfig();
    delete (envConfig.ha as Record<string, unknown>).systemIdentifier;
    const { order, thrown } = await run({
      primaryReachable: true,
      envConfig,
      primaryState: streamingStandby({ inRecovery: false, systemIdentifier: OTHER_SYSID }),
    });
    expect(thrown?.message).toMatch(/different database/);
    expectNoMutation(order);
  });

  it('an unreadable standby refuses (fence on unknown), before any write', async () => {
    const { order, thrown } = await run({
      standbyState: {
        inRecovery: null,
        systemIdentifier: null,
        replayLsn: null,
        receiverStatus: null,
        lastMsgAgeS: null,
      },
    });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/vibecarbon deploy/);
    expectNoMutation(order);
  });

  it("promote 'unknown' keeps the old primary fenced and the journal set", async () => {
    const { order, thrown } = await run({ promoteVerdict: 'unknown' });
    expect(order).toContain('quiesce');
    expect(order).toContain('promote');
    expect(order.filter((s) => s === 'unquiesce')).toHaveLength(0);
    expect(order).not.toContain('clearJournal');
    expect(thrown?.message).toMatch(/kept fenced/);
    expect(thrown?.message).toMatch(/rerun vibecarbon failover e4 to finish/);
    // Nothing past the promote ran on an unconfirmed promotion.
    expect(order).not.toContain('scaleUp');
    expect(order).not.toContain('dns');
    expect(order).not.toContain('saveConfig');
  });

  it("first run, promote 'not-issued': un-quiesces, clears the journal and exits with the cause", async () => {
    const { order, thrown } = await run({ promoteVerdict: 'not-issued' });
    expect(order.filter((st) => st === 'unquiesce')).toHaveLength(1);
    expect(order).toContain('clearJournal');
    expect(order.indexOf('clearJournal')).toBeGreaterThan(order.indexOf('promote'));
    expect(thrown?.message).toMatch(/no promote was sent/);
    expect(order).not.toContain('dns');
    expect(order).not.toContain('saveConfig');
  });

  it("resumed run, promote 'not-issued': an earlier run's promote may land, so it stays fenced", async () => {
    const { order, thrown } = await run({
      promoteVerdict: 'not-issued',
      envConfig: baseEnvConfig({
        ha: { failoverInFlight: { target: 'standby', systemIdentifier: SYSID } },
      }),
    });
    expect(order).toContain('promote');
    expect(order).not.toContain('unquiesce');
    expect(order).not.toContain('clearJournal');
    expect(thrown?.message).toMatch(/kept fenced/);
  });

  it("a 'promoted' verdict proceeds: promoteStandby owns the deadline, the caller does not re-time it", async () => {
    const { order, thrown } = await run({ promoteVerdict: 'promoted' });
    expect(thrown).toBeUndefined();
    expect(order).toContain('dns');
    expect(order).not.toContain('unquiesce');
  });

  it('the journal names the identifier the reseed just seeded, not the pre-reseed reading', async () => {
    const { captured } = await run({ seededSysid: OTHER_SYSID });
    expect((captured.journal as { systemIdentifier: string }).systemIdentifier).toBe(OTHER_SYSID);
  });

  it('without a reseed the journal keeps the verified reading', async () => {
    const { captured } = await run({ seededSysid: null });
    expect((captured.journal as { systemIdentifier: string }).systemIdentifier).toBe(SYSID);
  });

  it('a thrown promote is unconfirmed too: fenced, journal kept, never cleared', async () => {
    const { order, thrown } = await run({ promoteThrows: true });
    expect(order).toContain('promote');
    expect(order.filter((s) => s === 'unquiesce')).toHaveLength(0);
    expect(order).not.toContain('clearJournal');
    expect(thrown?.message).toMatch(/kept fenced/);
    expect(order).not.toContain('dns');
    expect(order).not.toContain('saveConfig');
  });
});

describe('-force-unproven (dead primary, no identifier proof)', () => {
  afterEach(() => vi.restoreAllMocks());
  const unprovenEnv = () => {
    const envConfig = baseEnvConfig();
    delete (envConfig.ha as Record<string, unknown>).systemIdentifier;
    return envConfig;
  };

  it('refused without the flag', async () => {
    const { order, thrown } = await run({ primaryReachable: false, envConfig: unprovenEnv() });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expectNoMutation(order);
  });

  it('proceeds with it when unplanned: confirms first, records the override in journal and swap', async () => {
    const { order, captured, thrown } = await run({
      primaryReachable: false,
      envConfig: unprovenEnv(),
      flags: { forceUnproven: true },
    });
    expect(thrown).toBeUndefined();
    expect(order.indexOf('confirmUnproven')).toBeLessThan(order.indexOf('provision'));
    expect(order).toContain('promote');
    expect(captured.journal).toMatchObject({ override: 'force-unproven' });
    expect(captured.swapOverride).toBe('force-unproven');
  });

  it('also skips a mismatched identifier, but never a standby out of recovery', async () => {
    const mismatch = await run({
      primaryReachable: false,
      standbyState: streamingStandby({ systemIdentifier: OTHER_SYSID, receiverStatus: null }),
      flags: { forceUnproven: true },
    });
    expect(mismatch.thrown).toBeUndefined();
    const notReplica = await run({
      primaryReachable: false,
      envConfig: unprovenEnv(),
      standbyState: streamingStandby({ inRecovery: false, receiverStatus: null }),
      flags: { forceUnproven: true },
    });
    expect(notReplica.thrown?.message).toMatch(/not a replica/);
    expectNoMutation(notReplica.order);
  });

  it('refused in planned mode, before any write', async () => {
    const { order, thrown } = await run({
      primaryReachable: true,
      envConfig: unprovenEnv(),
      flags: { forceUnproven: true },
    });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/dead primary only/);
    expect(order).not.toContain('confirmUnproven');
    expectNoMutation(order);
  });

  it('a degraded env still refuses unless -allow-degraded is passed too', async () => {
    const degraded = () => ({ ...unprovenEnv(), replication: 'degraded', degraded: true });
    const without = await run({
      primaryReachable: false,
      envConfig: degraded(),
      flags: { forceUnproven: true },
    });
    expect(without.thrown?.message).toMatch(/degraded/);
    expectNoMutation(without.order);
    const withFlag = await run({
      primaryReachable: false,
      envConfig: degraded(),
      flags: { forceUnproven: true, allowDegraded: true },
    });
    expect(withFlag.thrown).toBeUndefined();
    expect(withFlag.order).toContain('promote');
  });

  it('-allow-degraded alone is refused', async () => {
    const { thrown, order } = await run({
      primaryReachable: false,
      envConfig: { ...baseEnvConfig(), replication: 'degraded' },
      flags: { allowDegraded: true },
    });
    expect(thrown?.message).toMatch(/only applies together with -force-unproven/);
    expectNoMutation(order);
  });
});

describe('confirmUnprovenFailover', () => {
  afterEach(() => vi.restoreAllMocks());

  it('-y skips the typed confirmation', async () => {
    await expect(confirmUnprovenFailover('e4', { yes: true })).resolves.toBeUndefined();
  });

  it('no TTY and no -y exits rather than hanging on a prompt', async () => {
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    try {
      await expect(confirmUnprovenFailover('e4', { yes: false })).rejects.toThrow('__exit__');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    }
  });
});

describe('assertFailoverPreconditions', () => {
  it('is shared by both tiers and returns the mode', () => {
    for (const tier of ['compose-ha', 'k8s-ha'] as const) {
      expect(
        assertFailoverPreconditions({
          envConfig: baseEnvConfig(),
          environment: 'e4',
          standbyState: streamingStandby(),
          tier,
        }),
      ).toEqual({ mode: 'promote' });
    }
  });

  it('a journal for a different database does not resume', () => {
    expect(() =>
      assertFailoverPreconditions({
        envConfig: baseEnvConfig({
          ha: {
            failoverInFlight: {
              id: 'j1',
              target: 'standby',
              startedAt: '2026-10-20T10:00:00.000Z',
              primaryLsn: null,
              systemIdentifier: OTHER_SYSID,
            },
          },
        }),
        environment: 'e4',
        standbyState: streamingStandby({ inRecovery: false }),
        tier: 'k8s-ha',
      }),
    ).toThrow(FailoverRefusedError);
  });
});

describe('readReplicaState', () => {
  it('parses one psql row into the replica proof', async () => {
    const exec = vi.fn(async () => `t|${SYSID}|0/3000060|streaming|2\n`);
    await expect(readReplicaState({ exec })).resolves.toEqual({
      inRecovery: true,
      systemIdentifier: SYSID,
      replayLsn: '0/3000060',
      receiverStatus: 'streaming',
      lastMsgAgeS: 2,
    });
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toContain('pg_is_in_recovery()');
    expect(sql).toContain('pg_control_system()');
    expect(sql).toContain('pg_stat_wal_receiver');
  });

  it('a primary reads as out of recovery with no receiver', async () => {
    const exec = vi.fn(async () => `f|${SYSID}|||`);
    await expect(readReplicaState({ exec })).resolves.toEqual({
      inRecovery: false,
      systemIdentifier: SYSID,
      replayLsn: null,
      receiverStatus: null,
      lastMsgAgeS: null,
    });
  });

  it('an exec failure or garbage output is unknown, never "promoted"', async () => {
    const unknown = {
      inRecovery: null,
      systemIdentifier: null,
      replayLsn: null,
      receiverStatus: null,
      lastMsgAgeS: null,
    };
    await expect(
      readReplicaState({
        exec: async () => {
          throw new Error('pod down');
        },
      }),
    ).resolves.toEqual(unknown);
    await expect(readReplicaState({ exec: async () => 'error: x' })).resolves.toEqual(unknown);
  });
});

describe('promoteStandby (tri-state, deadline not poll count)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Implementations set per test must not leak into the next one.
    (ssh.sshKubectl as ReturnType<typeof vi.fn>).mockReset();
  });

  const fakeTime = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };
  const readSeq = (seq: Array<boolean | null>) => {
    let i = 0;
    return vi.fn(async () => ({ inRecovery: seq[Math.min(i++, seq.length - 1)] }));
  };

  it("'promoted' only after a prior in-recovery read", async () => {
    const readState = readSeq([true, true, false]);
    const verdict = await promoteStandby('10.0.0.9', '/k', { readState, ...fakeTime() });
    expect(verdict).toBe('promoted');
    const argv = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls[0][2] as string[];
    expect(argv.join(' ')).toContain('pg_ctl promote');
  });

  it("a first out-of-recovery read is 'not-issued' and never issues pg_ctl promote", async () => {
    const readState = readSeq([false]);
    const verdict = await promoteStandby('10.0.0.9', '/k', { readState, ...fakeTime() });
    expect(verdict).toBe('not-issued');
    expect(ssh.sshKubectl).not.toHaveBeenCalled();
  });

  it("still in recovery at the deadline after pg_ctl promote was issued is 'unknown', never 'in-recovery'", async () => {
    // An issued promote cannot be taken back (postgres deletes promote.signal
    // itself on accepting it and reads in recovery while it finishes), so a
    // late "still in recovery" proves nothing: the old primary stays fenced.
    const time = fakeTime();
    const readState = readSeq([true]);
    const verdict = await promoteStandby('10.0.0.9', '/k', { readState, ...time });
    expect(verdict).toBe('unknown');
    // The deadline, not a poll count, ended the wait.
    expect(time.now()).toBeGreaterThanOrEqual(PROMOTE_DEADLINE_MS);
    const calls = (ssh.sshKubectl as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      (c[2] as string[]).join(' '),
    );
    // Exactly one remote write, the promote itself; nothing tries to withdraw it.
    expect(calls).toEqual([
      'exec -n vibecarbon db-0 -- su postgres -c pg_ctl promote -D /var/lib/postgresql/data',
    ]);
  });

  it("a db pod that cannot be resolved is 'unknown', never an un-fence (a resumed run may have a promote pending)", async () => {
    // Security review of 4a3f55f: this used to return 'in-recovery' ("no
    // promote issued"), which un-fenced the old primary. On a rerun a previous
    // run's promote may still be landing, so not issuing one now proves
    // nothing: fail closed and let the journal finish it.
    vi.mocked(ssh.getPostgresPod).mockRejectedValueOnce(new Error('no db pod'));
    const verdict = await promoteStandby('10.0.0.9', '/k', {
      readState: readSeq([true]),
      ...fakeTime(),
    });
    expect(verdict).toBe('unknown');
    expect(ssh.sshKubectl).not.toHaveBeenCalled();
  });

  it('the deadline runs from before the first read, so it bounds the whole promote window', async () => {
    const time = fakeTime();
    const readState = vi.fn(async () => {
      await time.sleep(PROMOTE_DEADLINE_MS / 2);
      return { inRecovery: true };
    });
    const verdict = await promoteStandby('10.0.0.9', '/k', { readState, ...time });
    expect(verdict).toBe('unknown');
    // pre-read (60 s) + one post-issue read (60 s) reaches the deadline.
    expect(readState).toHaveBeenCalledTimes(2);
  });

  it("an unreadable state at the deadline is 'unknown'", async () => {
    const readState = readSeq([true, null]);
    const verdict = await promoteStandby('10.0.0.9', '/k', { readState, ...fakeTime() });
    expect(verdict).toBe('unknown');
  });

  it('the promote deadline is 120 s', () => {
    expect(PROMOTE_DEADLINE_MS).toBe(120_000);
  });
});

describe('failover journal (R2)', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const seed = (env: Record<string, unknown>) => {
    dir = mkdtempSync(join(tmpdir(), 'vc-journal-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ projectName: 'proj', environments: { e4: env } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  };
  const readEnv = () =>
    JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).environments.e4;

  it('writes the journal shape through the config save and returns its id', async () => {
    seed(baseEnvConfig());
    const id = await writeFailoverJournal(
      { environment: 'e4' },
      { target: 'standby', primaryLsn: '0/3000060', systemIdentifier: SYSID },
    );
    const j = readEnv().ha.failoverInFlight;
    expect(j).toEqual({
      id,
      target: 'standby',
      startedAt: expect.any(String),
      primaryLsn: '0/3000060',
      systemIdentifier: SYSID,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(j.startedAt))).toBe(false);
  });

  it('clears the journal and keeps the rest of ha', async () => {
    seed(
      baseEnvConfig({
        ha: { failoverInFlight: { id: 'j1', target: 'standby' } },
      }),
    );
    await clearFailoverJournal({ environment: 'e4' });
    const env = readEnv();
    expect(env.ha.failoverInFlight).toBeUndefined();
    expect(env.ha.systemIdentifier).toBe(SYSID);
  });

  it('swapHaRoles clears the journal in the same save that persists the swap', () => {
    seed(
      baseEnvConfig({
        ha: {
          primary: { masterIp: '10.0.0.1', stack: 'e4-primary' },
          standby: { masterIp: '10.0.0.9', stack: 'e4-standby' },
          failoverInFlight: { id: 'j1', target: 'standby' },
        },
      }),
    );
    swapHaRoles('e4');
    const env = readEnv();
    expect(env.ha.primary.stack).toBe('e4-standby');
    expect(env.ha.failoverInFlight).toBeUndefined();
    // The failback guard reads this against deployedAt.
    expect(Date.parse(env.lastFailover)).toBeGreaterThan(Date.parse(env.deployedAt));
    // The promoted side keeps the same lineage: the identifier survives.
    expect(env.ha.systemIdentifier).toBe(SYSID);
  });
});

describe('failoverHA DNS flip is verified (R5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a confirmed flip completes cleanly', async () => {
    const { order, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(order.indexOf('promote')).toBeLessThan(order.indexOf('dns'));
    expect(order.indexOf('dns')).toBeLessThan(order.indexOf('saveConfig'));
  });

  it('a rejected DNS update persists the swap, then exits non-zero with DNS DID NOT', async () => {
    const { order, thrown } = await run({ dnsUpdateThrows: true });
    expect(thrown?.message).toMatch(/DNS DID NOT/);
    expect(thrown?.message).toContain('10.0.0.99');
    expect(thrown?.message).toContain('403');
    expect(thrown?.name).toBe('FailoverDnsError');
    expect(order).toContain('saveConfig');
    expect(order.indexOf('saveConfig')).toBeGreaterThan(order.indexOf('dns'));
  });

  it('a read-back that disagrees with the promoted IP counts as not flipped', async () => {
    const { order, thrown } = await run({ dnsReadsBack: ['10.0.0.1'] });
    expect(thrown?.message).toMatch(/DNS DID NOT/);
    expect(thrown?.message).toContain('reads back as 10.0.0.1');
    expect(order).toContain('saveConfig');
  });

  it('an apex that is right but a wildcard that is wrong counts as not flipped', async () => {
    const { thrown } = await run({ wildcardReadsBack: ['10.0.0.1'] });
    expect(thrown?.message).toMatch(/DNS DID NOT/);
    expect(thrown?.message).toContain('*.app.example.com reads back as 10.0.0.1');
  });

  it('a stale second A record counts as not flipped', async () => {
    const { thrown } = await run({ dnsReadsBack: ['10.0.0.99', '10.0.0.1'] });
    expect(thrown?.message).toMatch(/DNS DID NOT/);
  });

  it('a record that reads back as nothing counts as not flipped', async () => {
    const { thrown } = await run({ dnsReadsBack: [] });
    expect(thrown?.message).toMatch(/DNS DID NOT/);
  });

  it('rerunning failover after a DNS-failed (swap-persisted) failover is refused before any mutation', async () => {
    const first = await run({ dnsUpdateThrows: true });
    expect(first.thrown?.message).toMatch(/DNS DID NOT/);
    expect(first.order).toContain('saveConfig');
    // The state that first run persisted: roles swapped after the last deploy,
    // so the "standby" the rerun sees is the retired primary, not a replica.
    const rerun = await run({
      envConfig: baseEnvConfig({
        lastFailover: '2026-10-20T12:00:00.000Z',
        deployedAt: '2026-10-01T00:00:00.000Z',
        replication: 'degraded',
      }),
      standbyState: streamingStandby({ inRecovery: false, receiverStatus: null }),
    });
    expect(rerun.thrown).toBeInstanceOf(FailoverRefusedError);
    expect(rerun.thrown?.message).toMatch(/vibecarbon deploy/);
    expectNoMutation(rerun.order);
  });
});
