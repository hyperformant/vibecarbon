import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pulumi state keys are scoped per PROJECT: `.pulumi/stacks/<project>/<stack>.json`.
 *
 * The Pulumi project name used to be the constant 'vibecarbon', which made two
 * vibecarbon projects sharing one state bucket collide on state keys: with an
 * env name in common (`production`), select would SUCCEED on the other
 * project's stack file, program logical names are constants so the URNs match,
 * and `up` would reconcile someone else's live servers (review finding,
 * 2026-08-15). The project-level `stateBucket` pin and the e2e shared bucket
 * both create exactly that sharing.
 *
 * These tests pin the two halves of the fix: the caller's projectName reaches
 * Pulumi as the project (distinct keys per project in a shared bucket), and a
 * missing projectName throws instead of silently defaulting — a defaulted name
 * would READ A DIFFERENT KEY than the deploy wrote, and every "no stack"
 * follow-up (create-empty, orphan handling) is worse than a loud failure.
 */

const selectStackMock = vi.fn();
const createWorkspaceMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called');
    },
    create: (...args: unknown[]) => createWorkspaceMock(...args),
  },
}));

vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));

const s3Config = {
  bucket: 'proj-storage',
  stateBucket: 'acme-shared-state',
  endpoint: 'https://nbg1.your-objectstorage.com',
  region: 'nbg1',
};

const healthyStack = (name: string) => ({
  name,
  cancel: async () => {},
  refresh: async () => ({}),
  exportStack: async () => ({ deployment: { resources: [] } }),
  outputs: async () => ({ serverIp: { value: '1.2.3.4' } }),
  workspace: { removeStack: async () => {} },
  up: async () => ({
    outputs: { serverIp: { value: '1.2.3.4' } },
    summary: { result: 'succeeded' },
  }),
});

beforeEach(() => {
  vi.resetModules();
  selectStackMock.mockReset();
  createWorkspaceMock.mockReset();
  createWorkspaceMock.mockResolvedValue({ listStacks: async () => [] });
});

describe('Pulumi project scoping', () => {
  it('two projects sharing one pinned bucket get DISTINCT state keys', async () => {
    const { upStack } = await import('../../../src/lib/iac/index.js');
    const { resetStateLocksForTest } = await import('../../../src/lib/iac/state-lock.js');
    resetStateLocksForTest();
    selectStackMock.mockImplementation((args: { stackName: string }) =>
      Promise.resolve(healthyStack(args.stackName)),
    );

    // Both projects deploy env `production` into the SAME bucket — the exact
    // collision arrangement. The projectName in stackArgs is what Pulumi keys
    // state under, so distinct names mean distinct keys.
    await upStack('production', () => ({}), { s3Config, projectName: 'acme-app' });
    await upStack('production', () => ({}), { s3Config, projectName: 'globex-app' });

    const projects = selectStackMock.mock.calls.map(
      (c) => (c[0] as { projectName: string }).projectName,
    );
    expect(projects).toContain('acme-app');
    expect(projects).toContain('globex-app');
    // And the workspace settings agree with the stack args — both halves of
    // the Automation API must name the same project or state splits.
    for (const call of selectStackMock.mock.calls) {
      const [stackArgs, wsOpts] = call as [
        { projectName: string },
        { projectSettings: { name: string } },
      ];
      expect(wsOpts.projectSettings.name).toBe(stackArgs.projectName);
    }
  });

  it('listStacks is scoped to the caller project', async () => {
    const { listStacks } = await import('../../../src/lib/iac/index.js');
    await listStacks({ s3Config, projectName: 'acme-app' });
    const settings = createWorkspaceMock.mock.calls[0][0] as {
      projectSettings: { name: string };
    };
    expect(settings.projectSettings.name).toBe('acme-app');
  });

  it('a missing projectName throws loudly on every entry point', async () => {
    const iac = await import('../../../src/lib/iac/index.js');
    const { resetStateLocksForTest } = await import('../../../src/lib/iac/state-lock.js');
    resetStateLocksForTest();
    for (const call of [
      () => iac.upStack('e1', () => ({}), { s3Config }),
      () => iac.getOrCreateStack('e1', () => ({}), { s3Config }),
      () => iac.getStackOutputs('e1', () => ({}), { s3Config }),
      () => iac.destroyStack('e1', () => ({}), { s3Config }),
      () => iac.listStacks({ s3Config }),
    ]) {
      await expect(call()).rejects.toThrow(/projectName is required/);
    }
    // And whitespace is not a name.
    await expect(iac.upStack('e1', () => ({}), { s3Config, projectName: '  ' })).rejects.toThrow(
      /projectName is required/,
    );
  });
});
