/**
 * A k8s system image (k3s's own, named under the vibecarbon-system.invalid
 * alias) or any ghcr mirror whose package is still private fails every pull
 * with 401. Without a diagnosis that surfaces as a bare local-registry
 * rollout timeout; with one, the deploy says which mirror packages must be
 * made public.
 */
import { describe, expect, it } from 'vitest';
import {
  MIRROR_PULL_EVENTS_ARGV,
  mirrorPullFailureHint,
} from '../../../src/lib/deploy/k8s/mirror-pull-diagnosis.js';

const row = (ns: string, obj: string, reason: string, msg: string) =>
  `${ns}   ${obj}   ${reason}   ${msg}`;

describe('mirrorPullFailureHint', () => {
  it('names the alias images whose pull failed, as the packages that must be public', () => {
    const events = [
      row(
        'kube-system',
        'coredns-abc',
        'Scheduled',
        'Successfully assigned kube-system/coredns-abc',
      ),
      row(
        'vibecarbon',
        'local-registry-7f9',
        'FailedCreatePodSandBox',
        'Failed to create pod sandbox: rpc error: code = Unknown desc = failed to get sandbox image "vibecarbon-system.invalid/rancher/mirrored-pause:3.6": failed to pull image "vibecarbon-system.invalid/rancher/mirrored-pause:3.6": failed to resolve reference: 401 Unauthorized',
      ),
      row(
        'kube-system',
        'coredns-abc',
        'Failed',
        'Failed to pull image "vibecarbon-system.invalid/rancher/mirrored-coredns-coredns:1.12.0": 401 Unauthorized',
      ),
    ].join('\n');
    const hint = mirrorPullFailureHint(events);
    expect(hint).toMatch(/k3s system image/);
    expect(hint).toMatch(/vibecarbon-system\.invalid/);
    expect(hint).toContain('ghcr.io/hyperformant/mirrored-pause');
    expect(hint).toContain('ghcr.io/hyperformant/mirrored-coredns-coredns');
    expect(hint).toMatch(/must be public/);
  });

  it('names a ghcr mirror package (the registry pod itself) the same way', () => {
    const events = row(
      'vibecarbon',
      'local-registry-7f9',
      'Failed',
      'Failed to pull image "ghcr.io/hyperformant/registry:2.8.3@sha256:abc": failed to authorize: 401 Unauthorized',
    );
    const hint = mirrorPullFailureHint(events);
    expect(hint).toContain('ghcr.io/hyperformant/registry');
    expect(hint).not.toMatch(/k3s system image/);
  });

  it('says nothing when no mirror pull failed', () => {
    expect(mirrorPullFailureHint('')).toBeNull();
    expect(
      mirrorPullFailureHint(
        row(
          'vibecarbon',
          'app-1',
          'Failed',
          'Failed to pull image "docker.io/library/nginx:1": not found',
        ),
      ),
    ).toBeNull();
    // A successful pull of a mirror image is not a failure.
    expect(
      mirrorPullFailureHint(
        row(
          'kube-system',
          'coredns-abc',
          'Pulled',
          'Successfully pulled image "vibecarbon-system.invalid/rancher/mirrored-coredns-coredns:1.12.0"',
        ),
      ),
    ).toBeNull();
  });

  it('reads the events with one bounded, read-only kubectl get', () => {
    expect(MIRROR_PULL_EVENTS_ARGV.slice(0, 4)).toEqual(['kubectl', 'get', 'events', '-A']);
    expect(MIRROR_PULL_EVENTS_ARGV).not.toContain('delete');
    expect(MIRROR_PULL_EVENTS_ARGV.some((a) => a.startsWith('--request-timeout='))).toBe(true);
  });
});
