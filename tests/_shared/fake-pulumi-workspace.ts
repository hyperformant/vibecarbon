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
 * clears all three. `fakePulumi.trackRemovals()` makes a removed stack stay
 * gone (selecting it answers `no stack named`, as the real CLI does), for a
 * test that runs a command twice; reset() forgets the removals but keeps the
 * tracking on, since a second run is what tracking is for.
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
  /** Stacks removed while trackRemovals() is on; null when it is off. */
  removed: null as Set<string> | null,
  /** Per-verb override; throw from it to make the verb fail. */
  behaviour: {} as Partial<Record<StackVerb, (stackName: string) => unknown>>,
  reset() {
    this.calls.length = 0;
    this.workspaceEnvs.length = 0;
    this.behaviour = {};
    this.removed?.clear();
  },
  trackRemovals() {
    this.removed = new Set();
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
      const answer = (fakePulumi.behaviour[verb] ?? DEFAULTS[verb])(name);
      if (verb === 'removeStack') fakePulumi.removed?.add(String(args[0]));
      return answer;
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
        if (fakePulumi.removed?.has(args.stackName)) {
          throw new Error(`error: no stack named '${args.stackName}' found`);
        }
        return fakeStack(args.stackName);
      },
      createStack: async () => {
        throw new Error('createStack must not be called: these callers never create a stack');
      },
      create: async () => ({ listStacks: async () => [], whoAmI: async () => 'me' }),
    },
  };
}
