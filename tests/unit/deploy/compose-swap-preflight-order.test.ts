/**
 * The ledger preflight (db-ledger-preflight.js) only protects production if
 * it runs before the server is touched: before the bundle upload (which
 * rewrites the old stack's compose files), the image transfer or build, and
 * the stack swap. On compose-ha it reads both servers. A refusal is a thrown
 * error, so the runner stops there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planDeploy } from '../../../src/lib/deploy/plan/deploy-plan.js';

const H = vi.hoisted(() => ({ calls: [] as unknown[][], refuse: false }));

vi.mock('../../../src/lib/deploy/compose/db-ledger-preflight.js', () => ({
  assertDbMadeByThisStack: vi.fn(async (...args: unknown[]) => {
    H.calls.push(args);
    if (H.refuse) throw new Error('created by an older vibecarbon stack');
  }),
}));

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

beforeEach(() => {
  H.calls.length = 0;
  H.refuse = false;
});

const names = (tier: 'compose' | 'compose-ha') => planDeploy(tier, {}).map((s) => s.name);
const runsBefore = (list: string[], a: string, b: string) => {
  expect(list.indexOf(a), `${a} is in the plan`).toBeGreaterThanOrEqual(0);
  expect(list.indexOf(b), `${b} is in the plan`).toBeGreaterThanOrEqual(0);
  expect(list.indexOf(a), `${a} runs before ${b}`).toBeLessThan(list.indexOf(b));
};

describe('compose: check-db-ledger runs before the server is touched', () => {
  const plan = names('compose');

  it('after docker is ready, before the image transfer, the bundle upload and the swap', () => {
    runsBefore(plan, 'setup-server', 'check-db-ledger');
    for (const later of ['transfer-image', 'setup-server-files', 'start-compose-stack']) {
      runsBefore(plan, 'check-db-ledger', later);
    }
  });

  it('has no when-gate: every deploy reads (a first deploy passes on no container)', () => {
    expect(planDeploy('compose', {}).find((s) => s.name === 'check-db-ledger')?.when).toBeFalsy();
  });

  it('reads the one server, and a refusal propagates', async () => {
    const ctx = { serverIp: '1.1.1.1', sshKeyPath: '/k', projectConfig: { projectName: 'acme' } };
    await EFFECTS.checkDbLedger(ctx as never);
    expect(H.calls).toEqual([[['1.1.1.1'], '/k', 'acme']]);
    H.refuse = true;
    await expect(EFFECTS.checkDbLedger(ctx as never)).rejects.toThrow(/older vibecarbon/);
  });
});

describe('compose-ha: both servers are read before either is touched', () => {
  const plan = names('compose-ha');

  it('after docker is ready on both, before the build, the bundle upload and the swap', () => {
    runsBefore(plan, 'wait-docker-ready', 'check-db-ledger');
    for (const later of [
      'remote-build',
      'setup-server-files',
      'pull-images',
      'start-compose-stack',
    ]) {
      runsBefore(plan, 'check-db-ledger', later);
    }
  });

  it('reads primary then standby, and a refusal propagates', async () => {
    const ctx = {
      primary: { ip: '1.1.1.1' },
      standby: { ip: '2.2.2.2' },
      sshKeyPath: '/k',
      projectConfig: { projectName: 'acme' },
      onProgress: () => {},
    };
    await COMPOSE_HA_EFFECTS.haCheckDbLedger(ctx as never);
    expect(H.calls).toEqual([[['1.1.1.1', '2.2.2.2'], '/k', 'acme']]);
    H.refuse = true;
    await expect(COMPOSE_HA_EFFECTS.haCheckDbLedger(ctx as never)).rejects.toThrow(
      /older vibecarbon/,
    );
  });
});
