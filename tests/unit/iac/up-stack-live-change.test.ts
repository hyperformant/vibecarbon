/**
 * upStack asked with `refuseLiveChanges` (the compose deploy's seal up on a
 * recorded server, PR 2 final review C1(b), ruling R36): a preview after the
 * refresh, and no up when its plan would change the server or replace or
 * delete anything (src/lib/iac/live-change-guard.js). The real engine's
 * answer is tests/integration/iac/state-seal.test.ts (f).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePulumi } from '../../_shared/fake-pulumi-workspace.js';

vi.mock('@pulumi/pulumi/automation/index.js', async () =>
  (await import('../../_shared/fake-pulumi-workspace.js')).fakeAutomationModule(),
);
vi.mock('../../../src/lib/state-passphrase.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async () => 'test-passphrase',
}));
vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: () => {} }));

const { __resetStateProbesForTests, upStack } = await import('../../../src/lib/iac/index.js');
const { LiveChangeRefusedError } = await import('../../../src/lib/iac/live-change-guard.js');

const SERVER = 'hcloud:index/server:Server';
const FIREWALL = 'hcloud:index/firewall:Firewall';
const IP = 'scaleway:instance/ip:Ip';
const urn = (type: string, name: string) => `urn:pulumi:e1::proj::${type}::${name}`;
/** A stack that holds a server, so the up refreshes it first. */
const POPULATED = {
  deployment: {
    resources: [
      { urn: urn('pulumi:pulumi:Stack', 'proj-e1'), type: 'pulumi:pulumi:Stack' },
      { urn: urn(SERVER, 'server'), type: SERVER, inputs: { name: 'proj-e1' } },
    ],
  },
};
/** A preview whose plan is these (op, type, name) steps. */
const planOf =
  (...steps: Array<[string, string, string?]>) =>
  (_name: string, options: unknown) => {
    const { onEvent } = options as { onEvent: (e: unknown) => void };
    for (const [op, type, name = 'proj-e1'] of steps) {
      onEvent({
        resourcePreEvent: {
          metadata: { op, type, urn: urn(type, 'res'), old: { inputs: { name } } },
        },
      });
    }
    return { changeSummary: {} };
  };
const BASE = { projectName: 'proj', provider: 'hetzner', providerToken: 't' };
const refused = (plan: ReturnType<typeof planOf>) => {
  fakePulumi.behaviour.preview = plan;
  return upStack('e1', async () => ({}), { ...BASE, refuseLiveChanges: true }).then(
    () => null,
    (e: unknown) => e as InstanceType<typeof LiveChangeRefusedError>,
  );
};

describe('upStack with refuseLiveChanges', () => {
  beforeEach(() => {
    fakePulumi.reset();
    __resetStateProbesForTests();
    fakePulumi.behaviour.exportStack = () => structuredClone(POPULATED);
  });

  /** Refused after the refresh, before the up, and nothing sealed. */
  const expectNoUp = () => {
    expect(fakePulumi.calls).toContain('refresh');
    expect(fakePulumi.calls.indexOf('preview')).toBeGreaterThan(
      fakePulumi.calls.indexOf('refresh'),
    );
    expect(fakePulumi.calls).not.toContain('up');
    expect(fakePulumi.imports).toEqual([]);
  };

  for (const op of [
    'update',
    'replace',
    'create-replacement',
    'delete-replaced',
    'delete',
    'create',
  ]) {
    it(`a plan with a server '${op}': refused, and the up never runs`, async () => {
      const err = await refused(planOf(['same', 'pulumi:pulumi:Stack'], [op, SERVER]));

      expect(err).toBeInstanceOf(LiveChangeRefusedError);
      expect(err?.changes).toEqual([
        expect.objectContaining({ op, name: 'proj-e1', server: true }),
      ]);
      expectNoUp();
    });
  }

  it('an in-place update of the server (a resize) is refused: it stops a server the deploy never touched', async () => {
    const err = await refused(planOf(['same', FIREWALL, 'proj-e1-fw'], ['update', SERVER]));

    expect(err?.message).toMatch(/^The up for e1 would change Server proj-e1 \(update\), /);
    expectNoUp();
  });

  it('a Scaleway IP replaced is refused, with the server left as it is: the public address would change', async () => {
    const err = await refused(planOf(['same', SERVER], ['replace', IP, 'proj-e1-ip']));

    expect(err?.message).toMatch(/^The up for e1 would change Ip proj-e1-ip \(replace\), /);
    expectNoUp();
  });

  it('a firewall rule updated in place, a new resource, or Pulumi updating its provider: previewed, then the up runs', async () => {
    fakePulumi.behaviour.preview = planOf(
      ['same', SERVER],
      ['update', FIREWALL, 'proj-e1-fw'],
      ['create', 'hcloud:index/firewallAttachment:FirewallAttachment'],
      ['update', 'pulumi:providers:hcloud'],
    );

    await upStack('e1', async () => ({}), { ...BASE, refuseLiveChanges: true });

    const preview = fakePulumi.calls.indexOf('preview');
    expect(preview).toBeGreaterThan(fakePulumi.calls.indexOf('refresh'));
    expect(fakePulumi.calls.indexOf('up')).toBeGreaterThan(preview);
  });

  it('a preview the state backend throttled and the retry ran again: each step listed once', async () => {
    const plan = planOf(['update', SERVER]);
    let calls = 0;
    fakePulumi.behaviour.preview = (name: string, options: unknown) => {
      plan(name, options);
      calls += 1;
      if (calls === 1) {
        throw new Error('error: blob (code=Unknown): SlowDown: Please reduce your request rate.');
      }
      return { changeSummary: {} };
    };

    const err = await upStack('e1', async () => ({}), { ...BASE, refuseLiveChanges: true }).then(
      () => null,
      (e: unknown) => e as InstanceType<typeof LiveChangeRefusedError>,
    );

    expect(calls).toBe(2);
    expect(err?.changes).toHaveLength(1);
    expectNoUp();
  });

  it('without it (every other up): no preview', async () => {
    fakePulumi.behaviour.preview = planOf(['replace', SERVER]);

    await upStack('e1', async () => ({}), BASE);

    expect(fakePulumi.calls).not.toContain('preview');
    expect(fakePulumi.calls).toContain('up');
  });
});
