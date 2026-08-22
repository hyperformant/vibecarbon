import { afterEach, describe, expect, it, vi } from 'vitest';

// M3 Task 9g — destroy's Pulumi-backend credential resolution must route by
// provider, not always read Hetzner's Object Storage keys. `vibecarbon
// destroy` on DigitalOcean 403'd at `pulumi stack select` because
// destroyS3Config was built from raw process.env.HETZNER_ACCESS_KEY/
// HETZNER_SECRET_KEY (Hetzner's env vars) regardless of provider — pre-Task-9f
// that 403 was laundered into a fresh empty-stack "destroy" and a fake
// success (the confirmed trigger for the earlier orphan incidents).
//
// resolveDestroyS3Config is the fix: it reuses the SAME resolver the working
// bucket-deletion effects use (Provider.promptObjectStorageCredentials —
// see tests/unit/destroy/state-bucket-delete.test.ts for that path's
// coverage, whose vi.mock idiom this file mirrors for both providers). The
// orphan-stack path is additionally exercised end-to-end through the real
// `run()` entry point in tests/unit/destroy/orphan-gate.test.ts.
//
// Fix round 1 (review finding): off a TTY, missing env credentials must
// NEVER reach the interactive prompt — clack's prompt primitives have no
// isTTY/stdin-close handling of their own, so a non-TTY caller with no data
// on stdin hangs forever (this is why lib/cli/tty-guard.js exists). This is
// live-reachable: the e2e harness's teardown runs `destroy <env> -y
// -orphans` with non-TTY stdio specifically to clean up deploys that failed
// before creds were fully persisted. resolveDestroyS3Config threads
// `skipPrompts: !stdin.isTTY` through to the resolver to guarantee that; the
// `stdin` param is injectable (mirrors tty-guard.js's own test pattern) so
// these tests control TTY state explicitly rather than depending on the
// ambient test-runner environment.

const hetznerGetS3CredentialsMock = vi.fn();
const digitaloceanGetS3CredentialsMock = vi.fn();

vi.mock('../../../src/lib/hetzner-guided-setup.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getS3Credentials: (...a: unknown[]) => hetznerGetS3CredentialsMock(...a),
  };
});

vi.mock('../../../src/lib/digitalocean-guided-setup.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getS3Credentials: (...a: unknown[]) => digitaloceanGetS3CredentialsMock(...a),
  };
});

import { resolveDestroyS3Config } from '../../../src/destroy.js';
import { DigitalOceanProvider, HetznerProvider } from '../../../src/lib/providers/index.js';

const s3Fields = {
  bucket: 'app-storage',
  region: 'fsn1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  stateBucket: 'app-storage-pulumi-state',
};

const ttyStdin = { isTTY: true };
const nonTtyStdin = { isTTY: false };

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveDestroyS3Config', () => {
  it('resolves Hetzner credentials via HetznerProvider — regression pin, Hetzner routing unchanged', async () => {
    hetznerGetS3CredentialsMock.mockResolvedValue({ accessKey: 'hz-ak', secretKey: 'hz-sk' });

    const result = await resolveDestroyS3Config(HetznerProvider, 'proj', s3Fields, {
      stdin: ttyStdin,
    });

    expect(result).toEqual({ ...s3Fields, accessKey: 'hz-ak', secretKey: 'hz-sk' });
    expect(hetznerGetS3CredentialsMock).toHaveBeenCalledWith('proj', {
      save: false,
      skipPrompts: false,
    });
    expect(digitaloceanGetS3CredentialsMock).not.toHaveBeenCalled();
  });

  it('resolves DigitalOcean Spaces credentials via DigitalOceanProvider — the Task 9g fix (never Hetzner keys on a DO env)', async () => {
    digitaloceanGetS3CredentialsMock.mockResolvedValue({ accessKey: 'do-ak', secretKey: 'do-sk' });

    const result = await resolveDestroyS3Config(DigitalOceanProvider, 'proj', s3Fields, {
      stdin: ttyStdin,
    });

    expect(result).toEqual({ ...s3Fields, accessKey: 'do-ak', secretKey: 'do-sk' });
    expect(digitaloceanGetS3CredentialsMock).toHaveBeenCalledWith('proj', {
      save: false,
      skipPrompts: false,
    });
    expect(hetznerGetS3CredentialsMock).not.toHaveBeenCalled();
  });

  it('never asks the resolver to persist credentials — a destroy path must never write to .env.local', async () => {
    hetznerGetS3CredentialsMock.mockResolvedValue({ accessKey: 'hz-ak', secretKey: 'hz-sk' });
    await resolveDestroyS3Config(HetznerProvider, 'proj', s3Fields, { stdin: ttyStdin });
    expect(hetznerGetS3CredentialsMock).toHaveBeenCalledWith(
      'proj',
      expect.objectContaining({ save: false }),
    );
  });

  it('returns null without prompting when s3Fields is falsy (no backend recorded) — short-circuits before resolving credentials', async () => {
    const result = await resolveDestroyS3Config(HetznerProvider, 'proj', null, {
      stdin: ttyStdin,
    });
    expect(result).toBeNull();
    expect(hetznerGetS3CredentialsMock).not.toHaveBeenCalled();
    expect(digitaloceanGetS3CredentialsMock).not.toHaveBeenCalled();
  });

  // The loud-chain precondition (M3 Task 9g item 3): a null return here is
  // what callers pass through as s3Config, which makes resolveBackendUrl
  // (lib/iac/index.js) fall back to the local file:// backend — destroyStack
  // then runs against a fresh empty stack, and for the tracked-environment
  // call site recordPulumiDestroyOutcome (see
  // tests/unit/destroy/record-pulumi-destroy-outcome.test.ts) flags that
  // loudly whenever the environment has recorded infrastructure. This test
  // pins the piece of that chain resolveDestroyS3Config owns: missing
  // credentials must still produce null, not a Hetzner-keys-on-DO fallback.
  it('returns null when the resolved provider has no credentials available — feeds the loud partial-detection chain, not a silent fallback', async () => {
    digitaloceanGetS3CredentialsMock.mockResolvedValue(null);

    const result = await resolveDestroyS3Config(DigitalOceanProvider, 'proj', s3Fields, {
      stdin: ttyStdin,
    });

    expect(result).toBeNull();
  });

  it('preserves every base s3 field (bucket/region/endpoint/stateBucket) verbatim alongside the resolved credentials', async () => {
    hetznerGetS3CredentialsMock.mockResolvedValue({ accessKey: 'hz-ak', secretKey: 'hz-sk' });

    const result = await resolveDestroyS3Config(HetznerProvider, 'proj', s3Fields, {
      stdin: ttyStdin,
    });

    expect(result).toMatchObject(s3Fields);
  });

  describe('TTY gating (fix round 1 — non-TTY must never reach the interactive prompt)', () => {
    it('passes skipPrompts:true off-TTY, so a missing-credentials result never touched a prompt', async () => {
      // The mock stands in for getS3Credentials' own skipPrompts branch
      // (covered directly, with the real clack mock, in
      // hetzner-guided-setup.test.ts / digitalocean-guided-setup.test.ts) —
      // this test pins that resolveDestroyS3Config computes and forwards
      // skipPrompts correctly from the injected stdin.
      hetznerGetS3CredentialsMock.mockResolvedValue(null);

      const result = await resolveDestroyS3Config(HetznerProvider, 'proj', s3Fields, {
        stdin: nonTtyStdin,
      });

      expect(result).toBeNull();
      expect(hetznerGetS3CredentialsMock).toHaveBeenCalledWith('proj', {
        save: false,
        skipPrompts: true,
      });
    });

    it('passes skipPrompts:false on a real TTY — sibling-effect parity, prompt still allowed', async () => {
      hetznerGetS3CredentialsMock.mockResolvedValue({ accessKey: 'hz-ak', secretKey: 'hz-sk' });

      await resolveDestroyS3Config(HetznerProvider, 'proj', s3Fields, { stdin: ttyStdin });

      expect(hetznerGetS3CredentialsMock).toHaveBeenCalledWith('proj', {
        save: false,
        skipPrompts: false,
      });
    });

    it('defaults to the real process.stdin when no stdin is injected', async () => {
      // Production call sites don't inject stdin — this pins that the
      // default resolves from the real global rather than throwing or
      // silently no-op'ing. The sandboxed test runner's stdin is itself
      // non-TTY (matches the e2e harness's shape), so this exercises the
      // same off-TTY branch as the explicit nonTtyStdin case above.
      hetznerGetS3CredentialsMock.mockResolvedValue(null);

      const result = await resolveDestroyS3Config(HetznerProvider, 'proj', s3Fields);

      expect(result).toBeNull();
      expect(hetznerGetS3CredentialsMock).toHaveBeenCalledWith('proj', {
        save: false,
        skipPrompts: !process.stdin.isTTY,
      });
    });

    it('DigitalOcean resolution is TTY-gated the same way as Hetzner', async () => {
      digitaloceanGetS3CredentialsMock.mockResolvedValue(null);

      const result = await resolveDestroyS3Config(DigitalOceanProvider, 'proj', s3Fields, {
        stdin: nonTtyStdin,
      });

      expect(result).toBeNull();
      expect(digitaloceanGetS3CredentialsMock).toHaveBeenCalledWith('proj', {
        save: false,
        skipPrompts: true,
      });
    });
  });
});
