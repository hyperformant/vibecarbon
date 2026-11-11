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
 *
 * The one-time legacy migration (getOrCreateStack, until 2027-02-11) runs
 * `pulumi stack change-secrets-provider` as a child process, outside the
 * Automation API. A test whose stack can refuse the passphrase also routes
 * that child here, so no unit test ever runs a real pulumi:
 *
 *   vi.mock('node:child_process', async (orig) =>
 *     (await import('../../_shared/fake-pulumi-workspace.js')).fakeChildProcessModule(
 *       await orig(),
 *     ),
 *   );
 *
 * It records `migrate:<stack>` in `fakePulumi.calls` and the child's command,
 * argv, cwd, env and stdin in `fakePulumi.migrations`. By default it answers
 * as the CLI does: a stack marked `fakePulumi.legacy(...)` (written with the
 * empty passphrase, so its reads refuse the project's) is re-encrypted and
 * reads from then on; any other stack fails with Pulumi's refusal.
 * `fakePulumi.behaviour.migrate` overrides that, run by run (a lock, the
 * store pushing back, any other stderr). Without the module mock the fake
 * workspace's command does not exist, so the child fails to start. A test
 * that sets `fakePulumi.workDirRoot` gets real workspace directories, to see
 * what a run leaves in the stack's settings file.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

export type StackVerb =
  | 'refresh'
  | 'exportStack'
  | 'importStack'
  | 'destroy'
  | 'outputs'
  | 'up'
  | 'cancel'
  | 'removeStack';

/** The fake workspace's pulumi binary: absent, so only the mocked spawn runs it. */
export const FAKE_PULUMI_COMMAND = '/nonexistent/fake-pulumi';

/**
 * The working directory of a fake workspace for `stackName`: a path that does
 * not exist, or a real directory under `fakePulumi.workDirRoot` when a test
 * sets one (to see what the migration leaves in it).
 */
export const fakeWorkDir = (stackName: string) =>
  fakePulumi.workDirRoot
    ? join(fakePulumi.workDirRoot, stackName)
    : `/fake/pulumi-workdir/${stackName}`;

/** One migration child, as spawned. */
export interface FakeMigration {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string | undefined>;
  stdin: string;
}

/** How a migration child ends. */
export interface MigrationAnswer {
  code: number;
  stderr?: string;
}

/** Pulumi's own refusal, as `change-secrets-provider` prints it for a wrong old passphrase. */
const MIGRATION_REFUSAL =
  'error: getting secrets manager: failed to decrypt: incorrect passphrase, please set ' +
  'PULUMI_CONFIG_PASSPHRASE to the correct passphrase or set PULUMI_CONFIG_PASSPHRASE_FILE ' +
  'to a file containing the passphrase\n';

export const fakePulumi = {
  calls: [] as string[],
  workspaceEnvs: [] as Record<string, string | undefined>[],
  migrations: [] as FakeMigration[],
  /** Stacks removed while trackRemovals() is on; null when it is off. */
  removed: null as Set<string> | null,
  /** Stacks still under the empty passphrase, with the refusal their reads throw. */
  legacyStacks: new Map<string, () => Error>(),
  /** Where real workspace directories go; null for paths that do not exist. */
  workDirRoot: null as string | null,
  /**
   * Per-verb override; throw from it to make the verb fail. `migrate` gets the
   * child as spawned (its cwd is the stack's workspace) and answers for it.
   */
  behaviour: {} as Partial<Record<StackVerb, (stackName: string) => unknown>> & {
    migrate?: (stackName: string, child: FakeMigration) => MigrationAnswer;
  },
  reset() {
    this.calls.length = 0;
    this.workspaceEnvs.length = 0;
    this.migrations.length = 0;
    this.behaviour = {};
    this.legacyStacks.clear();
    this.removed?.clear();
    this.workDirRoot = null;
  },
  trackRemovals() {
    this.removed = new Set();
  },
  /** Every verb that reads the state throws `make()`, the way a refused passphrase does. */
  refuseReads(make: () => Error) {
    for (const verb of ['refresh', 'exportStack', 'destroy', 'outputs', 'up'] as const) {
      this.behaviour[verb] = () => {
        throw make();
      };
    }
  },
  /**
   * `stackName` was written with the empty passphrase: every read refuses the
   * project's passphrase with `make()` until a migration re-encrypts it.
   */
  legacy(stackName: string, make: () => Error) {
    this.legacyStacks.set(stackName, make);
  },
};

const READS: ReadonlySet<StackVerb> = new Set([
  'refresh',
  'exportStack',
  'destroy',
  'outputs',
  'up',
]);

const DEFAULTS: Record<StackVerb, () => unknown> = {
  refresh: () => undefined,
  exportStack: () => ({ deployment: { resources: [] } }),
  importStack: () => undefined,
  destroy: () => ({ summary: { result: 'succeeded', resourceChanges: { delete: 1 } } }),
  outputs: () => ({}),
  up: () => ({ outputs: {}, summary: { result: 'succeeded' } }),
  cancel: () => undefined,
  removeStack: () => undefined,
};

function fakeStack(name: string, envVars: Record<string, string | undefined>) {
  const workDir = fakeWorkDir(name);
  if (fakePulumi.workDirRoot) mkdirSync(workDir, { recursive: true });
  const op =
    (verb: StackVerb) =>
    async (...args: unknown[]) => {
      fakePulumi.calls.push(
        verb === 'removeStack' ? `${verb}:${args[0]}:${JSON.stringify(args[1])}` : verb,
      );
      const legacy = fakePulumi.legacyStacks.get(name);
      if (legacy && READS.has(verb)) throw legacy();
      const answer = (fakePulumi.behaviour[verb] ?? DEFAULTS[verb])(name);
      if (verb === 'removeStack') fakePulumi.removed?.add(String(args[0]));
      return answer;
    };
  return {
    name,
    refresh: op('refresh'),
    exportStack: op('exportStack'),
    importStack: op('importStack'),
    destroy: op('destroy'),
    outputs: op('outputs'),
    up: op('up'),
    cancel: op('cancel'),
    workspace: {
      removeStack: op('removeStack'),
      pulumiCommand: { command: FAKE_PULUMI_COMMAND },
      workDir,
      envVars,
    },
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
        return fakeStack(args.stackName, ws?.envVars ?? {});
      },
      createStack: async () => {
        throw new Error('createStack must not be called: these callers never create a stack');
      },
      create: async () => ({ listStacks: async () => [], whoAmI: async () => 'me' }),
    },
  };
}

/** The default answer: re-encrypts a legacy stack, refuses any other. */
function migrate(stackName: string, child: FakeMigration): MigrationAnswer {
  if (fakePulumi.behaviour.migrate) return fakePulumi.behaviour.migrate(stackName, child);
  if (fakePulumi.legacyStacks.delete(stackName)) return { code: 0 };
  return { code: 255, stderr: MIGRATION_REFUSAL };
}

/**
 * A spawned migration child: it reads stdin to the end, then exits with the
 * answer for its stack.
 */
function fakeMigrationChild(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill: () => true,
  });
  const stackName = args[args.indexOf('--stack') + 1] ?? '';
  const chunks: Buffer[] = [];
  child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stdin.on('finish', () => {
    fakePulumi.calls.push(`migrate:${stackName}`);
    const spawned = {
      command,
      args: [...args],
      cwd: options.cwd,
      env: { ...(options.env ?? {}) },
      stdin: Buffer.concat(chunks).toString('utf8'),
    };
    fakePulumi.migrations.push(spawned);
    const { code, stderr = '' } = migrate(stackName, spawned);
    setImmediate(() => {
      child.stderr.end(stderr);
      child.stdout.end();
      child.emit('exit', code, null);
      child.emit('close', code, null);
    });
  });
  return child;
}

/**
 * The module object for `vi.mock('node:child_process', ...)`: `spawn` of the
 * fake workspace's pulumi is a migration child; every other spawn is real.
 */
export function fakeChildProcessModule<T extends { spawn: (...args: never[]) => unknown }>(
  real: T,
): T {
  return {
    ...real,
    spawn: (command: string, args: string[], options?: Record<string, unknown>) =>
      command === FAKE_PULUMI_COMMAND
        ? fakeMigrationChild(command, args, options)
        : (real.spawn as (...a: unknown[]) => unknown)(command, args, options),
  };
}
