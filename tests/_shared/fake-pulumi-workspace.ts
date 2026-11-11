/**
 * A recording stand-in for the Pulumi Automation API, for unit tests that run
 * the real iac layer (getOrCreateStack, destroyStack, removeStackState, ...)
 * with no CLI:
 *
 *   vi.mock('@pulumi/pulumi/automation/index.js', async () =>
 *     (await import('../../_shared/fake-pulumi-workspace.js')).fakeAutomationModule(),
 *   );
 *
 * Every stack exists (selectStack always succeeds; createStack throws, since
 * none of these callers may conjure one). `fakePulumi.calls` records, in
 * order, `select:<stack>`, each stack verb by name, and
 * `removeStack:<stack>:<options as JSON>`. `fakePulumi.workspaceEnvs` keeps
 * the environment each workspace was opened with. A test makes a verb fail or
 * answer differently through `fakePulumi.behaviour`; `fakePulumi.reset()`
 * clears all three.
 */

export type StackVerb =
  | 'refresh'
  | 'exportStack'
  | 'destroy'
  | 'outputs'
  | 'cancel'
  | 'removeStack';

export const fakePulumi = {
  calls: [] as string[],
  workspaceEnvs: [] as Record<string, string | undefined>[],
  /** Per-verb override; throw from it to make the verb fail. */
  behaviour: {} as Partial<Record<StackVerb, (stackName: string) => unknown>>,
  reset() {
    this.calls.length = 0;
    this.workspaceEnvs.length = 0;
    this.behaviour = {};
  },
  /** Every verb that reads the state throws `make()`, the way a refused passphrase does. */
  refuseReads(make: () => Error) {
    for (const verb of ['refresh', 'exportStack', 'destroy', 'outputs'] as const) {
      this.behaviour[verb] = () => {
        throw make();
      };
    }
  },
};

const DEFAULTS: Record<StackVerb, () => unknown> = {
  refresh: () => undefined,
  exportStack: () => ({ deployment: { resources: [] } }),
  destroy: () => ({ summary: { result: 'succeeded', resourceChanges: { delete: 1 } } }),
  outputs: () => ({}),
  cancel: () => undefined,
  removeStack: () => undefined,
};

function fakeStack(name: string) {
  const op =
    (verb: StackVerb) =>
    async (...args: unknown[]) => {
      fakePulumi.calls.push(
        verb === 'removeStack' ? `${verb}:${args[0]}:${JSON.stringify(args[1])}` : verb,
      );
      return (fakePulumi.behaviour[verb] ?? DEFAULTS[verb])(name);
    };
  return {
    name,
    refresh: op('refresh'),
    exportStack: op('exportStack'),
    destroy: op('destroy'),
    outputs: op('outputs'),
    cancel: op('cancel'),
    workspace: { removeStack: op('removeStack') },
  };
}

/** The module object for `vi.mock('@pulumi/pulumi/automation/index.js', ...)`. */
export function fakeAutomationModule() {
  return {
    LocalWorkspace: {
      selectStack: async (
        args: { stackName: string },
        ws: { envVars?: Record<string, string | undefined> },
      ) => {
        fakePulumi.calls.push(`select:${args.stackName}`);
        fakePulumi.workspaceEnvs.push(ws?.envVars ?? {});
        return fakeStack(args.stackName);
      },
      createStack: async () => {
        throw new Error('createStack must not be called: these callers never create a stack');
      },
      create: async () => ({ listStacks: async () => [], whoAmI: async () => 'me' }),
    },
  };
}
