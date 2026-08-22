import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Safety-critical destroy gate (feedback_orphan_auto_destroy_hazard.md /
// PR 1S): orphan Pulumi stacks (deployment interrupted before
// .vibecarbon.json was saved, so they aren't tracked in project config) must
// NEVER be auto-destroyed under a bare `-y`. Auto-destroying orphans is
// dangerous because an empty/mismatched s3Config makes stack discovery fall
// back to the GLOBAL local Pulumi backend — a bare `-y` there can nuke a
// DIFFERENT project's/scenario's stacks (observed 2026-04-26 batch run #5:
// compose's final-destroy destroyed compose-ha's e2-primary/e2-standby
// mid-deploy). Only an explicit `-orphans` flag may authorize teardown.
//
// This drives destroy.js's real `main()` (via the exported `run()`) through
// its actual orphan-detection branch, mocking only the Pulumi stack listing
// (findOrphanPulumiStacks' `listStacks` dependency) and the actual teardown
// call (destroyOrphanPulumiStack's `destroyK8s` dependency), then asserts
// the teardown is/isn't invoked — exercising the gate itself, not a proxy.

const listStacksMock = vi.fn();
const destroyK8sMock = vi.fn();
const loadProjectConfigMock = vi.fn();
// M3 Task 9g — the orphan path resolves Pulumi-backend credentials
// provider-aware (resolveDestroyS3Config → Provider.
// promptObjectStorageCredentials), same as the tracked-environment destroy
// path. projectConfig has no `.provider` field here, so providerFor
// defaults to Hetzner — mock its resolver to prove the orphan path threads
// the result into destroyK8s's s3Config rather than reading raw env vars.
const hetznerGetS3CredentialsMock = vi.fn();

vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: vi.fn(),
}));

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadProjectConfig: (...a: unknown[]) => loadProjectConfigMock(...a),
  };
});

vi.mock('../../../src/lib/iac/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, listStacks: (...a: unknown[]) => listStacksMock(...a) };
});

vi.mock('../../../src/lib/deploy/k8s/index.js', () => ({
  destroyK8s: (...a: unknown[]) => destroyK8sMock(...a),
}));

vi.mock('../../../src/lib/hetzner-guided-setup.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getS3Credentials: (...a: unknown[]) => hetznerGetS3CredentialsMock(...a),
  };
});

const { run } = await import('../../../src/destroy.js');

class ProcessExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code ?? 0);
  }) as never);
}

function primeUntracked(orphanNames: string[]) {
  // No environments tracked in project config — the exact "interrupted
  // deploy" precondition the orphan branch guards.
  loadProjectConfigMock.mockReturnValue({ environments: {}, s3Config: null, projectName: 'proj' });
  listStacksMock.mockResolvedValue(orphanNames);
}

// resolveProviderToken (providers/index.js) is env-only post-A3 — the
// orphan-destroy branch needs HETZNER_API_TOKEN set or it exits 1 before
// ever reaching the gate under test.
const ambientToken = process.env.HETZNER_API_TOKEN;
beforeEach(() => {
  process.env.HETZNER_API_TOKEN = 'test-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (ambientToken === undefined) delete process.env.HETZNER_API_TOKEN;
  else process.env.HETZNER_API_TOKEN = ambientToken;
});

describe('destroy orphan-gate (never auto-destroy orphan stacks without -orphans)', () => {
  it('finds the orphan stack but does NOT destroy it under -y alone', async () => {
    primeUntracked(['leaked-env']);
    mockProcessExit();

    await expect(run(['-y'])).rejects.toThrow(ProcessExitError);

    expect(listStacksMock).toHaveBeenCalled();
    expect(destroyK8sMock).not.toHaveBeenCalled();
  });

  it('destroys the orphan stack when -y is paired with -orphans', async () => {
    primeUntracked(['leaked-env']);
    destroyK8sMock.mockResolvedValue(undefined);
    mockProcessExit();

    await expect(run(['-y', '-orphans'])).rejects.toThrow(ProcessExitError);

    expect(destroyK8sMock).toHaveBeenCalledTimes(1);
    expect(destroyK8sMock).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'leaked-env' }),
    );
  });

  // M3 Task 9g — the orphan path must resolve its Pulumi-backend
  // credentials provider-aware (resolveDestroyS3Config), same as the
  // tracked-environment destroy path, not a raw process.env.HETZNER_ACCESS_KEY
  // read. This threads a real projectConfig.s3Config through the actual
  // orphan branch and asserts destroyK8s receives the resolved credentials
  // merged in — proving the wiring at this call site, not just the resolver
  // in isolation (see tests/unit/destroy/resolve-destroy-s3-config.test.ts
  // for that). The sandboxed test runner's stdin is itself non-TTY (matches
  // the e2e harness's `stdio: ['ignore', ...]` teardown shape), so
  // resolveDestroyS3Config's default `process.stdin` forwards
  // `skipPrompts: true` here — the mock still resolves creds (standing in
  // for env vars being present, the actual incident's shape), proving the
  // off-TTY path doesn't ALSO block a legitimately-resolvable credential.
  it('resolves Pulumi-backend credentials provider-aware and threads them into destroyK8s (Task 9g)', async () => {
    loadProjectConfigMock.mockReturnValue({
      environments: {},
      projectName: 'proj',
      s3Config: {
        bucket: 'proj-storage',
        region: 'fsn1',
        endpoint: 'https://fsn1.your-objectstorage.com',
        stateBucket: 'proj-storage-pulumi-state',
      },
    });
    listStacksMock.mockResolvedValue(['leaked-env']);
    hetznerGetS3CredentialsMock.mockResolvedValue({ accessKey: 'hz-ak', secretKey: 'hz-sk' });
    destroyK8sMock.mockResolvedValue(undefined);
    mockProcessExit();

    await expect(run(['-y', '-orphans'])).rejects.toThrow(ProcessExitError);

    expect(hetznerGetS3CredentialsMock).toHaveBeenCalledWith('proj', {
      save: false,
      skipPrompts: true,
    });
    expect(destroyK8sMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'leaked-env',
        s3Config: {
          bucket: 'proj-storage',
          region: 'fsn1',
          endpoint: 'https://fsn1.your-objectstorage.com',
          stateBucket: 'proj-storage-pulumi-state',
          accessKey: 'hz-ak',
          secretKey: 'hz-sk',
        },
      }),
    );
  });

  // Fix round 1 (review finding): the token guard must fire BEFORE
  // resolveDestroyS3Config's await, not behind it — pre-9g there was no
  // await in this branch at all, so a missing token always exited
  // immediately with zero risk of ever reaching a credentials prompt. This
  // proves that ordering survived the 9g fix: with a real
  // projectConfig.s3Config present (so resolveDestroyS3Config WOULD have a
  // reason to run if reached) and no API token, the guard must exit before
  // the S3-credentials resolver is ever called.
  it('fast-fails on a missing API token BEFORE resolving S3 backend credentials (ordering, Task 9g fix round 1)', async () => {
    delete process.env.HETZNER_API_TOKEN;
    loadProjectConfigMock.mockReturnValue({
      environments: {},
      projectName: 'proj',
      s3Config: {
        bucket: 'proj-storage',
        region: 'fsn1',
        endpoint: 'https://fsn1.your-objectstorage.com',
        stateBucket: 'proj-storage-pulumi-state',
      },
    });
    listStacksMock.mockResolvedValue(['leaked-env']);
    mockProcessExit();

    await expect(run(['-y', '-orphans'])).rejects.toThrow(ProcessExitError);

    expect(hetznerGetS3CredentialsMock).not.toHaveBeenCalled();
    expect(destroyK8sMock).not.toHaveBeenCalled();
  });

  it('never calls destroyK8s when there are no orphan stacks at all', async () => {
    primeUntracked([]);
    mockProcessExit();

    // No orphans + no tracked environments falls through to "nothing to
    // destroy" and exits 1 — still must not attempt any teardown.
    await expect(run(['-y', '-orphans'])).rejects.toThrow(ProcessExitError);

    expect(destroyK8sMock).not.toHaveBeenCalled();
  });
});
