/**
 * Opportunistic image pre-pull on every k8s node.
 *
 * deployK3s fires a fire-and-forget `ctr images pull` on every node right after
 * k3s is Ready, minutes before anything needs the images, so kubelet finds
 * them already present: the cluster-autoscaler pod's pair (a 403'd CA pull
 * once ate the whole rollout budget) and the db image the db StatefulSet's
 * container and inits run. Failure of any part = kubelet pulls on demand.
 *
 * There is no chart to enumerate any more: the list is fixed and local, so no
 * network step can take the incident-critical CA pair down with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// prePullImages shells out once per node over ssh. Mocking the command
// layer — not node:child_process — keeps the test off the flaky builtin-mock
// path.
const runCommandAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runCommandAsync,
}));

import {
  buildPrePullImages,
  clusterAutoscalerPodImages,
  formatPrePullSummary,
  prePullImages,
} from '../../../src/lib/deploy/k8s/k3s.js';
import {
  carbonAutoscalerImageRef,
  clusterAutoscalerImageRef,
  dbImageRef,
} from '../../../src/lib/images.js';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

/**
 * Incident 2026-07-31 (e3 k8s e2e): the cluster-autoscaler rollout wait spent
 * its whole 300s budget on image pulls that 403'd. Pre-pulling both images of
 * that pod FIRST is the second line of defense behind the ghcr mirror: pulls
 * start minutes before applyK3sManifests waits on the rollout, so a slow
 * registry costs overlap instead of the deploy.
 */
describe('cluster-autoscaler pod images lead the pre-pull list', () => {
  it('pre-pulls BOTH containers of the cluster-autoscaler pod', () => {
    expect(clusterAutoscalerPodImages()).toEqual([
      clusterAutoscalerImageRef(),
      carbonAutoscalerImageRef(),
    ]);
  });

  it('puts them ahead of the extra images (pulls run sequentially per node)', () => {
    expect(buildPrePullImages([dbImageRef()])).toEqual([
      ...clusterAutoscalerPodImages(),
      dbImageRef(),
    ]);
  });

  it('is duplicate-free even if a CA image is also passed as an extra', () => {
    const out = buildPrePullImages([clusterAutoscalerImageRef(), dbImageRef()]);
    expect(out).toEqual([...new Set(out)]);
    expect(out[0]).toBe(clusterAutoscalerImageRef());
  });

  it('drops an extra ref that fails the shell-safety character allowlist', () => {
    // Refs are interpolated into a remote `sh -s` script.
    expect(buildPrePullImages(['ghcr.io/x/postgres:1; rm -rf /'])).toEqual(
      clusterAutoscalerPodImages(),
    );
  });

  it('every shipped ref clears the shell-safety allowlist', () => {
    // (plus `@sha256:<hex>` for a digest-pinned ref: still shell-inert).
    for (const ref of [...clusterAutoscalerPodImages(), dbImageRef()]) {
      expect(ref).toMatch(/^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+(@sha256:[a-f0-9]{64})?$/);
    }
  });
});

describe('prePullImages', () => {
  const NODES = ['10.0.0.1', '10.0.0.2'];
  const call = (extraImages?: string[]) =>
    prePullImages({
      nodeIps: NODES,
      sshKeyPath: '/tmp/key',
      khPath: '/tmp/known_hosts',
      extraImages,
    });
  const sshScripts = () =>
    runCommandAsync.mock.calls
      .filter(([argv]: [string[]]) => argv[0] === 'ssh')
      .map(([, opts]: [string[], { input: string }]) => opts.input);

  beforeEach(() => {
    runCommandAsync.mockReset();
    runCommandAsync.mockResolvedValue('');
  });

  it('leads every node’s script with the two cluster-autoscaler pulls, then the db image', async () => {
    const result = await call([dbImageRef()]);
    expect(result).toEqual({ images: 3, nodes: 2 });
    const scripts = sshScripts();
    expect(scripts).toHaveLength(2);
    for (const script of scripts) {
      const pulled = [...script.matchAll(/images pull (\S+)/g)].map((m) => m[1]);
      expect(pulled).toEqual([...clusterAutoscalerPodImages(), dbImageRef()]);
      // One bad ref never aborts the rest.
      expect(script).toContain('|| true');
    }
  });

  it('runs no helm and no network enumeration at all', async () => {
    await call([dbImageRef()]);
    expect(runCommandAsync.mock.calls.every(([argv]: [string[]]) => argv[0] === 'ssh')).toBe(true);
  });

  it('is a no-op ssh-wise when there are no nodes', async () => {
    await prePullImages({ nodeIps: [], sshKeyPath: '/tmp/key', khPath: '/tmp/kh' });
    expect(sshScripts()).toHaveLength(0);
  });

  it('summarizes the run in one line', () => {
    expect(formatPrePullSummary({ images: 3, nodes: 3 }, 42_000)).toBe(
      '[prepull] 3 images on 3 node(s) in 42s',
    );
  });
});

describe('deployK3s wiring', () => {
  const k3s = read('src/lib/deploy/k8s/k3s.js');

  it('fires the pre-pull opportunistically after k3s is ready (never awaited into the critical path)', () => {
    expect(k3s).toMatch(/prePullImages\(/);
    // Fire-and-forget: the call site must swallow failures.
    expect(k3s).toMatch(/\n {2}prePullImages\(\{[\s\S]{0,400}?\.catch\(/);
    expect(k3s).not.toMatch(/await prePullImages\(/);
  });

  it('pre-pulls the db image the StatefulSet runs', () => {
    expect(k3s).toMatch(/prePullImages\(\{[\s\S]{0,200}?extraImages: \[dbImageTag\]/);
  });
});
