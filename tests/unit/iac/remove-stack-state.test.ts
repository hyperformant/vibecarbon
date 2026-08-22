/**
 * `removeStackState` — remove a stack's state record WITHOUT running
 * `pulumi destroy`.
 *
 * Evidence (e2e run 32309395314, vultr compose restore, 2026-08-19): the
 * compose tiers reap their cloud resources via direct provider APIs, so
 * their destroy never ran `pulumi destroy`/`removeStack` — and since the
 * state bucket is retained (717d49e7), the stack file survived a verified
 * teardown still describing the deleted resources. The next deploy of the
 * same environment (the e2e restore re-deploy) selected that stale stack,
 * and on providers whose refresh cannot prune a deleted resource
 * (terraform-provider-vultr v2.27.1 returns an ERROR, not not-found, when
 * reading a deleted firewall rule) `pulumi up` tried to delete the stale
 * rules against the live API and died on 404.
 *
 * removeStackState is the compose-side twin of the removal destroyStack
 * already performs for the k8s tiers: state must be reconciled by the thing
 * that deleted the resources, not left for the next deploy's refresh to
 * repair.
 *
 * Mocks `@pulumi/pulumi/automation/index.js`'s LocalWorkspace directly (the
 * destroy-stack-partial-detection pattern) so the real getOrCreateStack /
 * removeStackState code paths run against the automation API's shapes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectStackMock = vi.fn();
const createStackMock = vi.fn(() => {
  throw new Error('createStack must not be called: removal must never conjure a stack');
});

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: (...args: unknown[]) => createStackMock(...args),
    create: async () => ({ listStacks: async () => [] }),
  },
}));

function makeStack() {
  return {
    workspace: { removeStack: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('removeStackState — state-only stack removal after out-of-band teardown', () => {
  beforeEach(() => {
    selectStackMock.mockReset();
    createStackMock.mockClear();
  });

  it('removes an existing stack with force (its state still lists the reaped resources) and reports removed', async () => {
    const stack = makeStack();
    selectStackMock.mockResolvedValue(stack);

    const { removeStackState } = await import('../../../src/lib/iac/index.js');
    const out = await removeStackState('civ1', { projectName: 'testproj' });

    expect(out.removed).toBe(true);
    // force: the state record deliberately still lists resources — the whole
    // point is that the caller already deleted them out-of-band and verified
    // it (clean leak ledger). A non-forced remove refuses non-empty stacks.
    expect(stack.workspace.removeStack).toHaveBeenCalledWith('civ1', { force: true });
  });

  it('is a no-op (removed: false) when the stack is durably absent', async () => {
    const err = Object.assign(new Error('no stack named "civ1" found'), {});
    selectStackMock.mockRejectedValue(err);

    const { removeStackState } = await import('../../../src/lib/iac/index.js');
    const out = await removeStackState('civ1', { projectName: 'testproj' });

    expect(out.removed).toBe(false);
  });

  it('never creates a stack while removing one', async () => {
    selectStackMock.mockRejectedValue(new Error('no stack named "civ1" found'));

    const { removeStackState } = await import('../../../src/lib/iac/index.js');
    await removeStackState('civ1', { projectName: 'testproj' });

    expect(createStackMock).not.toHaveBeenCalled();
  });

  it('propagates errors that are NOT stack-absence (backend/credential failures must stay loud)', async () => {
    selectStackMock.mockRejectedValue(new Error('403 Forbidden reading s3://state-bucket'));

    const { removeStackState } = await import('../../../src/lib/iac/index.js');
    await expect(removeStackState('civ1', { projectName: 'testproj' })).rejects.toThrow(
      /403 Forbidden/,
    );
  });
});
