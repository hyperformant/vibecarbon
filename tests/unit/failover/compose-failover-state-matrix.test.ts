/**
 * compose-HA failover state matrix (HA-correctness Task 2, C1 compose + C2).
 *
 * The compose-HA failover had the same C1 hole as k8s: after a failed
 * `pg_promote` it accepted `pg_is_in_recovery() = 'f'` as "promoted", which is
 * also true of an old primary on a failback, an unseeded standby, or a promote
 * that landed after a previous run gave up. It now goes through the shared
 * guard: `assertFailoverPreconditions` before any write, the journal right
 * before the promote, and an unconfirmed promote keeps the old primary fenced.
 *
 * C2: after one compose failover the roles are swapped in config and the
 * retired node is frozen at the failover. A second failover before a deploy
 * has reconverged the pair is refused before any ssh call; once reconverged,
 * the reseed dials the role primary's own tunnel address (its birth stack's,
 * wgIpOf), never a fixed 10.99.0.1.
 *
 * The guard reads, reseed, journal, promote, fence and swap are injected seams;
 * the post-promote steps run against the mocked compose ssh layer.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sshCalls: Array<{ ip: string; command: string }> = [];
let sshOverride: ((c: string) => string | undefined) | undefined;
let addonStartResult: string | false = '';

const WALG_AUDIT_PASS = [
  'WALG_AUDIT=probed',
  'WALG_AUDIT_PREFIX=s3://bucket/backups/myapp/walg',
  'WALG_AUDIT_RC=0',
  'WALG_AUDIT_ARCHIVER=3|0|000000010000000000000003||2026-07-30 12:00:00+00||f',
  'WALG_AUDIT_LIST_BEGIN',
  '[{"backup_name":"base_000000010000000000000002","time":"2026-07-30T12:00:00Z"}]',
  'WALG_AUDIT_LIST_END',
].join('\n');

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = (ip: string, _k: string, command: unknown) => {
    const c = String(command);
    sshCalls.push({ ip, command: c });
    if (c.includes('WALG_AUDIT')) return WALG_AUDIT_PASS;
    if (c.includes('%{http_code}')) return 'app=200';
    if (c.includes('FENCE_DONE')) return sshOverride?.(c) ?? 'STOPPED fake\nFENCE_DONE';
    if (c.includes('replication.yml up -d --no-deps n8n')) return addonStartResult;
    return '';
  };
  const recChecked = async (ip: string, k: string, command: unknown) => rec(ip, k, command);
  return {
    ...actual,
    sshRun: vi.fn(rec),
    sshRunAsync: vi.fn(rec),
    sshRunChecked: vi.fn(recChecked),
  };
});

vi.mock('../../../src/lib/deploy/utils.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, mergeRemoteDotenv: vi.fn(async () => {}) };
});

vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, existsSync: () => true };
});

// Managed-DNS rows: the token resolves unless a row says otherwise, and the
// trusted-TLS gate never touches the network.
let dnsToken = 'dns-token';
vi.mock('../../../src/lib/dns-provider.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, resolveDnsToken: () => dnsToken };
});
vi.mock('../../../src/lib/deploy/tls-ready.js', () => ({
  waitForTrustedTls: async () => ({ trusted: true, elapsedMs: 0 }),
}));

const composeSsh = await import('../../../src/lib/deploy/compose/index.js');
const {
  failoverComposeHA,
  flipComposeDns,
  promoteComposeStandby,
  stopOldPrimaryApp,
  swapComposeHaRoles,
} = await import('../../../src/lib/deploy/compose/ha.js');
const { FailoverRefusedError } = await import('../../../src/lib/deploy/failover-guard.js');
const { liftStrandedWriteFence } = await import('../../../src/lib/deploy/write-fence.js');

const SYSID = '7412345678901234567';
const OTHER_SYSID = '7499999999999999999';
const PRIMARY_IP = '10.0.0.1';
const STANDBY_IP = '10.0.0.2';

type State = {
  inRecovery: boolean | null;
  systemIdentifier: string | null;
  replayLsn: string | null;
  receiverStatus: string | null;
  lastMsgAgeS: number | null;
};

const replica = (over: Partial<State> = {}): State => ({
  inRecovery: true,
  systemIdentifier: SYSID,
  replayLsn: '0/3000060',
  receiverStatus: 'streaming',
  lastMsgAgeS: 1,
  ...over,
});
const primaryDb = (over: Partial<State> = {}): State =>
  replica({ inRecovery: false, receiverStatus: null, lastMsgAgeS: null, ...over });

/** A compose-HA env exactly as a streaming deploy leaves it. */
const baseEnvConfig = (over: Record<string, unknown> = {}) => ({
  deployMode: 'compose-ha',
  region: 'nbg1',
  secondaryRegion: 'ash',
  replication: 'streaming',
  deployedAt: '2026-10-01T00:00:00.000Z',
  servers: [
    { name: 'myapp-prod-primary', role: 'primary', ip: PRIMARY_IP, region: 'nbg1' },
    { name: 'myapp-prod-standby', role: 'standby', ip: STANDBY_IP, region: 'ash' },
  ],
  ...over,
  ha: {
    enabled: true,
    failoverRegion: 'ash',
    systemIdentifier: SYSID,
    ...((over.ha as Record<string, unknown>) ?? {}),
  },
});

interface RunOpts {
  envConfig?: Record<string, unknown>;
  primaryReachable?: boolean;
  standbyState?: State;
  /** The standby's reading after a reseed (default: the same database, in recovery). */
  seededState?: State;
  primaryState?: State;
  promoteVerdict?: 'promoted' | 'not-issued' | 'unknown';
  promoteThrows?: boolean;
  flags?: { forceUnproven?: boolean; allowDegraded?: boolean };
  /** The catch-up gate throws (a streaming standby missed the deadline). */
  catchUpThrows?: boolean;
  /** The pre-promote writer stop (docker stop) cannot be confirmed. */
  fenceFails?: boolean;
  /** The database write fence cannot be proven. */
  dbFenceThrows?: boolean;
  /** The reseeded standby still carries the fence. */
  standbyFenced?: boolean;
  /** Whether lifting a stranded fence succeeds. */
  liftSucceeds?: boolean;
  /** The journal write throws. */
  journalThrows?: boolean;
  /** The journal clear throws. */
  clearJournalThrows?: boolean;
  /** What the managed-DNS flip reports (default: flipped and verified). */
  dnsFlip?: { ok: true } | { ok: false; reason: string };
  /** Pass no seams at all (the real ssh-backed defaults run). */
  noSeams?: boolean;
  /** Drop the fenceOldPrimary seam so the real default (ssh-backed) fence runs. */
  realFence?: boolean;
}

async function run(opts: RunOpts = {}) {
  const {
    envConfig = baseEnvConfig(),
    primaryReachable = false,
    // A dead primary stops streaming; one still streaming fresh WAL is alive
    // (R8, classify-failover.test.ts), so unplanned rows default to no receiver.
    standbyState = opts.primaryReachable
      ? replica()
      : replica({ receiverStatus: null, lastMsgAgeS: null }),
    seededState = replica(),
    primaryState = primaryDb(),
    promoteVerdict = 'promoted',
    promoteThrows = false,
    flags = {},
    catchUpThrows = false,
    fenceFails = false,
    dbFenceThrows = false,
    standbyFenced = false,
    liftSucceeds = true,
    journalThrows = false,
    clearJournalThrows = false,
    dnsFlip = { ok: true as const },
    noSeams = false,
    realFence = false,
  } = opts;
  const order: string[] = [];
  const captured: Record<string, unknown> = {};
  let reseeded = false;
  const deps = {
    isPrimaryReachable: async () => primaryReachable,
    readState: async (ip: string) => {
      if (ip === PRIMARY_IP) {
        order.push('readPrimary');
        return primaryState;
      }
      order.push('readStandby');
      return reseeded ? seededState : standbyState;
    },
    reseed: async (
      standbyIp: string,
      primaryIp: string,
      _key: string,
      _project: string,
      reseedOpts: unknown,
    ) => {
      order.push('reseed');
      captured.reseedArgs = [standbyIp, primaryIp];
      captured.reseedOpts = reseedOpts;
      reseeded = true;
      return true;
    },
    recordSeeded: (_ctx: unknown, sysid: string) => {
      order.push('recordSeeded');
      captured.recordedSysid = sysid;
    },
    clearJournal: async () => {
      order.push('clearJournal');
      if (clearJournalThrows) throw new Error('config save failed');
    },
    writeJournal: async (_ctx: unknown, journal: Record<string, unknown>) => {
      if (journalThrows) throw new Error('config save failed');
      order.push('journal');
      captured.journal = journal;
      return 'journal-id';
    },
    promote: async () => {
      order.push('promote');
      if (promoteThrows) throw new Error('ssh dropped');
      return promoteVerdict;
    },
    catchUp: async (o: { isStreaming: () => Promise<boolean> }) => {
      order.push('catchUp');
      if (catchUpThrows) {
        throw new Error("zero-data-loss gate: the standby did not replay the primary's final WAL");
      }
      const streaming = await o.isStreaming();
      return { caughtUp: streaming, lagBytes: streaming ? 0 : null, primaryLsn: '0/3000060' };
    },
    stopWriters: async (ip: string) => {
      order.push('stopWriters');
      captured.stoppedIp = ip;
      return { ok: !fenceFails, stopped: ['myapp-app'] };
    },
    fenceWrites: async () => {
      order.push('dbFence');
      if (dbFenceThrows) throw new Error('write fence: 1 client session(s) outlived it');
    },
    unfenceWrites: async () => {
      order.push('dbUnfence');
      return true;
    },
    startWriters: async (ip: string, _k: string, containers: string[]) => {
      order.push('startWriters');
      captured.startedIp = ip;
      captured.started = containers;
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
            return liftSucceeds;
          },
          clearMarker: () => {
            order.push('clearMarker');
          },
        },
      }),
    assertUnfenced: async () => {
      order.push('assertUnfenced');
      if (standbyFenced) throw new Error('the reseeded standby carries the write fence');
    },
    fenceOldPrimary: async (ip: string, key: string, project: string, services: string[]) => {
      order.push('fence');
      captured.fencedIp = ip;
      return realFence ? stopOldPrimaryApp(ip, key, project, services) : true;
    },
    confirmUnproven: async () => {
      order.push('confirmUnproven');
    },
    flipDns: async (_env: unknown, ip: string) => {
      order.push('dns');
      captured.dnsIp = ip;
      return dnsFlip;
    },
    swapRoles: (_env: string, o?: { override?: string }) => {
      order.push('swap');
      captured.swapOverride = o?.override;
    },
    // The backup-prefix fence write (backup-fence.test.ts pins its place).
    writeFence: async () => ({ ok: true }),
    recordFence: () => {},
    reconcileRetired: async () => {
      order.push('fenceRetired');
      return { fenced: [], unreachable: [] };
    },
  };
  const projectConfig = { projectName: 'myapp', environments: { prod: envConfig } };
  const parsed = { yes: true, dryRun: false, ...flags };
  const tracker = { spinner: () => ({ start() {}, stop() {}, message() {} }) };
  let thrown: Error | undefined;
  try {
    await failoverComposeHA(
      'prod',
      envConfig,
      projectConfig,
      parsed,
      tracker,
      // biome-ignore lint/suspicious/noExplicitAny: injected test deps bag.
      (noSeams ? undefined : deps) as any,
    );
  } catch (err) {
    thrown = err as Error;
  }
  return { order, captured, thrown };
}

/** Steps a refusal must never reach. */
const MUTATIONS = [
  'stopWriters',
  'dbFence',
  'dbUnfence',
  'startWriters',
  'reseed',
  'journal',
  'promote',
  'fence',
  'swap',
  'fenceRetired',
];
function expectNoMutation(order: string[]) {
  for (const step of MUTATIONS) expect(order, `refusal reached ${step}`).not.toContain(step);
  expect(sshCalls, 'a refusal ran a remote command').toEqual([]);
}

beforeEach(() => {
  sshCalls.length = 0;
  sshOverride = undefined;
  addonStartResult = '';
});
afterEach(() => vi.clearAllMocks());

describe('failoverComposeHA state matrix', () => {
  it('a proven replica promotes: the journal goes down immediately before the promote, the swap clears it', async () => {
    const { order, captured, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(order.indexOf('journal')).toBe(order.indexOf('promote') - 1);
    expect(captured.journal).toEqual({
      target: 'standby',
      primaryLsn: null,
      systemIdentifier: SYSID,
    });
    expect(order).toContain('swap');
    // The old primary's app is stopped only after the promote was proven.
    expect(order.indexOf('fence')).toBeGreaterThan(order.indexOf('promote'));
    // The post-promote steps ran on the promoted node.
    expect(
      sshCalls.some((c) => c.ip === STANDBY_IP && c.command === 'docker restart myapp-app'),
    ).toBe(true);
  });

  it('starts the enabled primary-only add-ons on the promoted node, no-deps, never the setup jobs', async () => {
    const { thrown } = await run({ envConfig: baseEnvConfig({ n8n: true }) });
    expect(thrown).toBeUndefined();
    const starts = sshCalls.filter((c) => c.command.includes('replication.yml up -d --no-deps'));
    expect(starts).toHaveLength(1);
    expect(starts[0].ip).toBe(STANDBY_IP);
    expect(starts[0].command).toContain('up -d --no-deps n8n');
    expect(starts[0].command).not.toContain('setup');
    expect(starts[0].command).not.toContain('app-migrate');
  });

  it('an add-on start that fails warns with the exact command and the failover continues', async () => {
    const p = await import('@clack/prompts');
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    addonStartResult = false;
    const { order, thrown } = await run({ envConfig: baseEnvConfig({ n8n: true }) });
    expect(thrown).toBeUndefined();
    expect(order).toContain('swap');
    const start = sshCalls.find((c) => c.command.includes('replication.yml up -d --no-deps n8n'));
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(
      warned.some(
        (w) => w.includes('primary-only add-ons') && w.includes(start?.command as string),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('the default fence skips an absent add-on container: no split-brain warning, the app still stops', async () => {
    const p = await import('@clack/prompts');
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    sshOverride = (c) =>
      c.includes('docker stop "$c"') ? 'STOPPED myapp-app\nFENCE_DONE' : undefined;
    const { order, thrown } = await run({
      envConfig: baseEnvConfig({ n8n: true }),
      realFence: true,
    });
    expect(thrown).toBeUndefined();
    expect(order).toContain('fence');
    const fence = sshCalls.find(
      (c) => c.ip === PRIMARY_IP && c.command.includes('for c in myapp-app myapp-n8n;'),
    );
    expect(fence?.command).toContain('docker container inspect');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('SPLIT-BRAIN'))).toBe(false);
    warn.mockRestore();
  });

  it('the default fence warns split-brain only when a running container will not stop', async () => {
    const p = await import('@clack/prompts');
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    sshOverride = (c) =>
      c.includes('docker stop "$c"') ? 'FAILED myapp-app\nFENCE_DONE' : undefined;
    await run({ envConfig: baseEnvConfig({ n8n: true }), realFence: true });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('SPLIT-BRAIN'))).toBe(true);
    warn.mockRestore();
  });

  it('a run with no add-ons issues no add-on start', async () => {
    await run();
    expect(sshCalls.some((c) => c.command.includes('replication.yml up -d --no-deps'))).toBe(false);
  });

  it('never re-runs app-migrate on the promoted standby (it replicated an already-migrated primary)', async () => {
    await run();
    expect(sshCalls.some((c) => c.command.includes('app-migrate'))).toBe(false);
  });

  it('resume: out of recovery with a journal naming the standby skips reseed and promote, then finishes', async () => {
    const { order, thrown } = await run({
      standbyState: replica({ inRecovery: false, receiverStatus: null }),
      envConfig: baseEnvConfig({
        ha: { failoverInFlight: { target: 'standby', systemIdentifier: SYSID } },
      }),
    });
    expect(thrown).toBeUndefined();
    expect(order).not.toContain('reseed');
    expect(order).not.toContain('journal');
    expect(order).not.toContain('promote');
    expect(order).toContain('swap');
    expect(sshCalls.some((c) => c.command === 'docker restart myapp-app')).toBe(true);
  });

  it('out of recovery with no journal refuses: not a replica, nothing touched', async () => {
    const { order, thrown } = await run({
      standbyState: replica({ inRecovery: false, receiverStatus: null }),
    });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/not a replica/);
    expectNoMutation(order);
  });

  it('a degraded env refuses before any write', async () => {
    const { order, thrown } = await run({ envConfig: baseEnvConfig({ replication: 'degraded' }) });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/degraded/);
    expectNoMutation(order);
  });

  it('failback before a reconverging deploy refuses and names vibecarbon deploy', async () => {
    // No stack names on the servers, so the role-swap detector has no identity
    // to read: the guard's lastFailover/deployedAt check is what refuses.
    const { order, thrown } = await run({
      envConfig: baseEnvConfig({
        lastFailover: '2026-10-05T00:00:00.000Z',
        servers: [
          { role: 'primary', ip: PRIMARY_IP, region: 'nbg1' },
          { role: 'standby', ip: STANDBY_IP, region: 'ash' },
        ],
      }),
    });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toMatch(/vibecarbon deploy/);
    expectNoMutation(order);
  });

  it('a standby holding a different database refuses', async () => {
    const { order, thrown } = await run({
      standbyState: replica({
        systemIdentifier: OTHER_SYSID,
        receiverStatus: null,
        lastMsgAgeS: null,
      }),
    });
    expect(thrown?.message).toMatch(/different database/);
    expectNoMutation(order);
  });

  it('an unreadable standby refuses', async () => {
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
    expectNoMutation(order);
  });

  it('nothing recorded, unplanned: refuses and names vibecarbon deploy', async () => {
    const envConfig = baseEnvConfig();
    delete (envConfig.ha as Record<string, unknown>).systemIdentifier;
    const { order, thrown } = await run({ envConfig });
    expect(thrown?.message).toMatch(/vibecarbon deploy/);
    expectNoMutation(order);
  });

  it('nothing recorded, planned with a streaming standby: compares live against the primary and promotes', async () => {
    const envConfig = baseEnvConfig();
    delete (envConfig.ha as Record<string, unknown>).systemIdentifier;
    const { order, thrown } = await run({ envConfig, primaryReachable: true });
    expect(thrown).toBeUndefined();
    expect(order.indexOf('readPrimary')).toBeLessThan(order.indexOf('promote'));
    expect(order).toContain('promote');
  });

  it("promote 'unknown' fences the old primary, keeps the journal and stops before DNS and the swap", async () => {
    const { order, captured, thrown } = await run({ promoteVerdict: 'unknown' });
    expect(order).toContain('fence');
    expect(captured.fencedIp).toBe(PRIMARY_IP);
    expect(order).not.toContain('swap');
    expect(thrown?.message).toMatch(/kept fenced/);
    expect(thrown?.message).toMatch(/rerun vibecarbon failover prod to finish/);
    // Nothing past the promote ran on the promoted node.
    expect(sshCalls.some((c) => c.command.includes('docker restart'))).toBe(false);
  });

  it("first run, promote 'not-issued': no fence, journal cleared, non-zero exit naming the cause", async () => {
    const { order, thrown } = await run({ promoteVerdict: 'not-issued' });
    expect(order).not.toContain('fence');
    expect(order).toContain('clearJournal');
    expect(order.indexOf('clearJournal')).toBeGreaterThan(order.indexOf('promote'));
    expect(order).not.toContain('swap');
    expect(thrown?.message).toMatch(/no promote was sent/);
    expect(thrown?.message).toContain(STANDBY_IP);
    expect(sshCalls.some((c) => c.command.includes('docker restart'))).toBe(false);
  });

  it("resumed run, promote 'not-issued': an earlier run's promote may land, so it fences and keeps the journal", async () => {
    const { order, thrown } = await run({
      promoteVerdict: 'not-issued',
      envConfig: baseEnvConfig({
        ha: { failoverInFlight: { target: 'standby', systemIdentifier: SYSID } },
      }),
    });
    expect(order).toContain('fence');
    expect(order).not.toContain('clearJournal');
    expect(order).not.toContain('swap');
    expect(thrown?.message).toMatch(/kept fenced/);
  });

  it('resume keeps the override the proof-skipping run recorded', async () => {
    const { captured, thrown } = await run({
      standbyState: replica({ inRecovery: false, receiverStatus: null }),
      envConfig: baseEnvConfig({
        ha: {
          failoverInFlight: {
            target: 'standby',
            systemIdentifier: SYSID,
            override: 'force-unproven',
          },
        },
      }),
    });
    expect(thrown).toBeUndefined();
    expect(captured.swapOverride).toBe('force-unproven');
  });

  it('a thrown promote is unconfirmed too: fenced, journal kept, no swap', async () => {
    const { order, thrown } = await run({ promoteThrows: true });
    expect(order).toContain('fence');
    expect(order).not.toContain('swap');
    expect(thrown?.message).toMatch(/kept fenced/);
  });

  it('a standby that is not streaming is reseeded from the reachable primary, and the journal names the seeded identifier', async () => {
    const { order, captured, thrown } = await run({
      primaryReachable: true,
      standbyState: replica({ receiverStatus: null }),
      primaryState: primaryDb(),
      seededState: replica({ receiverStatus: 'streaming' }),
    });
    expect(thrown).toBeUndefined();
    expect(captured.reseedArgs).toEqual([STANDBY_IP, PRIMARY_IP]);
    // Over the primary's own tunnel address: it was born as the -primary stack.
    expect(captured.reseedOpts).toEqual({ primaryHost: '10.99.0.1' });
    // Reseeded from the FENCED primary, after the gate found it not streaming,
    // and proven free of the fence the basebackup copied, before the journal.
    expect(order.indexOf('dbFence')).toBeLessThan(order.indexOf('catchUp'));
    expect(order.indexOf('catchUp')).toBeLessThan(order.indexOf('reseed'));
    expect(order.indexOf('reseed')).toBeLessThan(order.indexOf('recordSeeded'));
    expect(order.indexOf('reseed')).toBeLessThan(order.indexOf('assertUnfenced'));
    expect(order.indexOf('assertUnfenced')).toBeLessThan(order.indexOf('journal'));
    expect(captured.recordedSysid).toBe(SYSID);
    expect((captured.journal as { systemIdentifier: string }).systemIdentifier).toBe(SYSID);
  });

  it('a reseed that leaves the standby unreadable aborts before the journal (nothing promoted)', async () => {
    const { order, thrown } = await run({
      primaryReachable: true,
      standbyState: replica({ receiverStatus: null }),
      seededState: {
        inRecovery: null,
        systemIdentifier: null,
        replayLsn: null,
        receiverStatus: null,
        lastMsgAgeS: null,
      },
    });
    expect(thrown?.message).toMatch(/re-seed/);
    expect(order).not.toContain('journal');
    expect(order).not.toContain('promote');
    // Nothing was promoted: the fence is lifted, database first.
    expect(order.indexOf('dbUnfence')).toBeGreaterThan(order.indexOf('reseed'));
    expect(order.indexOf('startWriters')).toBeGreaterThan(order.indexOf('dbUnfence'));
  });

  it('-force-unproven on a dead primary confirms first and records the override in the journal and swap', async () => {
    const envConfig = baseEnvConfig();
    delete (envConfig.ha as Record<string, unknown>).systemIdentifier;
    const { order, captured, thrown } = await run({ envConfig, flags: { forceUnproven: true } });
    expect(thrown).toBeUndefined();
    expect(order.indexOf('confirmUnproven')).toBeLessThan(order.indexOf('journal'));
    expect((captured.journal as { override?: string }).override).toBe('force-unproven');
    expect(captured.swapOverride).toBe('force-unproven');
  });
});

describe('failoverComposeHA planned fence and catch-up (H1)', () => {
  const journaled = () =>
    baseEnvConfig({ ha: { failoverInFlight: { target: 'standby', systemIdentifier: SYSID } } });

  it('planned: stops the writers, fences the database, then the gate; journals the LSN and never un-fences on a proven promote', async () => {
    const { order, captured, thrown } = await run({ primaryReachable: true });
    expect(thrown).toBeUndefined();
    expect(captured.stoppedIp).toBe(PRIMARY_IP);
    expect(order.indexOf('stopWriters')).toBeLessThan(order.indexOf('dbFence'));
    expect(order.indexOf('dbFence')).toBeLessThan(order.indexOf('catchUp'));
    expect(order.indexOf('catchUp')).toBeLessThan(order.indexOf('journal'));
    expect((captured.journal as { primaryLsn: string }).primaryLsn).toBe('0/3000060');
    expect(order).not.toContain('reseed');
    expect(order).not.toContain('dbUnfence');
    expect(order).not.toContain('startWriters');
    // Already fenced: the post-promote stop does not ssh it again.
    expect(order).not.toContain('fence');
  });

  it('a standby that misses the catch-up deadline aborts before the journal and lifts the fence', async () => {
    const { order, captured, thrown } = await run({ primaryReachable: true, catchUpThrows: true });
    expect(thrown?.message).toMatch(/^Failover aborted: zero-data-loss gate/);
    expect(order).not.toContain('journal');
    expect(order).not.toContain('promote');
    expect(order.indexOf('dbUnfence')).toBeGreaterThan(order.indexOf('catchUp'));
    expect(order.indexOf('startWriters')).toBeGreaterThan(order.indexOf('dbUnfence'));
    expect(captured.startedIp).toBe(PRIMARY_IP);
    expect(captured.started).toEqual(['myapp-app']);
    expect(order).not.toContain('swap');
  });

  it('a writer stop that cannot be confirmed aborts before the database fence and starts what it stopped (first run)', async () => {
    const { order, thrown } = await run({ primaryReachable: true, fenceFails: true });
    expect(thrown?.message).toMatch(/could not stop the app containers on the old primary/);
    expect(thrown?.message).toContain('rerun vibecarbon failover prod');
    expect(thrown?.message).not.toMatch(/—/);
    expect(order).not.toContain('dbFence');
    expect(order).not.toContain('dbUnfence');
    expect(order).toContain('startWriters');
    expect(order).not.toContain('catchUp');
    expect(order).not.toContain('journal');
    expect(order).not.toContain('promote');
  });

  it('a writer stop that cannot be confirmed with a journal at entry keeps everything stopped', async () => {
    const { order, thrown } = await run({
      primaryReachable: true,
      fenceFails: true,
      envConfig: journaled(),
    });
    expect(thrown?.message).toMatch(/could not stop the app containers/);
    expect(order).not.toContain('startWriters');
    expect(order).not.toContain('dbUnfence');
    expect(order).not.toContain('promote');
  });

  it('a database fence that cannot be proven aborts and lifts it on a first run', async () => {
    const { order, thrown } = await run({ primaryReachable: true, dbFenceThrows: true });
    expect(thrown?.message).toMatch(/^Failover aborted: write fence/);
    expect(order).not.toContain('catchUp');
    expect(order.indexOf('dbUnfence')).toBeLessThan(order.indexOf('startWriters'));
  });

  it("first run, planned, promote 'not-issued': the fence is lifted (marker cleared), then the journal", async () => {
    const { order, thrown } = await run({ primaryReachable: true, promoteVerdict: 'not-issued' });
    expect(thrown?.message).toMatch(/no promote was sent/);
    expect(order.indexOf('dbUnfence')).toBeGreaterThan(order.indexOf('promote'));
    expect(order.indexOf('clearMarker')).toBeGreaterThan(order.indexOf('dbUnfence'));
    expect(order).toContain('startWriters');
    expect(order.indexOf('clearJournal')).toBeGreaterThan(order.indexOf('startWriters'));
  });

  it("resumed run, planned, promote 'not-issued': an earlier promote may land, so it stays fenced", async () => {
    const { order, thrown } = await run({
      primaryReachable: true,
      promoteVerdict: 'not-issued',
      envConfig: journaled(),
    });
    expect(thrown?.message).toMatch(/kept fenced/);
    expect(order).not.toContain('dbUnfence');
    expect(order).not.toContain('startWriters');
    expect(order).not.toContain('clearJournal');
  });

  it("planned, promote 'unknown': stays fenced, journal kept, never un-fenced", async () => {
    const { order, thrown } = await run({ primaryReachable: true, promoteVerdict: 'unknown' });
    expect(thrown?.message).toMatch(/kept fenced/);
    expect(order).not.toContain('dbUnfence');
    expect(order).not.toContain('startWriters');
    expect(order).not.toContain('clearJournal');
  });

  it('a resumed run with an earlier journal never un-fences on a pre-promote abort', async () => {
    const { order, thrown } = await run({
      primaryReachable: true,
      catchUpThrows: true,
      envConfig: journaled(),
    });
    expect(thrown?.message).toMatch(/zero-data-loss gate/);
    expect(order).toContain('dbFence');
    expect(order).not.toContain('dbUnfence');
    expect(order).not.toContain('startWriters');
  });

  it('a reseeded standby that still carries the fence aborts before the journal and lifts the fence', async () => {
    const { order, thrown } = await run({
      primaryReachable: true,
      standbyState: replica({ receiverStatus: null }),
      seededState: replica({ receiverStatus: 'streaming' }),
      standbyFenced: true,
    });
    expect(thrown?.message).toMatch(/carries the write fence/);
    expect(thrown?.message).toMatch(/Nothing was promoted/);
    expect(order).not.toContain('journal');
    expect(order).not.toContain('promote');
    expect(order).toContain('dbUnfence');
  });

  it('the fence is recorded (primary name and ip) before it is applied; a first-run abort clears it', async () => {
    const { order, captured } = await run({ primaryReachable: true, catchUpThrows: true });
    expect(captured.marker).toEqual({ node: 'myapp-prod-primary', ip: PRIMARY_IP });
    expect(order.indexOf('stopWriters')).toBeLessThan(order.indexOf('marker'));
    expect(order.indexOf('marker')).toBeLessThan(order.indexOf('dbFence'));
    expect(order.indexOf('clearMarker')).toBeGreaterThan(order.indexOf('dbUnfence'));
  });

  it('a proven promote keeps the marker for the swap save to clear', async () => {
    const { order, thrown } = await run({ primaryReachable: true });
    expect(thrown).toBeUndefined();
    expect(order).toContain('marker');
    expect(order).not.toContain('clearMarker');
    expect(order).toContain('swap');
  });

  it('a journal write that throws is inside the abort path: the fence is lifted', async () => {
    const { order, thrown } = await run({ primaryReachable: true, journalThrows: true });
    expect(thrown?.message).toMatch(/config save failed/);
    expect(order).not.toContain('promote');
    expect(order).toContain('dbUnfence');
    expect(order).toContain('startWriters');
  });

  it("'not-issued' with a journal clear that throws still lifted the fence first", async () => {
    const { order, thrown } = await run({
      primaryReachable: true,
      promoteVerdict: 'not-issued',
      clearJournalThrows: true,
    });
    expect(thrown?.message).toMatch(/no promote was sent/);
    expect(order.indexOf('dbUnfence')).toBeLessThan(order.indexOf('clearJournal'));
    expect(order).toContain('startWriters');
  });

  it('SIGINT-equivalent rerun (marker, no journal): lifts the stranded fence before the proof, then fails over', async () => {
    const { order, thrown } = await run({
      primaryReachable: true,
      envConfig: baseEnvConfig({
        ha: { writeFence: { node: 'myapp-prod-primary', ip: PRIMARY_IP, at: 'x' } },
      }),
    });
    expect(thrown).toBeUndefined();
    expect(order[0]).toBe('liftStranded');
    expect(order[1]).toBe('clearMarker');
    expect(order.indexOf('liftStranded')).toBeLessThan(order.indexOf('readStandby'));
    // The rerun fences again, after the lift.
    expect(order.indexOf('marker')).toBeGreaterThan(order.indexOf('liftStranded'));
    expect(order).toContain('promote');
  });

  it('rerun with a marker and a journal: the journal flow owns it, no lift', async () => {
    const { order } = await run({
      primaryReachable: true,
      envConfig: baseEnvConfig({
        ha: {
          writeFence: { node: 'myapp-prod-primary', ip: PRIMARY_IP, at: 'x' },
          failoverInFlight: { target: 'standby', systemIdentifier: SYSID },
        },
      }),
    });
    expect(order).not.toContain('liftStranded');
  });

  it('a stranded fence that cannot be lifted stops the rerun before anything else', async () => {
    const { order, thrown } = await run({
      primaryReachable: true,
      liftSucceeds: false,
      envConfig: baseEnvConfig({
        ha: { writeFence: { node: 'myapp-prod-primary', ip: PRIMARY_IP, at: 'x' } },
      }),
    });
    expect(thrown?.message).toMatch(/still write-fenced from an interrupted failover/);
    expect(order).toEqual(['liftStranded']);
  });

  it('unplanned: no fence, no gate, before the promote', async () => {
    const { order, captured, thrown } = await run({ primaryReachable: false });
    expect(thrown).toBeUndefined();
    const beforePromote = order.slice(0, order.indexOf('promote'));
    for (const step of ['stopWriters', 'dbFence', 'fence', 'catchUp']) {
      expect(beforePromote).not.toContain(step);
    }
    expect((captured.journal as { primaryLsn: unknown }).primaryLsn).toBeNull();
  });

  it('the writer stop skips absent add-ons and reports what it stopped; the start never runs app-migrate', async () => {
    const { stopOldPrimaryWriters, startOldPrimaryWriters } = await import(
      '../../../src/lib/deploy/compose/ha.js'
    );
    vi.mocked(composeSsh.sshRun).mockImplementationOnce(
      async () => 'STOPPED myapp-app\nFENCE_DONE',
    );
    await expect(stopOldPrimaryWriters(PRIMARY_IP, '/k', 'myapp', ['app', 'n8n'])).resolves.toEqual(
      {
        ok: true,
        stopped: ['myapp-app'],
      },
    );
    vi.mocked(composeSsh.sshRun).mockImplementationOnce(
      async () => 'STOPPED myapp-app\nFAILED myapp-n8n\nFENCE_DONE',
    );
    await expect(stopOldPrimaryWriters(PRIMARY_IP, '/k', 'myapp', ['app', 'n8n'])).resolves.toEqual(
      {
        ok: false,
        stopped: ['myapp-app'],
      },
    );
    // A dropped session never printed FENCE_DONE: not confirmed.
    vi.mocked(composeSsh.sshRun).mockImplementationOnce(async () => false);
    await expect(stopOldPrimaryWriters(PRIMARY_IP, '/k', 'myapp', ['app', 'n8n'])).resolves.toEqual(
      {
        ok: false,
        stopped: [],
      },
    );
    sshCalls.length = 0;
    await startOldPrimaryWriters(PRIMARY_IP, '/k', ['myapp-app']);
    expect(sshCalls).toEqual([{ ip: PRIMARY_IP, command: 'docker start myapp-app' }]);
  });
});

describe('failoverComposeHA on a role-swapped env (C2)', () => {
  /** What one compose failover leaves: the born-primary node now carries role standby. */
  const swapped = () =>
    baseEnvConfig({
      lastFailover: '2026-10-05T00:00:00.000Z',
      servers: [
        { name: 'myapp-prod-primary', role: 'standby', ip: PRIMARY_IP, region: 'nbg1' },
        { name: 'myapp-prod-standby', role: 'primary', ip: STANDBY_IP, region: 'ash' },
      ],
    });

  it('throws before any ssh call, naming the retired node and the documented recovery', async () => {
    const { thrown } = await run({ envConfig: swapped(), noSeams: true });
    expect(thrown?.message).toMatch(/already failed over/);
    expect(thrown?.message).toMatch(/second failover/);
    expect(thrown?.message).toContain(PRIMARY_IP);
    expect(thrown?.message).toContain('vibecarbon deploy prod');
    expect(thrown?.message).not.toContain('vibecarbon destroy');
    expect(thrown?.message).not.toMatch(/—/);
    expect(composeSsh.sshRun).not.toHaveBeenCalled();
    expect(composeSsh.sshRunAsync).not.toHaveBeenCalled();
    expect(composeSsh.sshRunChecked).not.toHaveBeenCalled();
  });

  it('refuses even a dry run (the preview would describe a reseed from the node itself)', async () => {
    const envConfig = swapped();
    const projectConfig = { projectName: 'myapp', environments: { prod: envConfig } };
    await expect(
      failoverComposeHA(
        'prod',
        envConfig,
        projectConfig,
        { yes: true, dryRun: true },
        {
          spinner: () => ({ start() {}, stop() {} }),
        },
      ),
    ).rejects.toThrow(/already failed over/);
    expect(composeSsh.sshRun).not.toHaveBeenCalled();
  });

  it('a swapped pair a deploy reconverged fails over again, reseeding over the primary own address', async () => {
    // The role primary (PRIMARY_IP) was born as the -standby stack: its tunnel
    // address is 10.99.0.2, and that is what the reseed must dial.
    const reconverged = baseEnvConfig({
      servers: [
        { name: 'myapp-prod-standby', role: 'primary', ip: PRIMARY_IP, region: 'ash' },
        { name: 'myapp-prod-primary', role: 'standby', ip: STANDBY_IP, region: 'nbg1' },
      ],
    });
    const { captured, thrown } = await run({
      envConfig: reconverged,
      primaryReachable: true,
      standbyState: replica({ receiverStatus: null }),
      primaryState: primaryDb(),
      seededState: replica({ receiverStatus: 'streaming' }),
    });
    expect(thrown).toBeUndefined();
    expect(captured.reseedArgs).toEqual([STANDBY_IP, PRIMARY_IP]);
    expect(captured.reseedOpts).toEqual({ primaryHost: '10.99.0.2' });
  });
});

describe('promoteComposeStandby (proof, not inference)', () => {
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
    return async () => ({ inRecovery: seq[Math.min(i++, seq.length - 1)] });
  };
  const promotes = () => sshCalls.filter((c) => c.command.includes('pg_promote'));

  it("'promoted' needs an in-recovery read right before pg_promote, then an out-of-recovery one", async () => {
    const verdict = await promoteComposeStandby(STANDBY_IP, '/k', '/opt/myapp', {
      readState: readSeq([true, true, false]),
      ...fakeTime(),
    });
    expect(verdict).toBe('promoted');
    expect(promotes()).toHaveLength(1);
    expect(promotes()[0].ip).toBe(STANDBY_IP);
  });

  it("a standby already out of recovery is 'not-issued' and pg_promote is never sent", async () => {
    const verdict = await promoteComposeStandby(STANDBY_IP, '/k', '/opt/myapp', {
      readState: readSeq([false]),
      ...fakeTime(),
    });
    expect(verdict).toBe('not-issued');
    expect(promotes()).toEqual([]);
  });

  it('sends pg_promote without a server-side wait, so the one deadline bounds the window', async () => {
    await promoteComposeStandby(STANDBY_IP, '/k', '/opt/myapp', {
      readState: readSeq([true, false]),
      ...fakeTime(),
    });
    expect(promotes()[0].command).toContain('pg_promote(wait => false)');
  });

  it("still in recovery at the deadline is 'unknown', with one pg_promote and no retry", async () => {
    const verdict = await promoteComposeStandby(STANDBY_IP, '/k', '/opt/myapp', {
      readState: readSeq([true]),
      ...fakeTime(),
    });
    expect(verdict).toBe('unknown');
    expect(promotes()).toHaveLength(1);
  });

  it('a failed pg_promote call that landed anyway is proven by the read, not by its exit', async () => {
    vi.mocked(composeSsh.sshRun).mockImplementationOnce((async () => false) as never);
    const verdict = await promoteComposeStandby(STANDBY_IP, '/k', '/opt/myapp', {
      readState: readSeq([true, false]),
      ...fakeTime(),
    });
    expect(verdict).toBe('promoted');
  });
});

describe('swapComposeHaRoles (the terminal save)', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('flips the roles in place, marks replication degraded and clears the journal in one save', () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-compose-swap-'));
    const env = baseEnvConfig({
      ha: { failoverInFlight: { target: 'standby', systemIdentifier: SYSID } },
    });
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ projectName: 'myapp', environments: { prod: env } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    swapComposeHaRoles('prod', { override: 'force-unproven' });

    const saved = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).environments
      .prod;
    expect(saved.servers.map((sv: { name: string; role: string }) => [sv.name, sv.role])).toEqual([
      ['myapp-prod-primary', 'standby'],
      ['myapp-prod-standby', 'primary'],
    ]);
    expect(saved.region).toBe('ash');
    expect(saved.secondaryRegion).toBe('nbg1');
    expect(saved.replication).toBe('degraded');
    expect(saved.degraded).toBe(true);
    expect(saved.ha.failoverInFlight).toBeUndefined();
    expect(saved.ha.systemIdentifier).toBe(SYSID);
    expect(saved.lastFailoverOverride).toBe('force-unproven');
    expect(typeof saved.lastFailover).toBe('string');
  });
});

describe('failoverComposeHA DNS flip is verified (R5)', () => {
  const managedDns = () =>
    baseEnvConfig({ domain: 'app.example.com', dns: { provider: 'cloudflare', zoneId: 'z1' } });

  it('a confirmed flip completes cleanly, after the promote and before the swap', async () => {
    const { order, captured, thrown } = await run({ envConfig: managedDns() });
    expect(thrown).toBeUndefined();
    expect(captured.dnsIp).toBe(STANDBY_IP);
    expect(order.indexOf('promote')).toBeLessThan(order.indexOf('dns'));
    expect(order.indexOf('dns')).toBeLessThan(order.indexOf('swap'));
  });

  it('a flip the provider does not confirm persists the swap, then exits non-zero with DNS DID NOT', async () => {
    const { order, thrown } = await run({
      envConfig: managedDns(),
      dnsFlip: { ok: false, reason: 'app.example.com reads back as 10.0.0.1, not 10.0.0.2' },
    });
    expect(thrown?.message).toMatch(/DNS DID NOT/);
    expect(thrown?.message).toContain('app.example.com');
    expect(thrown?.message).toContain(STANDBY_IP);
    expect(thrown?.name).toBe('FailoverDnsError');
    // The promote happened, so the roles must be saved (the journal clears with them).
    expect(order).toContain('swap');
    expect(order.indexOf('swap')).toBeGreaterThan(order.indexOf('dns'));
  });

  it('manual DNS is not an error: instructions print and the failover completes', async () => {
    const { order, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(order).not.toContain('dns');
  });

  it('flipComposeDns: a missing DNS token is a failed flip, never a skipped one', async () => {
    dnsToken = '';
    try {
      const result = await flipComposeDns(managedDns(), STANDBY_IP);
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason: expect.stringMatching(/not set/) });
    } finally {
      dnsToken = 'dns-token';
    }
  });

  it('rerunning failover after a DNS-failed (swap-persisted) failover is refused before any mutation', async () => {
    const first = await run({
      envConfig: managedDns(),
      dnsFlip: { ok: false, reason: 'app.example.com reads back as 10.0.0.1, not 10.0.0.2' },
    });
    expect(first.thrown?.message).toMatch(/DNS DID NOT/);
    expect(first.order).toContain('swap');
    sshCalls.length = 0; // the first run's remote commands are not the rerun's
    const rerun = await run({
      envConfig: baseEnvConfig({
        domain: 'app.example.com',
        dns: { provider: 'cloudflare', zoneId: 'z1' },
        lastFailover: '2026-10-05T00:00:00.000Z',
        servers: [
          { role: 'primary', ip: PRIMARY_IP, region: 'nbg1' },
          { role: 'standby', ip: STANDBY_IP, region: 'ash' },
        ],
      }),
    });
    expect(rerun.thrown).toBeInstanceOf(FailoverRefusedError);
    expect(rerun.thrown?.message).toMatch(/vibecarbon deploy/);
    expectNoMutation(rerun.order);
  });
});
