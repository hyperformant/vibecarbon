/**
 * M3 Task 9f — `destroyStack`'s loud partial-detection contract.
 *
 * Evidence: two live DO k8s destroys left firewall/VPC/SSH-key/reserved-IP
 * orphans while `destroyStack` RESOLVED — no thrown error anywhere, no
 * per-resource Pulumi output. `pulumi destroy`'s CLI wrapper
 * (@pulumi/pulumi/automation/cmd.js) already throws on a nonzero exit code,
 * so a hard mid-destroy failure isn't the reachable mechanism; the
 * reproducible one is `createOrSelectStack` silently creating a FRESH, EMPTY
 * stack when it can't find the real one (e.g. a destroy-time backend
 * mismatch), after which `destroy` "succeeds" against emptiness.
 *
 * These tests mock `@pulumi/pulumi/automation/index.js`'s `LocalWorkspace`
 * directly so the automation API's actual shapes (`exportStack`,
 * `DestroyResult.summary`) drive the assertions, rather than mocking
 * `destroyStack` itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeStack = {
  destroy: ReturnType<typeof vi.fn>;
  exportStack: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  workspace: { removeStack: ReturnType<typeof vi.fn> };
};

function makeStack(opts: {
  exportStackResources?: Array<{ type: string }>;
  exportStackThrows?: boolean;
  destroyResult?: { summary?: { result?: string; resourceChanges?: Record<string, number> } };
}): FakeStack {
  const {
    exportStackResources = [],
    exportStackThrows = false,
    destroyResult = { summary: { result: 'succeeded', resourceChanges: {} } },
  } = opts;
  return {
    destroy: vi.fn().mockResolvedValue(destroyResult),
    exportStack: exportStackThrows
      ? vi.fn().mockRejectedValue(new Error('export failed'))
      : vi.fn().mockResolvedValue({ deployment: { resources: exportStackResources } }),
    refresh: vi.fn().mockResolvedValue(undefined),
    workspace: { removeStack: vi.fn().mockResolvedValue(undefined) },
  };
}

const createOrSelectStackMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    // getOrCreateStack drives select/create itself now (2026-08-06 RCA: the
    // SDK's createOrSelect turned a stale 404 into stack CREATION over real
    // state). These suites exercise the stack-exists path, so select is what
    // resolves; createStack is wired to throw so an accidental create is loud.
    selectStack: (...args: unknown[]) => createOrSelectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called: it would clobber real state');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

describe('destroyStack — loud partial detection (M3 Task 9f)', () => {
  beforeEach(() => {
    createOrSelectStackMock.mockReset();
  });

  it('resolves and removes the stack when the stack had resources and destroy records matching deletes', async () => {
    const stack = makeStack({
      exportStackResources: [
        { type: 'digitalocean:index/firewall:Firewall' },
        { type: 'pulumi:pulumi:Stack' },
      ],
      destroyResult: { summary: { result: 'succeeded', resourceChanges: { delete: 1 } } },
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    const out = await destroyStack('e1', () => ({}), { projectName: 'testproj' });

    expect(out.destroyed).toBe(true);
    expect(stack.workspace.removeStack).toHaveBeenCalledWith('e1');
  });

  it('resolves normally for a genuinely-empty stack (legit idempotent re-run / never-deployed stack)', async () => {
    const stack = makeStack({
      exportStackResources: [],
      destroyResult: { summary: { result: 'succeeded', resourceChanges: {} } },
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    const out = await destroyStack('e1', () => ({}), { projectName: 'testproj' });

    expect(out.destroyed).toBe(true);
    expect(stack.workspace.removeStack).toHaveBeenCalledWith('e1');
  });

  // NOT the reproduced DO incident (fix round 1 correction): this is a
  // narrower, Pulumi-INTERNAL inconsistency — the STACK'S OWN state (as
  // exportStack sees it) disagrees with what its OWN destroy result
  // recorded. The actual incident (createOrSelectStack silently creating a
  // fresh, empty WRONG stack) is legitimately empty on both sides of this
  // same-stack comparison — see the "does NOT catch the state-backend-
  // mismatch incident shape" test below, and the caller-side coverage in
  // tests/unit/destroy/record-pulumi-destroy-outcome.test.ts, which is
  // where that mechanism is actually caught.
  it('throws when a stack that held resources records zero deletes (Pulumi-internal inconsistency)', async () => {
    const stack = makeStack({
      exportStackResources: [{ type: 'digitalocean:index/firewall:Firewall' }],
      destroyResult: { summary: { result: 'succeeded', resourceChanges: {} } },
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    await expect(destroyStack('e1', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /zero.*deletions/i,
    );
    // The stack record must survive so a retry / backstop sweep can still
    // see accurate state instead of a wiped one.
    expect(stack.workspace.removeStack).not.toHaveBeenCalled();
  });

  // Fix round 1: documents the actual incident's blind spot for THIS
  // function. createOrSelectStack creating a fresh, empty stack because it
  // can't find the real one (a destroy-time backend mismatch) is
  // indistinguishable, from destroyStack's own vantage point, from a
  // genuinely-already-destroyed stack — both show zero resources before AND
  // zero deletes after. destroyStack resolves normally here; the loud
  // signal for THIS exact shape comes from the caller
  // (recordPulumiDestroyOutcome in destroy.js), which has envConfig context
  // this function doesn't.
  it('does NOT catch the state-backend-mismatch incident shape — a fresh empty stack resolves normally, by design', async () => {
    const stack = makeStack({
      exportStackResources: [],
      destroyResult: { summary: { result: 'succeeded', resourceChanges: {} } },
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    const out = await destroyStack('e1', () => ({}), { projectName: 'testproj' });

    expect(out).toEqual({ destroyed: true, resourceCount: 0 });
  });

  it('throws when the destroy summary itself reports a non-succeeded result', async () => {
    const stack = makeStack({
      exportStackResources: [{ type: 'digitalocean:index/firewall:Firewall' }],
      destroyResult: { summary: { result: 'failed', resourceChanges: {} } },
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    await expect(destroyStack('e1', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /did not report a clean success/i,
    );
    expect(stack.workspace.removeStack).not.toHaveBeenCalled();
  });

  it('skips the resource-count cross-check when exportStack itself fails (unknown, not blocked)', async () => {
    const stack = makeStack({
      exportStackThrows: true,
      destroyResult: { summary: { result: 'succeeded', resourceChanges: {} } },
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    const out = await destroyStack('e1', () => ({}), { projectName: 'testproj' });

    expect(out.destroyed).toBe(true);
    expect(stack.workspace.removeStack).toHaveBeenCalledWith('e1');
  });

  // Still an idempotent no-op — but only after the staleness window has been
  // polled through, so "absent" now means durably absent rather than "one
  // frontend said so". Hence the fake timers: destroy requires the stack to
  // exist and will not accept the first 404 as an answer (2026-08-06 RCA).
  it('treats an absent stack as an idempotent no-op — decided on the FIRST read', async () => {
    // Band-aid removal 2026-08-16: the ~22s staleness poll before this
    // decision is deleted with its recreated-bucket trigger, so an absent
    // stack answers immediately. The idempotent-no-op semantics themselves
    // are unchanged.
    createOrSelectStackMock.mockRejectedValue(new Error('no stack named "e1" found'));

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    expect(await destroyStack('e1', () => ({}), { projectName: 'testproj' })).toEqual({
      destroyed: false,
    });
    expect(createOrSelectStackMock).toHaveBeenCalledTimes(1);
  });
});
