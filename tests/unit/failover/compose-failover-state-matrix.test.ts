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
 * C2: after one compose failover the roles are swapped in config, but the
 * WireGuard address the reseed dials (10.99.0.1) stays on the node born as the
 * primary. A second failover would reseed the retired node from its own
 * address. It is refused before any ssh call.
 *
 * The guard reads, reseed, journal, promote, fence and swap are injected seams;
 * the post-promote steps run against the mocked compose ssh layer.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sshCalls: Array<{ ip: string; command: string }> = [];

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

const composeSsh = await import('../../../src/lib/deploy/compose/index.js');
const { failoverComposeHA, promoteComposeStandby, swapComposeHaRoles } = await import(
  '../../../src/lib/deploy/compose/ha.js'
);
const { FailoverRefusedError } = await import('../../../src/lib/deploy/failover-guard.js');

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
  /** Pass no seams at all (the real ssh-backed defaults run). */
  noSeams?: boolean;
}

async function run(opts: RunOpts = {}) {
  const {
    envConfig = baseEnvConfig(),
    primaryReachable = false,
    standbyState = replica(),
    seededState = replica(),
    primaryState = primaryDb(),
    promoteVerdict = 'promoted',
    promoteThrows = false,
    flags = {},
    noSeams = false,
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
    reseed: async (standbyIp: string, primaryIp: string) => {
      order.push('reseed');
      captured.reseedArgs = [standbyIp, primaryIp];
      reseeded = true;
      return true;
    },
    recordSeeded: (_ctx: unknown, sysid: string) => {
      order.push('recordSeeded');
      captured.recordedSysid = sysid;
    },
    clearJournal: async () => {
      order.push('clearJournal');
    },
    writeJournal: async (_ctx: unknown, journal: Record<string, unknown>) => {
      order.push('journal');
      captured.journal = journal;
      return 'journal-id';
    },
    promote: async () => {
      order.push('promote');
      if (promoteThrows) throw new Error('ssh dropped');
      return promoteVerdict;
    },
    fenceOldPrimary: async (ip: string) => {
      order.push('fence');
      captured.fencedIp = ip;
      return true;
    },
    confirmUnproven: async () => {
      order.push('confirmUnproven');
    },
    swapRoles: (_env: string, o?: { override?: string }) => {
      order.push('swap');
      captured.swapOverride = o?.override;
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
const MUTATIONS = ['reseed', 'journal', 'promote', 'fence', 'swap'];
function expectNoMutation(order: string[]) {
  for (const step of MUTATIONS) expect(order, `refusal reached ${step}`).not.toContain(step);
  expect(sshCalls, 'a refusal ran a remote command').toEqual([]);
}

beforeEach(() => {
  sshCalls.length = 0;
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
      standbyState: replica({ systemIdentifier: OTHER_SYSID }),
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
    expect(order.indexOf('reseed')).toBeLessThan(order.indexOf('recordSeeded'));
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
    expect(thrown?.message).toMatch(/swapped/);
    expect(thrown?.message).toMatch(/second failover/);
    expect(thrown?.message).toContain(PRIMARY_IP);
    expect(thrown?.message).toContain('vibecarbon destroy prod');
    expect(thrown?.message).toContain('vibecarbon deploy prod');
    expect(thrown?.message).toContain('vibecarbon restore prod');
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
    ).rejects.toThrow(/swapped/);
    expect(composeSsh.sshRun).not.toHaveBeenCalled();
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
