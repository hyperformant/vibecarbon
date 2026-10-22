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

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  pullK3sRuntimeBase,
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

/**
 * The runtime base pull is not opportunistic: the app image's layer delta
 * (deliverImage) awaits it, so a master holding the base is sent only the
 * app's own layers. Inspect first, so a warm master asks no registry.
 */
describe('pullK3sRuntimeBase', () => {
  const BASE = 'ghcr.io/hyperformant/node-runtime:24-alpine3.24-r1';
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /** Runs the script against a stub `k3s`; `held` is what `images ls -q` lists. */
  function stubK3s(held: string, pullExit = 0) {
    dir = mkdtempSync(join(tmpdir(), 'k3s-base-'));
    const log = join(dir, 'calls');
    writeFileSync(
      join(dir, 'k3s'),
      `#!/bin/sh\necho "$*" >> ${log}\ncase "$4 $5" in\n  "images ls") printf '%s' '${held}' ;;\n  "images pull") [ ${pullExit} -eq 0 ] || { echo 'ctr: failed to resolve reference "x": unauthorized' >&2; exit 1; } ;;\nesac\n`,
    );
    chmodSync(join(dir, 'k3s'), 0o755);
    const run = async (script: string) => {
      const r = spawnSync('sh', ['-s'], {
        input: script,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      if (r.status !== 0) {
        throw Object.assign(new Error('Command failed: ssh root@m sh -s'), { stderr: r.stderr });
      }
      return r.stdout;
    };
    const calls = () => readFileSync(log, 'utf-8').trim().split('\n');
    return { run, calls };
  }

  it('a master that holds the base asks no registry', async () => {
    const k = stubK3s(`${BASE}\n`);
    await pullK3sRuntimeBase({ masterIp: 'm', sshKeyPath: '/k', baseRef: BASE, run: k.run });
    expect(k.calls()).toEqual([`ctr -n k8s.io images ls -q name==${BASE}`]);
  });

  it('a cold master pulls it into the k8s.io namespace the delta reads', async () => {
    const k = stubK3s('');
    await pullK3sRuntimeBase({ masterIp: 'm', sshKeyPath: '/k', baseRef: BASE, run: k.run });
    expect(k.calls()).toEqual([
      `ctr -n k8s.io images ls -q name==${BASE}`,
      `ctr -n k8s.io images pull ${BASE}`,
    ]);
  });

  it("a refused pull rejects with ctr's own line, not the ssh argv", async () => {
    const k = stubK3s('', 1);
    await expect(
      pullK3sRuntimeBase({ masterIp: 'm', sshKeyPath: '/k', baseRef: BASE, run: k.run }),
    ).rejects.toThrow(/^ctr: failed to resolve reference "x": unauthorized$/);
  });

  it('quotes the ref into the script', async () => {
    const run = vi.fn(async () => '');
    await pullK3sRuntimeBase({ masterIp: 'm', sshKeyPath: '/k', baseRef: "a'b", run });
    expect(String(run.mock.calls[0]?.[0])).toContain(`name=='a'\\''b'`);
  });
});
