/**
 * `getOrCreateStack` must never write an EMPTY stack over real state.
 *
 * RCA (k8s-ha record attempt 4, 2026-08-06). The restore step deletes and
 * recreates the Pulumi state bucket UNDER THE SAME NAME — the strongest
 * read-after-write staleness trigger Ceph/RGW has. Later, `failover` and
 * `destroy` read the recreated bucket and their `pulumi stack select` 404'd.
 *
 * The automation API turns that 404 into stack CREATION, silently:
 *
 *     case "createOrSelect":
 *       this.ready = workspace.selectStack(name).catch((err) => {
 *         if (err instanceof StackNotFoundError) return workspace.createStack(name);
 *         throw err;
 *       });                       // automation/stack.js
 *
 * `createStack` writes a fresh empty checkpoint to
 * `.pulumi/stacks/<project>/<stack>.json`, DESTROYING the real state. That is
 * how one stale read became:
 *
 *   - failover: "e4-standby: outputs object empty (fresh stack)" against a
 *     live cluster, then two `upStack` failures as Pulumi planned to create
 *     servers that already existed; and
 *   - final-destroy: e4-primary read empty while the env recorded real
 *     infrastructure — the wrong-empty-stack guard firing honestly.
 *
 * Note the pre-existing `withStateBackendRetry` around `createOrSelectStack`
 * could never help: the StackNotFoundError is swallowed INSIDE the automation
 * API, so the wrapper never sees a failure to retry — the call "succeeds".
 *
 * The fix drives select and create ourselves so absence is a decision we make,
 * on evidence, rather than one the SDK makes for us.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectStackMock = vi.fn();
const createStackMock = vi.fn();
const workspaceCreateMock = vi.fn();
const progressLogMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...a: unknown[]) => selectStackMock(...a),
    createStack: (...a: unknown[]) => createStackMock(...a),
    create: (...a: unknown[]) => workspaceCreateMock(...a),
  },
}));

vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (...args: unknown[]) => progressLogMock(...args),
}));

/** The automation API's StackNotFoundError, as `createCommandError` builds it. */
function stackNotFound(stackName = 'e4-standby') {
  const stderr =
    `Command failed with exit code 6: pulumi stack select ${stackName} --non-interactive\n` +
    `error: no stack named '${stackName}' found`;
  const err = new Error(`code: -2\n stdout: \n stderr: ${stderr}\n err?: Error: ${stderr}\n`);
  err.name = 'StackNotFoundError';
  return err;
}

const fakeStack = (name: string) => ({ name, __real: true });

/** `listStacks` builds its own workspace, then calls listStacks() on it. */
function backendLists(names: string[]) {
  workspaceCreateMock.mockResolvedValue({
    listStacks: vi.fn().mockResolvedValue(names.map((name) => ({ name }))),
  });
}

describe('getOrCreateStack — a stale select must never create over real state', () => {
  beforeEach(() => {
    selectStackMock.mockReset();
    createStackMock.mockReset();
    workspaceCreateMock.mockReset();
    progressLogMock.mockReset();
    backendLists([]);
  });

  it('selects an existing stack and never calls createStack', async () => {
    selectStackMock.mockResolvedValue(fakeStack('e4-primary'));

    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    const stack = await getOrCreateStack('e4-primary', () => ({}), { projectName: 'testproj' });

    expect(stack).toEqual(fakeStack('e4-primary'));
    expect(createStackMock).not.toHaveBeenCalled();
  });

  // The incident, on the deploy/scale path. Absence has to be CORROBORATED by
  // an independent read before we are allowed to write an empty checkpoint.
  it('does NOT create when the backend still lists the stack — and FAILS instead of polling', async () => {
    // The never-clobber corroboration survives the 2026-08-16 band-aid
    // removal unchanged: a listed-but-404ing stack must never be created
    // over. What changed is the response — the stale read is no longer
    // polled into submission; the backend contradicting itself is a store
    // fault the operator must see.
    backendLists(['e4-primary', 'e4-standby']);
    selectStackMock.mockRejectedValue(stackNotFound());

    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    await expect(
      getOrCreateStack('e4-standby', () => ({}), { projectName: 'testproj' }),
    ).rejects.toThrow(/LISTS this stack but reading its file 404'd/);
    expect(createStackMock).not.toHaveBeenCalled();
  });

  it('creates the stack when the backend genuinely does not list it (fresh deploy)', async () => {
    backendLists(['some-other-stack']);
    selectStackMock.mockRejectedValue(stackNotFound('e9'));
    createStackMock.mockResolvedValue(fakeStack('e9'));

    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    const stack = await getOrCreateStack('e9', () => ({}), { projectName: 'testproj' });

    expect(stack).toEqual(fakeStack('e9'));
    expect(createStackMock).toHaveBeenCalledTimes(1);
  });

  // A fresh deploy must not pay a retry ladder for a stack that legitimately
  // does not exist yet.
  it('does not retry "no stack named" on the create-allowed path', async () => {
    backendLists([]);
    selectStackMock.mockRejectedValue(stackNotFound('e9'));
    createStackMock.mockResolvedValue(fakeStack('e9'));

    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    await getOrCreateStack('e9', () => ({}), { projectName: 'testproj' });

    expect(selectStackMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-not-found select error untouched', async () => {
    selectStackMock.mockRejectedValue(new Error('invalid credentials for bucket'));

    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    await expect(
      getOrCreateStack('e4-primary', () => ({}), { projectName: 'testproj' }),
    ).rejects.toThrow(/invalid credentials/);
    expect(createStackMock).not.toHaveBeenCalled();
  });
});

describe('getOrCreateStack — requireExisting (read / mutate-existing paths)', () => {
  beforeEach(() => {
    selectStackMock.mockReset();
    createStackMock.mockReset();
    workspaceCreateMock.mockReset();
    progressLogMock.mockReset();
    backendLists([]);
  });

  it('a "no stack named" on requireExisting refuses IMMEDIATELY — no staleness poll', async () => {
    // Band-aid removal 2026-08-16: the poll-through that would have absorbed a
    // first 404 is deleted with its recreated-bucket trigger. The refusal
    // itself (never create over what might be real state) is unchanged and
    // fires on the first read.
    selectStackMock
      .mockRejectedValueOnce(stackNotFound())
      .mockResolvedValueOnce(fakeStack('e4-standby'));

    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    await expect(
      getOrCreateStack('e4-standby', () => ({}), {
        projectName: 'testproj',
        requireExisting: true,
      }),
    ).rejects.toThrow(/Refusing to create an empty stack/);
    expect(selectStackMock).toHaveBeenCalledTimes(1);
    expect(createStackMock).not.toHaveBeenCalled();
  });

  it('throws a precise error instead of creating when the stack is durably absent', async () => {
    selectStackMock.mockRejectedValue(stackNotFound());

    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    vi.useFakeTimers();
    try {
      const pending = getOrCreateStack('e4-standby', () => ({}), {
        projectName: 'testproj',
        requireExisting: true,
      });
      const assertion = expect(pending).rejects.toThrow(
        /Refusing to create an empty stack in its place/i,
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    // The whole point: no empty checkpoint is ever written over real state.
    expect(createStackMock).not.toHaveBeenCalled();
  });

  it('flags the durable-absence error so idempotent callers can still recognize it', async () => {
    selectStackMock.mockRejectedValue(stackNotFound());

    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    vi.useFakeTimers();
    try {
      const pending = getOrCreateStack('e4-standby', () => ({}), {
        projectName: 'testproj',
        requireExisting: true,
      });
      const captured = pending.catch((e: Error & { stackNotFound?: boolean }) => e);
      await vi.advanceTimersByTimeAsync(120_000);
      const err = await captured;
      expect(err.stackNotFound).toBe(true);
      // destroyStack's historical predicate must keep matching.
      expect(err.message).toMatch(/no stack named/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('read / mutate-existing entry points refuse to create', () => {
  beforeEach(() => {
    selectStackMock.mockReset();
    createStackMock.mockReset();
    workspaceCreateMock.mockReset();
    progressLogMock.mockReset();
    backendLists([]);
  });

  it('getStackOutputs never creates a stack', async () => {
    selectStackMock.mockResolvedValue({
      outputs: vi.fn().mockResolvedValue({ masterIp: { value: '1.2.3.4' } }),
    });

    const { getStackOutputs } = await import('../../../src/lib/iac/index.js');
    const out = await getStackOutputs('e4-standby', () => ({}), { projectName: 'testproj' });

    expect(out).toEqual({ masterIp: '1.2.3.4' });
    expect(createStackMock).not.toHaveBeenCalled();
  });

  it('destroyStack stays idempotent on a durably-absent stack, without creating one', async () => {
    selectStackMock.mockRejectedValue(stackNotFound('e9'));

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    vi.useFakeTimers();
    try {
      const pending = destroyStack('e9', () => ({}), { projectName: 'testproj' });
      const captured = pending.then((r) => r);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await captured).toEqual({ destroyed: false });
    } finally {
      vi.useRealTimers();
    }
    expect(createStackMock).not.toHaveBeenCalled();
  });
});

describe('summarizePulumiError — stop reporting "code: -2"', () => {
  // The failover output said only "Provisioning failed (code: -2)". The
  // automation API's CommandError envelope starts with `code: N` and buries the
  // real text in its stderr slot, so every `err.message.split('\n')[0]` in the
  // CLI printed the envelope header instead of the error. This RCA had to be
  // reconstructed from perf lines because of it.
  it('extracts the real error line from a CommandError envelope', async () => {
    const { summarizePulumiError } = await import('../../../src/lib/iac/index.js');
    const err = stackNotFound('e4-standby');
    expect(err.message.split('\n')[0]).toBe('code: -2'); // what we used to print
    expect(summarizePulumiError(err)).toMatch(/no stack named 'e4-standby' found/);
    expect(summarizePulumiError(err)).not.toMatch(/^code:/);
  });

  it('surfaces a panic banner when there is no error: line', async () => {
    const { summarizePulumiError } = await import('../../../src/lib/iac/index.js');
    const msg =
      'code: -2\n stdout: \n stderr: Command failed with exit code 1: pulumi up\n' +
      'Panic:            runtime error: invalid memory address or nil pointer dereference\n';
    expect(summarizePulumiError(new Error(msg))).toMatch(/nil pointer dereference/);
  });

  it('passes ordinary single-line errors through unchanged', async () => {
    const { summarizePulumiError } = await import('../../../src/lib/iac/index.js');
    expect(summarizePulumiError(new Error('hcloud: server not found (not_found)'))).toBe(
      'hcloud: server not found (not_found)',
    );
  });

  it('never returns an empty string for a bare envelope', async () => {
    const { summarizePulumiError } = await import('../../../src/lib/iac/index.js');
    const out = summarizePulumiError(new Error('code: -2\n stdout: \n stderr: \n err?: \n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('code: -2');
  });
});

describe('structural pin', () => {
  // createOrSelectStack is the SDK call whose swallowed StackNotFoundError
  // destroyed real state. It must not come back.
  it('src/lib/iac/index.js never calls LocalWorkspace.createOrSelectStack', () => {
    const src = readFileSync(new URL('../../../src/lib/iac/index.js', import.meta.url), 'utf8');
    // Strip comments — the RCA is written up in prose there and names the call.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('createOrSelectStack');
  });

  it('the mutate-existing entry points pass requireExisting', () => {
    const src = readFileSync(new URL('../../../src/lib/iac/index.js', import.meta.url), 'utf8');
    // destroyStack + getStackOutputs + removeStackState
    expect(src.match(/requireExisting: true/g)).toHaveLength(3);
  });
});
