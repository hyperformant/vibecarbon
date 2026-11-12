/**
 * upStack asked with `refuseServerReplace` (the compose deploy's seal up on a
 * recorded server, PR 2 final review C1(b)): a preview after the refresh, and
 * no up when its plan would replace, delete or create a server
 * (src/lib/iac/server-replace-guard.js). The real engine's answer is
 * tests/integration/iac/state-seal.test.ts (f).
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
const { ServerReplaceRefusedError } = await import('../../../src/lib/iac/server-replace-guard.js');

const SERVER = 'hcloud:index/server:Server';
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
/** A preview whose plan is these (op, type) steps. */
const planOf =
  (...steps: Array<[string, string]>) =>
  (_name: string, options: unknown) => {
    const { onEvent } = options as { onEvent: (e: unknown) => void };
    for (const [op, type] of steps) {
      onEvent({
        resourcePreEvent: {
          metadata: { op, type, urn: urn(type, 'server'), old: { inputs: { name: 'proj-e1' } } },
        },
      });
    }
    return { changeSummary: {} };
  };
const BASE = { projectName: 'proj', provider: 'hetzner', providerToken: 't' };

describe('upStack with refuseServerReplace', () => {
  beforeEach(() => {
    fakePulumi.reset();
    __resetStateProbesForTests();
    fakePulumi.behaviour.exportStack = () => structuredClone(POPULATED);
  });

  for (const op of ['replace', 'create-replacement', 'delete-replaced', 'delete', 'create']) {
    it(`a plan with a server '${op}': refused after the refresh, and the up never runs`, async () => {
      fakePulumi.behaviour.preview = planOf(['same', 'pulumi:pulumi:Stack'], [op, SERVER]);

      const err = await upStack('e1', async () => ({}), {
        ...BASE,
        refuseServerReplace: true,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ServerReplaceRefusedError);
      expect((err as { removals: Array<{ op: string; name: string }> }).removals).toEqual([
        expect.objectContaining({ op, name: 'proj-e1' }),
      ]);
      expect(fakePulumi.calls).toContain('refresh');
      expect(fakePulumi.calls.indexOf('preview')).toBeGreaterThan(
        fakePulumi.calls.indexOf('refresh'),
      );
      expect(fakePulumi.calls).not.toContain('up');
      expect(fakePulumi.imports).toEqual([]);
    });
  }

  it('a plan that keeps or updates the server, or replaces something else: previewed, then the up runs', async () => {
    fakePulumi.behaviour.preview = planOf(
      ['same', SERVER],
      ['update', SERVER],
      ['replace', 'hcloud:index/sshKey:SshKey'],
    );

    await upStack('e1', async () => ({}), { ...BASE, refuseServerReplace: true });

    const preview = fakePulumi.calls.indexOf('preview');
    expect(preview).toBeGreaterThan(fakePulumi.calls.indexOf('refresh'));
    expect(fakePulumi.calls.indexOf('up')).toBeGreaterThan(preview);
  });

  it('without it (every other up): no preview', async () => {
    fakePulumi.behaviour.preview = planOf(['replace', SERVER]);

    await upStack('e1', async () => ({}), BASE);

    expect(fakePulumi.calls).not.toContain('preview');
    expect(fakePulumi.calls).toContain('up');
  });
});
