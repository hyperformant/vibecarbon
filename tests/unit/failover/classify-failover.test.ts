/**
 * Failover classification from the standby's vantage point (HA-correctness
 * Task 6, R8).
 *
 * "My machine cannot reach the primary" used to mean "the primary is dead", so
 * an operator partitioned from a healthy primary got an unplanned failover:
 * no fence, a second primary, two sides taking writes. The standby is the
 * better witness: its walreceiver says whether the primary is still streaming
 * to it. A receiver that is `streaming` with a message under 60 s old means the
 * primary is alive, and failover refuses unless the operator passes
 * `-force-unplanned`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  getPostgresPod: vi.fn(async () => 'db-0'),
  sshKubectl: vi.fn(),
}));

const { classifyFailover, FailoverRefusedError, PRIMARY_ALIVE_MAX_AGE_S } = await import(
  '../../../src/lib/deploy/failover-guard.js'
);
const { failoverHA, SPEC } = await import('../../../src/failover.js');
const { failoverComposeHA } = await import('../../../src/lib/deploy/compose/ha.js');

const SYSID = '7412345678901234567';

type State = {
  inRecovery: boolean | null;
  systemIdentifier: string | null;
  replayLsn: string | null;
  receiverStatus: string | null;
  lastMsgAgeS: number | null;
};
const standby = (over: Partial<State> = {}): State => ({
  inRecovery: true,
  systemIdentifier: SYSID,
  replayLsn: '0/3000060',
  receiverStatus: 'streaming',
  lastMsgAgeS: 2,
  ...over,
});

describe('classifyFailover', () => {
  it('the threshold is the 60 s R8 names', () => {
    expect(PRIMARY_ALIVE_MAX_AGE_S).toBe(60);
  });

  it('primary reachable: planned, whatever the standby says', () => {
    expect(classifyFailover({ primaryReachable: true, standbyState: standby() })).toBe('planned');
    expect(
      classifyFailover({ primaryReachable: true, standbyState: standby({ receiverStatus: null }) }),
    ).toBe('planned');
  });

  it('primary unreachable from here but streaming fresh to the standby: refuse-primary-alive', () => {
    expect(classifyFailover({ primaryReachable: false, standbyState: standby() })).toBe(
      'refuse-primary-alive',
    );
    expect(
      classifyFailover({ primaryReachable: false, standbyState: standby({ lastMsgAgeS: 59 }) }),
    ).toBe('refuse-primary-alive');
  });

  it('a streaming receiver whose age cannot be read counts as alive (fail safe)', () => {
    expect(
      classifyFailover({ primaryReachable: false, standbyState: standby({ lastMsgAgeS: null }) }),
    ).toBe('refuse-primary-alive');
  });

  it('a stale receiver: unplanned', () => {
    expect(
      classifyFailover({ primaryReachable: false, standbyState: standby({ lastMsgAgeS: 60 }) }),
    ).toBe('unplanned');
    expect(
      classifyFailover({ primaryReachable: false, standbyState: standby({ lastMsgAgeS: 900 }) }),
    ).toBe('unplanned');
  });

  it('no receiver at all (the primary is gone): unplanned', () => {
    for (const receiverStatus of [null, 'waiting', 'starting', 'stopping']) {
      expect(
        classifyFailover({
          primaryReachable: false,
          standbyState: standby({ receiverStatus, lastMsgAgeS: null }),
        }),
      ).toBe('unplanned');
    }
    expect(classifyFailover({ primaryReachable: false, standbyState: null })).toBe('unplanned');
  });
});

describe('-force-unplanned is a single-dash failover flag', () => {
  it('is in the failover SPEC, boolean, with help that says why', () => {
    const flag = SPEC.flags.find((f: { name: string }) => f.name === 'force-unplanned');
    expect(flag).toBeDefined();
    expect(flag?.boolean).toBe(true);
    expect(flag?.description).toMatch(/standby/);
    expect(flag?.description).not.toMatch(/—/);
  });
});

/** The first mutating step of either flow: reaching it means the classification let it through. */
const MUTATION = /^(provision|stopWriters|journal|reseed)$/;

/** Stop the flow at the first mutation, recording that it was reached. */
class Reached extends Error {
  constructor(public step: string) {
    super(`reached ${step}`);
  }
}

async function runK8s({
  standbyState,
  flags = {},
}: {
  standbyState: State;
  flags?: Record<string, unknown>;
}) {
  const order: string[] = [];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    order.push(`exit(${code})`);
    throw new Error('__exit__');
  }) as never);
  const deps = {
    identify: () => ({
      primary: { ip: '10.0.0.1', floatingIp: '10.0.0.1', region: 'nbg1' },
      standby: { ip: '10.0.0.9', floatingIp: '10.0.0.99', region: 'ash' },
    }),
    getKeyPath: () => '/fake/key',
    keyExists: () => true,
    preflight: async () => ({ workerSpec: {}, scaleUpList: [], creds: {} }),
    provision: async () => {
      order.push('provision');
      throw new Reached('provision');
    },
    isPrimaryReady: async () => false,
    readStandbyState: async () => standbyState,
    readPrimaryState: async () => null,
    psql: () => async () => '',
    confirmUnproven: async () => {},
  };
  const envConfig = {
    replication: 'streaming',
    deployedAt: '2026-10-01T00:00:00.000Z',
    ha: {
      primary: { masterIp: '10.0.0.1' },
      standby: { masterIp: '10.0.0.9' },
      systemIdentifier: SYSID,
    },
  };
  let thrown: unknown;
  try {
    await failoverHA(
      'prod',
      envConfig,
      {},
      { dryRun: false, yes: true, ...flags },
      { spinner: () => ({ start() {}, stop() {} }) },
      { updateDns: null },
      // biome-ignore lint/suspicious/noExplicitAny: injected test deps bag.
      deps as any,
    );
  } catch (err) {
    thrown = err;
  } finally {
    exitSpy.mockRestore();
  }
  return { order, thrown: thrown as Error | undefined };
}

async function runCompose({
  standbyState,
  flags = {},
}: {
  standbyState: State;
  flags?: Record<string, unknown>;
}) {
  const order: string[] = [];
  const envConfig = {
    deployMode: 'compose-ha',
    replication: 'streaming',
    deployedAt: '2026-10-01T00:00:00.000Z',
    servers: [
      { name: 'myapp-prod-primary', role: 'primary', ip: '10.0.0.1', region: 'nbg1' },
      { name: 'myapp-prod-standby', role: 'standby', ip: '10.0.0.2', region: 'ash' },
    ],
    ha: { enabled: true, systemIdentifier: SYSID },
  };
  const deps = {
    keyExists: () => true,
    isPrimaryReachable: async () => false,
    readState: async () => standbyState,
    psql: () => async () => '',
    stopWriters: async () => {
      order.push('stopWriters');
      throw new Reached('stopWriters');
    },
    writeJournal: async () => {
      order.push('journal');
      throw new Reached('journal');
    },
    reseed: async () => {
      order.push('reseed');
      throw new Reached('reseed');
    },
    confirmUnproven: async () => {},
  };
  let thrown: unknown;
  try {
    await failoverComposeHA(
      'prod',
      envConfig,
      { projectName: 'myapp' },
      { dryRun: false, yes: true, ...flags },
      { spinner: () => ({ start() {}, stop() {}, message() {} }) },
      // biome-ignore lint/suspicious/noExplicitAny: injected test deps bag.
      deps as any,
    );
  } catch (err) {
    thrown = err;
  }
  return { order, thrown: thrown as Error | undefined };
}

describe.each([
  ['k8s-ha', runK8s],
  ['compose-ha', runCompose],
] as const)('%s failover classifies from the standby', (_tier, drive) => {
  afterEach(() => vi.restoreAllMocks());

  it('operator cut off from a primary that still streams: refuses naming -force-unplanned, before any write', async () => {
    const { order, thrown } = await drive({ standbyState: standby() });
    expect(thrown).toBeInstanceOf(FailoverRefusedError);
    expect(thrown?.message).toContain(
      'the primary is still streaming to the standby; your machine cannot reach it. ' +
        'Rerun with -force-unplanned to fail over anyway',
    );
    expect(order).toEqual([]);
  });

  it('-force-unplanned overrides the refusal and the unplanned path runs', async () => {
    const { order, thrown } = await drive({
      standbyState: standby(),
      flags: { forceUnplanned: true },
    });
    expect(thrown).not.toBeInstanceOf(FailoverRefusedError);
    expect(order[0]).toMatch(MUTATION);
  });

  it('a stale receiver is unplanned and runs without the flag', async () => {
    const { order, thrown } = await drive({ standbyState: standby({ lastMsgAgeS: 300 }) });
    expect(thrown).not.toBeInstanceOf(FailoverRefusedError);
    expect(order[0]).toMatch(MUTATION);
  });
});
