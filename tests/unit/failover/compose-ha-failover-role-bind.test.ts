/**
 * compose-HA failover refuses a db container from before the role bind
 * (B9, the compose twin of the k8s STEP 1 role-mount refusal, C18).
 *
 * The failover arms the promoted node's wal-g role by writing
 * /opt/<p>/.vibecarbon-role/walg-role on the host. A db container created from
 * a scaffold before the role file has no bind of that directory and keeps
 * reading the old role env, so the write would never reach it. Refuse before
 * anything changes, naming `vibecarbon deploy` (which recreates the db with
 * the bind). A resumed failover already promoted, so it is let finish. An
 * unreadable container is left to the replica proof, like an unreadable pod.
 *
 * Every step after the probe is an injected seam that records its call; the
 * replica-state read throws a sentinel so a passing guard is observable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sshCalls: string[] = [];
vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = async (_ip: string, _k: string, command: unknown) => {
    sshCalls.push(String(command));
    return '';
  };
  return { ...actual, sshRun: vi.fn(rec), sshRunAsync: vi.fn(rec), sshRunChecked: vi.fn(rec) };
});
vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    sshRun: vi.fn(async (_ip: string, _k: string, argv: string[]) => {
      sshCalls.push(argv.join(' '));
      return '';
    }),
  };
});

const { failoverComposeHA } = await import('../../../src/lib/deploy/compose/ha.js');
const { FailoverRefusedError } = await import('../../../src/lib/deploy/failover-guard.js');

const PRIMARY = '1.1.1.1';
const STANDBY = '2.2.2.2';
const baseEnv = () => ({
  deployMode: 'compose-ha',
  replication: 'streaming',
  deployedAt: '2026-10-01T00:00:00.000Z',
  ha: { enabled: true, systemIdentifier: '7412345678901234567' } as Record<string, unknown>,
  domain: 'app.example.com',
  servers: [
    { role: 'primary', ip: PRIMARY, region: 'nbg1' },
    { role: 'standby', ip: STANDBY, region: 'ash' },
  ],
});
const projectConfig = { projectName: 'myapp', environments: {} };
const tracker = { spinner: () => ({ start() {}, stop() {}, message() {} }) };
const PASSED = new Error('passed the role-bind guard');

/** Every seam that changes something, as a recorder. */
function seams(bind: Record<string, boolean | null>, planned: boolean) {
  const changes = {
    liftStranded: vi.fn(async () => {}),
    reseed: vi.fn(async () => {}),
    writeJournal: vi.fn(),
    promote: vi.fn(async () => true),
    stopWriters: vi.fn(async () => []),
    fenceWrites: vi.fn(async () => true),
    writeMarker: vi.fn(),
    fenceOldPrimary: vi.fn(async () => {}),
    swapRoles: vi.fn(),
    flipDns: vi.fn(async () => {}),
    armWalgRole: vi.fn(async () => {}),
    writeFence: vi.fn(async () => {}),
  };
  const probeRoleBind = vi.fn(async ({ ip }: { ip: string }) => bind[ip] ?? null);
  const deps = {
    ...changes,
    keyExists: () => true,
    isPrimaryReachable: vi.fn(async () => planned),
    readState: vi.fn(async () => {
      throw PASSED;
    }),
    probeRoleBind,
  };
  return { deps, changes, probeRoleBind };
}
async function failover(env: ReturnType<typeof baseEnv>, deps: Record<string, unknown>) {
  return failoverComposeHA('prod', env, projectConfig, { yes: true }, tracker, deps).catch(
    (e) => e,
  );
}
function expectNothingChanged(changes: Record<string, ReturnType<typeof vi.fn>>) {
  for (const [name, fn] of Object.entries(changes)) {
    expect(fn, `${name} ran before the refusal`).not.toHaveBeenCalled();
  }
  expect(sshCalls).toEqual([]);
}

describe('compose-HA failover: the db container must bind the role directory', () => {
  beforeEach(() => {
    sshCalls.length = 0;
  });

  it('a standby db without the bind refuses before any change, naming the deploy', async () => {
    const { deps, changes, probeRoleBind } = seams({ [STANDBY]: false, [PRIMARY]: true }, true);
    const err = await failover(baseEnv(), deps);
    expect(err).toBeInstanceOf(FailoverRefusedError);
    expect(err.message).toBe(
      "Failover refused: the standby's db predates the live wal-g role (no " +
        '/var/lib/vibecarbon/role bind on myapp-db at 2.2.2.2); run `vibecarbon deploy prod` ' +
        'once (one db restart), then retry. The failover did not start: the databases, their ' +
        'wal-g roles and DNS are unchanged.',
    );
    expect(probeRoleBind).toHaveBeenCalledWith(
      expect.objectContaining({ ip: STANDBY, projectName: 'myapp' }),
    );
    expectNothingChanged(changes);
  });

  it('a reachable primary db without the bind refuses too (it would be demoted by a write nobody reads)', async () => {
    const { deps, changes } = seams({ [STANDBY]: true, [PRIMARY]: false }, true);
    const err = await failover(baseEnv(), deps);
    expect(err).toBeInstanceOf(FailoverRefusedError);
    expect(err.message).toContain("the primary's db predates the live wal-g role");
    expect(err.message).toContain('at 1.1.1.1');
    expectNothingChanged(changes);
  });

  it('an unreachable primary is not probed; a bound standby passes', async () => {
    const { deps, probeRoleBind } = seams({ [STANDBY]: true }, false);
    expect(await failover(baseEnv(), deps)).toBe(PASSED);
    expect(probeRoleBind.mock.calls.map(([a]) => a.ip)).toEqual([STANDBY]);
  });

  it('both bound: passes on to the replica proof', async () => {
    const { deps, probeRoleBind } = seams({ [STANDBY]: true, [PRIMARY]: true }, true);
    expect(await failover(baseEnv(), deps)).toBe(PASSED);
    expect(probeRoleBind).toHaveBeenCalledTimes(2);
  });

  it('an unreadable container (null) is left to the replica proof, never a refusal', async () => {
    const { deps } = seams({ [STANDBY]: null, [PRIMARY]: null }, true);
    expect(await failover(baseEnv(), deps)).toBe(PASSED);
  });

  it('a resumed failover (journal set) is let finish: no probe', async () => {
    const env = baseEnv();
    env.ha.failoverInFlight = { attemptId: 'a1', startedAt: '2026-11-01T00:00:00Z' };
    const { deps, probeRoleBind } = seams({ [STANDBY]: false, [PRIMARY]: false }, false);
    expect(await failover(env, deps)).toBe(PASSED);
    expect(probeRoleBind).not.toHaveBeenCalled();
  });

  it('a dry run probes nothing', async () => {
    const { deps, probeRoleBind } = seams({ [STANDBY]: false }, true);
    await failoverComposeHA('prod', baseEnv(), projectConfig, { dryRun: true }, tracker, deps);
    expect(probeRoleBind).not.toHaveBeenCalled();
  });
});
