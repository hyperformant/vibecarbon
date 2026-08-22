/**
 * `upStack`'s stale-state-backend-frontend recovery.
 *
 * Failure class (Hetzner Object Storage read-after-write staleness across
 * load-balanced frontends on a freshly-created state bucket): a read can 404
 * the just-written stack file — `error: no stack named '<env>' found` — even
 * though a moments-earlier `stack select` against a different frontend
 * succeeded.
 *
 * There are TWO distinct windows and they need OPPOSITE recoveries, which is
 * why these tests care so much about *which* pulumi command failed:
 *
 *   - POST-mutation: `Stack.up()` runs `pulumi stack output` after the update
 *     itself succeeded (automation/stack.js:308). A 404 there means resources
 *     are already provisioned; re-running `up` could read the same stale-empty
 *     state and double-provision. Recovery = read-only outputs poll.
 *     (Observed 2026-07-25.)
 *
 *   - PRE-mutation: the `pulumi up` CLI itself exits 6 while RESOLVING the
 *     stack, before the engine loads the program or spawns a provider plugin.
 *     Nothing was mutated, so one guarded re-run is safe — and necessary,
 *     because the read-only poll can only ever return empty here.
 *     (Observed 2026-07-31, compose scenario env e1: fresh state bucket,
 *     stack-select OK, refresh skipped, `stack.up()` threw at 13.3s.)
 *
 * A third window belongs to the same degraded-object-storage class but is NOT
 * a stale-read at all: after a FULLY APPLIED update, the CLI's final write of
 * its `.pulumi/history/` entry can fail (403/AccessDenied observed 2026-07-31
 * on k8s scale env e3, same ceph cluster). That file is display metadata for
 * `pulumi history`, not a checkpoint — failing a completed scale over it is
 * wrong, and re-running `up` to rewrite a cosmetic file is disproportionate.
 * Recovery = read-only verify + loud warning + report success.
 *
 * `@pulumi/pulumi/automation/index.js` is mocked at `LocalWorkspace` so the
 * automation API's real error shape drives the assertions — see
 * `commandError()`, which reproduces the exact `CommandResult.toString()`
 * envelope (`code:/stdout:/stderr:/err?:`) wrapped around execa's
 * `Command failed with exit code N: <argv>` message. The argv embedded there
 * is the only signal that distinguishes the two stale-read windows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createOrSelectStackMock = vi.fn();
const progressLogMock = vi.fn();

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

vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (...args: unknown[]) => progressLogMock(...args),
}));

/** Verbatim argv shapes the automation API invokes (automation/stack.js). */
const UP_ARGV =
  'pulumi up --yes --skip-preview --color never --client=127.0.0.1:44509 ' +
  '--exec-kind auto.inline --stack e1 --non-interactive';
const STACK_OUTPUT_ARGV = 'pulumi stack output --json --stack e1 --non-interactive';
/** compose-ha env e2, restore step's re-deploy (exit code 1, not 6). */
const UP_HA_ARGV =
  'pulumi up --yes --skip-preview --color never --client=127.0.0.1:39297 ' +
  '--exec-kind auto.inline --stack e2-primary --non-interactive';

/**
 * Verbatim 2026-07-31 compose-ha e2-primary stderr tail. The key and
 * `(code=NotFound)` sit on ONE line — the string concatenation below adds no
 * newline — which is the property the pattern relies on to stay precise.
 */
const LOCK_BLOB_404_TAIL =
  'error: blob (key ".pulumi/locks/organization/vibecarbon/e2-primary/' +
  '9bba65d9-fef2-4ce2-abb5-d5af945646b9.json") (code=NotFound): NoSuchKey: \n' +
  '\tstatus code: 404, request id: tx00000cf1a81e7ee26a9fc-006a6d0971-99ac30-nbg1-prod1-ceph5, ' +
  'host id: ';

/**
 * Rebuild the automation API's error envelope for a failed pulumi command.
 *
 * execa rejects on a nonzero exit, so `automation/cmd.js`'s `exec()` always
 * lands in its catch and builds `new CommandResult('', error.message, -2, err)`
 * — meaning the *stderr* slot holds execa's message, which leads with the full
 * argv. That is why the argv is reliably present for every failing command.
 */
function commandError(
  argv: string,
  exitCode = 6,
  tail = "error: no stack named 'e1' found",
  stdout = '',
) {
  // execa 5 (lib/error.js): message = [shortMessage, stderr, stdout]
  //   .filter(Boolean).join('\n') — so a failing `pulumi up` carries its ENTIRE
  // stdout update stream inside the error message, after the stderr text.
  const execaMsg = [`Command failed with exit code ${exitCode}: ${argv}`, tail, stdout]
    .filter(Boolean)
    .join('\n');
  const err = new Error(`code: -2\n stdout: \n stderr: ${execaMsg}\n err?: Error: ${execaMsg}\n`);
  // createCommandError() classifies "no stack named ... found" as this subtype.
  err.name = /no stack named.*found/.test(tail) ? 'StackNotFoundError' : 'CommandError';
  return err;
}

/** compose/k8s scale path — `vibecarbon scale` drives the same upStack. */
const UP_E3_ARGV =
  'pulumi up --yes --skip-preview --color never --client=127.0.0.1:41003 ' +
  '--exec-kind auto.inline --stack e3 --non-interactive';

/**
 * Verbatim 2026-07-31 k8s scale (e3) stderr. Deliberately code-agnostic in the
 * pattern: the signature is "saving update info" + a `.pulumi/history/` key,
 * NOT the AccessDenied/403 spelling.
 */
const HISTORY_WRITE_403_STDERR =
  'error: saving update info: blob (key ".pulumi/history/vibecarbon/e3/' +
  'e3-1785538035700410364.history.json") (code=Unknown): AccessDenied: \n' +
  '\tstatus code: 403, request id: tx000004cce7ebb5e8bea14-006a6d25f3-9a33ba-nbg1-prod1-ceph5';

/** Same write, a different storage code — must still qualify. */
const HISTORY_WRITE_NOSUCHBUCKET_STDERR =
  'error: saving update info: blob (key ".pulumi/history/vibecarbon/e3/' +
  'e3-1785538035700410364.history.json") (code=NotFound): NoSuchBucket: ';

/** The same 403 on a CHECKPOINT write — real state loss, must stay fatal. */
const CHECKPOINT_WRITE_403_STDERR =
  'error: saving update info: blob (key ".pulumi/stacks/vibecarbon/e3.json") ' +
  '(code=Unknown): AccessDenied: \n\tstatus code: 403, request id: tx000004cce7';

/**
 * What `pulumi up` streamed on stdout before the history write failed — the
 * update fully applied. execa appends this to the error message, so the
 * "did anything else fail?" guard is evaluated over it too.
 */
const APPLIED_UPDATE_STREAM = [
  'Updating (e3):',
  '',
  '    hcloud:index:Server master  updated [diff: ~serverType]',
  '    hcloud:index:Server worker1 updated [diff: ~serverType]',
  '    hcloud:index:Server worker2 updated [diff: ~serverType]',
  '',
  'Outputs:',
  '    masterIp: "1.2.3.4"',
  '',
  'Resources:',
  '    ~ 3 updated',
  '    8 unchanged',
  '',
  'Duration: 44s',
].join('\n');

/**
 * VARIANT 5, verbatim (2026-08-06 e4-primary). Same root cause, same window —
 * but pulumi's DIY backend nil-derefs instead of returning the error. Note
 * there is NO `error:` line anywhere in this message; the argv is the only
 * thing that identifies the command, and the frames are the only thing that
 * identifies the window.
 */
const DIY_GETTARGET_PANIC_STDERR = [
  '================================================================================',
  'The Pulumi CLI encountered a fatal error. This is a bug!',
  'We would appreciate a report: https://github.com/pulumi/pulumi/issues/',
  'Please provide all of the text below in your report.',
  '================================================================================',
  'Pulumi Version:   v3.231.0',
  'Go Version:       go1.26.2',
  'Architecture:     amd64',
  'Operating System: linux',
  'Panic:            runtime error: invalid memory address or nil pointer dereference',
  '',
  'goroutine 1 [running]:',
  'runtime/debug.Stack()',
  '\truntime/debug/stack.go:26 +0x5e',
  'main.panicHandler(0x1904bcbff07)',
  '\tgithub.com/pulumi/pulumi/pkg/v3/cmd/pulumi/main.go:37 +0x39',
  'panic({0x2bc4fc0?, 0x52b1970?})',
  '\truntime/panic.go:860 +0x13a',
  'github.com/pulumi/pulumi/pkg/v3/backend/diy.(*diyBackend).getTarget(0x1904bb7e5a0, ' +
    '{0x348fde0, 0x1904b81baa0}, {0x3467260, 0x53619a0}, 0x1904a258f00, 0x1904ba1d9b0, ' +
    '{0x70e9e95075a8, 0x53619a0})',
  '\tgithub.com/pulumi/pulumi/pkg/v3/backend/diy/state.go:88 +0xbb',
  'github.com/pulumi/pulumi/pkg/v3/backend/diy.(*diyBackend).newUpdate(_, {_, _}, {_, _}, _, ' +
    '{0x1904a3f0820, {0x1904b7045a0, 0x16}, {0x0, ...}, ...})',
  '\tgithub.com/pulumi/pulumi/pkg/v3/backend/diy/state.go:62 +0xbb',
  'github.com/pulumi/pulumi/pkg/v3/backend/diy.(*diyBackend).apply(_, {_, _}, {_, _}, {_, _}, ' +
    '{0x1904a3f0820, {0x1904b7045a0, 0x16}, ...}, ...)',
  '\tgithub.com/pulumi/pulumi/pkg/v3/backend/diy/backend.go:1213 +0x415',
  'github.com/pulumi/pulumi/pkg/v3/backend.UpdateStack({_, _}, {_, _}, {0x1904a3f0820, ...}, ...)',
  '\tgithub.com/pulumi/pulumi/pkg/v3/backend/stack.go:94 +0xcf',
  'github.com/pulumi/pulumi/pkg/v3/cmd/pulumi/operations.NewUpCmd.func1({_, _}, {_}, {_, _}, ...)',
  '\tgithub.com/pulumi/pulumi/pkg/v3/cmd/pulumi/operations/up.go:265 +0x18f4',
  'main.main()',
  '\tgithub.com/pulumi/pulumi/pkg/v3/cmd/pulumi/main.go:64 +0x65',
].join('\n');

/** A panic from somewhere else entirely — must never qualify. */
const UNRELATED_PANIC_STDERR = [
  'The Pulumi CLI encountered a fatal error. This is a bug!',
  'Panic:            runtime error: index out of range [3] with length 2',
  '',
  'goroutine 1 [running]:',
  'github.com/pulumi/pulumi/pkg/v3/engine.(*stepExecutor).executeStep(0x1904bb7e5a0)',
  '\tgithub.com/pulumi/pulumi/pkg/v3/engine/step_executor.go:412 +0xbb',
  'github.com/pulumi/pulumi/pkg/v3/engine.(*deployment).Execute(_, {_, _})',
  '\tgithub.com/pulumi/pulumi/pkg/v3/engine/deployment.go:201 +0xbb',
].join('\n');

/**
 * A panic that reaches getTarget from somewhere OTHER than newUpdate. The
 * pre-mutation argument rests on the newUpdate caller specifically, so this
 * must not qualify either.
 */
const GETTARGET_WITHOUT_NEWUPDATE_PANIC_STDERR = [
  'The Pulumi CLI encountered a fatal error. This is a bug!',
  'Panic:            runtime error: invalid memory address or nil pointer dereference',
  '',
  'goroutine 1 [running]:',
  'github.com/pulumi/pulumi/pkg/v3/backend/diy.(*diyBackend).getTarget(0x1904bb7e5a0)',
  '\tgithub.com/pulumi/pulumi/pkg/v3/backend/diy/state.go:88 +0xbb',
  'github.com/pulumi/pulumi/pkg/v3/backend/diy.(*diyBackend).Watch(_, {_, _})',
  '\tgithub.com/pulumi/pulumi/pkg/v3/backend/diy/backend.go:1400 +0xbb',
].join('\n');

const STACK_ONLY = { deployment: { resources: [{ type: 'pulumi:pulumi:Stack' }] } };
const WITH_RESOURCES = {
  deployment: {
    resources: [{ type: 'pulumi:pulumi:Stack' }, { type: 'hcloud:index/server:Server' }],
  },
};

type FakeStack = {
  cancel: ReturnType<typeof vi.fn>;
  exportStack: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  up: ReturnType<typeof vi.fn>;
  outputs: ReturnType<typeof vi.fn>;
};

function makeStack(over: Partial<FakeStack> = {}): FakeStack {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    exportStack: vi.fn().mockResolvedValue(STACK_ONLY),
    refresh: vi.fn().mockResolvedValue(undefined),
    up: vi.fn().mockResolvedValue({ outputs: {}, summary: { result: 'succeeded' } }),
    outputs: vi.fn().mockResolvedValue({}),
    ...over,
  };
}

const logged = () => progressLogMock.mock.calls.map((c) => String(c[0])).join('\n');

describe('failingPulumiCommandVerb — which pulumi command 404d', () => {
  it('reads "up" out of the verbatim 2026-07-31 e1 failure message', async () => {
    const { failingPulumiCommandVerb } = await import('../../../src/lib/iac/index.js');
    expect(failingPulumiCommandVerb(commandError(UP_ARGV).message)).toBe('up');
  });

  it('reads "stack" out of the post-up `pulumi stack output` read', async () => {
    const { failingPulumiCommandVerb } = await import('../../../src/lib/iac/index.js');
    // Two-word form since 2026-08-15: `stack` alone was ambiguous — `stack
    // select` fails pre-mutation with identical text, and only `stack output`
    // proves the post-update window.
    expect(failingPulumiCommandVerb(commandError(STACK_OUTPUT_ARGV, 255).message)).toBe(
      'stack output',
    );
  });

  it('tolerates an absolute pulumi binary path (PULUMI_HOME installs)', async () => {
    const { failingPulumiCommandVerb } = await import('../../../src/lib/iac/index.js');
    const msg = commandError('/home/u/.pulumi/bin/pulumi up --yes --stack e1').message;
    expect(failingPulumiCommandVerb(msg)).toBe('up');
  });

  // Fail SAFE: anything we cannot positively identify as the `up` command must
  // read as "unknown", which routes to the read-only recovery.
  it('returns null when the message carries no argv at all', async () => {
    const { failingPulumiCommandVerb } = await import('../../../src/lib/iac/index.js');
    expect(failingPulumiCommandVerb("error: no stack named 'e1' found")).toBeNull();
    expect(failingPulumiCommandVerb('')).toBeNull();
    expect(failingPulumiCommandVerb(undefined)).toBeNull();
  });

  it('returns null when the failing binary is not pulumi', async () => {
    const { failingPulumiCommandVerb } = await import('../../../src/lib/iac/index.js');
    expect(failingPulumiCommandVerb('Command failed with exit code 1: kubectl up foo')).toBeNull();
  });

  // The lock-blob variant exits 1, not 6 — the predicate reads the argv, never
  // the exit code, so the same extraction holds.
  it('reads "up" out of the 2026-07-31 e2-primary lock-blob failure (exit 1)', async () => {
    const { failingPulumiCommandVerb } = await import('../../../src/lib/iac/index.js');
    const msg = commandError(UP_HA_ARGV, 1, LOCK_BLOB_404_TAIL).message;
    expect(failingPulumiCommandVerb(msg)).toBe('up');
  });
});

describe('HISTORY_WRITE_FAILURE_PATTERN', () => {
  const load = () => import('../../../src/lib/iac/index.js');

  it('matches the verbatim 2026-07-31 e3 history-write 403', async () => {
    const { HISTORY_WRITE_FAILURE_PATTERN: p } = await load();
    expect(p.test(HISTORY_WRITE_403_STDERR)).toBe(true);
  });

  // The signature is the WRITE TARGET, not the storage code — a degraded
  // cluster can 403, 503 or 404 the same cosmetic write.
  it('is code-agnostic (NoSuchBucket spelling of the same write qualifies)', async () => {
    const { HISTORY_WRITE_FAILURE_PATTERN: p } = await load();
    expect(p.test(HISTORY_WRITE_NOSUCHBUCKET_STDERR)).toBe(true);
  });

  // The whole safety argument is that history is bookkeeping. A failed
  // CHECKPOINT write is real state loss and must never be swallowed.
  it('does NOT match the same failure on a checkpoint/state key', async () => {
    const { HISTORY_WRITE_FAILURE_PATTERN: p } = await load();
    expect(p.test(CHECKPOINT_WRITE_403_STDERR)).toBe(false);
  });

  it('does NOT match a bare AccessDenied with no history key', async () => {
    const { HISTORY_WRITE_FAILURE_PATTERN: p } = await load();
    expect(p.test('error: AccessDenied: status code: 403')).toBe(false);
  });

  it('does NOT match a history key without the "saving update info" prefix', async () => {
    const { HISTORY_WRITE_FAILURE_PATTERN: p } = await load();
    expect(p.test('error: blob (key ".pulumi/history/vibecarbon/e3/x.json"): AccessDenied')).toBe(
      false,
    );
  });

  // Pulumi indents per-resource diagnostics under their resource header; only
  // top-level CLI errors start at column 0.
  it('does NOT match an indented per-resource diagnostic', async () => {
    const { HISTORY_WRITE_FAILURE_PATTERN: p } = await load();
    expect(p.test('    error: saving update info: .pulumi/history/x.json failed')).toBe(false);
  });
});

describe('upStack — history-write failure after a fully applied update', () => {
  beforeEach(() => {
    createOrSelectStackMock.mockReset();
    progressLogMock.mockReset();
  });

  const historyErr = (stdout = APPLIED_UPDATE_STREAM) =>
    commandError(UP_E3_ARGV, 1, HISTORY_WRITE_403_STDERR, stdout);

  it('reports success with the verified outputs and warns loudly', async () => {
    const stack = makeStack({
      up: vi.fn().mockRejectedValue(historyErr()),
      outputs: vi.fn().mockResolvedValue({ masterIp: { value: '1.2.3.4' } }),
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    const out = await upStack('e3', () => ({}), { projectName: 'testproj' });

    expect(out.outputs).toEqual({ masterIp: '1.2.3.4' });
    // Bookkeeping-only: the update is NOT re-run.
    expect(stack.up).toHaveBeenCalledTimes(1);
    expect(stack.outputs).toHaveBeenCalledTimes(1);
    expect(logged()).toMatch(/update applied; its history entry could not be saved/i);
    expect(logged()).toMatch(/state verified intact, continuing/i);
    // The swallowed error is never hidden from the operator.
    expect(logged()).toMatch(/saving update info/i);
  });

  it('propagates when the state verify comes back empty', async () => {
    const stack = makeStack({
      up: vi.fn().mockRejectedValue(historyErr()),
      outputs: vi.fn().mockResolvedValue({}),
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e3', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /saving update info/,
    );
    expect(logged()).not.toMatch(/continuing/i);
  });

  it('propagates when the state verify itself throws', async () => {
    const stack = makeStack({
      up: vi.fn().mockRejectedValue(historyErr()),
      outputs: vi.fn().mockRejectedValue(new Error('outputs read failed: connection reset')),
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e3', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /saving update info/,
    );
  });

  // The load-bearing guard: `Complete()` records FAILED updates in history too,
  // so a history-write 403 can co-occur with a genuinely failed update. Only
  // swallow when the history write is the ONLY thing that reported an error.
  it('propagates when the update itself also reported an error', async () => {
    const stack = makeStack({
      up: vi
        .fn()
        .mockRejectedValue(
          commandError(
            UP_E3_ARGV,
            1,
            `${HISTORY_WRITE_403_STDERR}\nerror: update failed`,
            APPLIED_UPDATE_STREAM,
          ),
        ),
      outputs: vi.fn().mockResolvedValue({ masterIp: { value: '1.2.3.4' } }),
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e3', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /update failed/,
    );
    expect(stack.outputs).not.toHaveBeenCalled();
  });

  // Same guard, from the stdout side — execa appends the update stream, so a
  // resource-level failure printed there is visible to the check.
  it('propagates when the streamed update reported a top-level error', async () => {
    const failedStream = `${APPLIED_UPDATE_STREAM}\nerror: 1 error occurred:`;
    const stack = makeStack({
      up: vi.fn().mockRejectedValue(historyErr(failedStream)),
      outputs: vi.fn().mockResolvedValue({ masterIp: { value: '1.2.3.4' } }),
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e3', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /saving update info/,
    );
    expect(stack.outputs).not.toHaveBeenCalled();
  });

  it('leaves a failed CHECKPOINT write fatal', async () => {
    const stack = makeStack({
      up: vi
        .fn()
        .mockRejectedValue(
          commandError(UP_E3_ARGV, 1, CHECKPOINT_WRITE_403_STDERR, APPLIED_UPDATE_STREAM),
        ),
      outputs: vi.fn().mockResolvedValue({ masterIp: { value: '1.2.3.4' } }),
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e3', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /AccessDenied/,
    );
    expect(stack.outputs).not.toHaveBeenCalled();
  });

  it('does not engage when the failing command was not `pulumi up`', async () => {
    const stack = makeStack({
      up: vi.fn().mockRejectedValue(commandError(STACK_OUTPUT_ARGV, 1, HISTORY_WRITE_403_STDERR)),
      outputs: vi.fn().mockResolvedValue({ masterIp: { value: '1.2.3.4' } }),
    });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e3', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /saving update info/,
    );
  });
});

describe('upStack — staleness fails LOUDLY (band-aid removal 2026-08-16)', () => {
  // The recovery machinery these suites used to exercise — the up-path
  // widenings, the guarded startup re-run, the post-up read-only reread and
  // the requiredOutputs stale-read poll — is DELETED with its manufactured
  // trigger (fresh/recreated buckets under our own parallel load; all
  // root-fixed). What these pins guarantee now: every staleness spelling
  // surfaces on the FIRST attempt with its cause named, and the only absorbers
  // left on the up path are backpressure retry and the history-write
  // adjudicator above.

  beforeEach(() => {
    createOrSelectStackMock.mockReset();
    progressLogMock.mockReset();
  });

  it('a lock-blob 404 at up fails immediately — no in-place retry', async () => {
    const stack = healthyStackShell('e2-primary');
    stack.up = vi.fn().mockRejectedValue(commandError(UP_HA_ARGV, 1, LOCK_BLOB_404_TAIL));
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e2-primary', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /NoSuchKey/,
    );
    expect(stack.up).toHaveBeenCalledTimes(1);
  });

  it('a startup "no stack named" from up fails immediately — the guarded re-run is gone', async () => {
    const stack = healthyStackShell('e1');
    stack.up = vi.fn().mockRejectedValue(commandError(UP_ARGV, 6));
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e1', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /no stack named/i,
    );
    expect(stack.up).toHaveBeenCalledTimes(1);
    // The old recovery probed state and re-ran up; none of that machinery may
    // fire any more.
    expect(stack.outputs).not.toHaveBeenCalled();
  });

  it('a post-up outputs 404 fails immediately — resources exist, operator must look', async () => {
    const stack = healthyStackShell('e1');
    stack.up = vi.fn().mockRejectedValue(commandError(STACK_OUTPUT_ARGV, 255));
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e1', () => ({}), { projectName: 'testproj' })).rejects.toThrow(
      /no stack named/i,
    );
    expect(stack.outputs).not.toHaveBeenCalled();
  });

  it('incomplete requiredOutputs throw a named error instead of being re-read into silence', async () => {
    const stack = healthyStackShell('e1');
    stack.up = vi.fn().mockResolvedValue({ outputs: {}, summary: { result: 'succeeded' } });
    createOrSelectStackMock.mockResolvedValue(stack);

    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(
      upStack('e1', () => ({}), { projectName: 'testproj', requiredOutputs: ['serverIp'] }),
    ).rejects.toThrow(/missing \[serverIp\]/);
    expect(stack.outputs).not.toHaveBeenCalled();
  });
});

/** Minimal healthy stack whose refresh path is inert. */
function healthyStackShell(name: string) {
  return {
    name,
    cancel: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue({}),
    exportStack: vi.fn().mockResolvedValue({ deployment: { resources: [] } }),
    outputs: vi.fn().mockResolvedValue({}),
    workspace: { removeStack: vi.fn() },
    up: vi.fn(),
  };
}

/**
 * `isDiyGetTargetPanic` — the TWO-FRAME discriminator.
 *
 * The classifier's positive path is exercised through `classifyStateError` by
 * the corpus entry `checkpoint-stale-panic`, but nothing guarded the two
 * NEGATIVES, and they are the entire reason the function demands both frames:
 * `getTarget` alone only says the DIY backend read a target, while `newUpdate`
 * is what proves the read happened on the pre-plan path where nothing was
 * mutated. Without these, the function could be narrowed to a single frame —
 * or widened to any pulumi panic — and every other test would stay green.
 * (The fixtures below outlived their tests when the staleness-recovery
 * machinery was deleted in 64727ceb; this restores the guard they were
 * recorded for.)
 */
describe('isDiyGetTargetPanic — both diy frames or it does not qualify', () => {
  it('accepts the verbatim 2026-08-06 e4-primary panic (getTarget + newUpdate)', async () => {
    const { isDiyGetTargetPanic } = await import('../../../src/lib/iac/state-error.js');
    expect(isDiyGetTargetPanic(DIY_GETTARGET_PANIC_STDERR)).toBe(true);
  });

  it('rejects a pulumi panic from somewhere else entirely', async () => {
    const { isDiyGetTargetPanic } = await import('../../../src/lib/iac/state-error.js');
    expect(isDiyGetTargetPanic(UNRELATED_PANIC_STDERR)).toBe(false);
  });

  it('rejects a getTarget panic with NO newUpdate frame — the mutation-safety half', async () => {
    const { isDiyGetTargetPanic } = await import('../../../src/lib/iac/state-error.js');
    expect(isDiyGetTargetPanic(GETTARGET_WITHOUT_NEWUPDATE_PANIC_STDERR)).toBe(false);
  });
});

/**
 * `upStack`'s pre-up refresh decision.
 *
 * The refresh exists to clear pending-op markers and reconcile drift, and it
 * is SKIPPED on a stack holding only the bookkeeping `pulumi:pulumi:Stack`
 * entry (3-8s of plugin spawn + cloud listing for nothing on a cold deploy).
 * That skip is an optimization sitting directly on the state-correctness path
 * — refresh is also what copies outputs into inputs — so which way it decides
 * needs a guard, and had none: `WITH_RESOURCES` sat unused from the same
 * deletion. `exportStack` failure must fall through to the SAFER always-refresh
 * side, never to the skip.
 */
describe('upStack — pre-up refresh is skipped only on a provably empty stack', () => {
  beforeEach(() => {
    createOrSelectStackMock.mockReset();
    progressLogMock.mockReset();
  });

  const runUp = async (over: Partial<FakeStack>) => {
    const stack = makeStack(over);
    createOrSelectStackMock.mockResolvedValue(stack);
    const { upStack } = await import('../../../src/lib/iac/index.js');
    await upStack('e1', () => ({}), { projectName: 'testproj' });
    return stack;
  };

  it('skips the refresh when state holds only the bookkeeping Stack resource', async () => {
    const stack = await runUp({ exportStack: vi.fn().mockResolvedValue(STACK_ONLY) });
    expect(stack.refresh).not.toHaveBeenCalled();
    expect(stack.up).toHaveBeenCalledTimes(1);
  });

  it('refreshes when state holds a real cloud resource', async () => {
    const stack = await runUp({ exportStack: vi.fn().mockResolvedValue(WITH_RESOURCES) });
    expect(stack.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes when exportStack itself fails — the fail-safe is refresh, not skip', async () => {
    const stack = await runUp({
      exportStack: vi.fn().mockRejectedValue(new Error('backend unreachable')),
    });
    expect(stack.refresh).toHaveBeenCalledTimes(1);
  });
});
