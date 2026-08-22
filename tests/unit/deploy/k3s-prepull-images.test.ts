/**
 * Supabase image pre-pull (k8s-ha standby ~80s optimization).
 *
 * Pod-age snapshots across runs showed the standby cluster (hil) taking
 * ~135s for supabase pods to go all-Ready vs ash's 55-59s — Docker Hub image
 * pull speed, not scheduling. deployK3s now fires an opportunistic
 * fire-and-forget pre-pull of the chart's images on every node right after
 * k3s is Ready, 2-3 minutes before helm needs them, so kubelet finds the
 * images already present. Failure of any part = today's behavior (kubelet
 * pulls on demand).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// prePullChartImages shells out for BOTH halves of its work (helm enumeration
// + one ssh per node). Mocking the command layer — not node:child_process —
// keeps the test off the flaky builtin-mock path.
const runCommandAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runCommandAsync,
}));

import {
  buildPrePullImages,
  clusterAutoscalerPodImages,
  formatPrePullSummary,
  PREPULL_EXCLUDED_COMPONENTS,
  parseChartImages,
  prePullChartImages,
} from '../../../src/lib/deploy/k8s/k3s.js';
import { carbonAutoscalerImageRef, clusterAutoscalerImageRef } from '../../../src/lib/images.js';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

const FIXTURE = `
image:
  db:
    repository: supabase/postgres
    tag: 15.8.1.085
  studio:
    repository: supabase/studio
    tag: 2025.06.30-sha-6f5982d
  auth:
    repository: supabase/gotrue
    tag: v2.177.0
  rest:
    repository: postgrest/postgrest
    tag: v12.2.12
  kong:
    repository: kong
    tag: 2.8.1
  analytics:
    repository: supabase/logflare
    tag: 1.14.2
  vector:
    repository: timberio/vector
    tag: 0.28.1-alpine
  functions:
    repository: supabase/edge-runtime
    tag: v1.67.4
  minio:
    repository: minio/minio
    tag: latest
  imgproxy:
    repository: darthsim/imgproxy
    tag: v3.8.0
  evil:
    repository: "supabase/thing; rm -rf /"
    tag: bad
secret:
  jwt: {}
`;

describe('parseChartImages', () => {
  const images = parseChartImages(FIXTURE, { exclude: PREPULL_EXCLUDED_COMPONENTS });

  it('normalizes bare Docker Hub repos to fully-qualified refs', () => {
    expect(images).toContain('docker.io/supabase/gotrue:v2.177.0');
    expect(images).toContain('docker.io/postgrest/postgrest:v12.2.12');
    // Single-segment official image → library/ namespace.
    expect(images).toContain('docker.io/library/kong:2.8.1');
  });

  it('excludes the db image (sideloaded, never pulled) and disabled components', () => {
    const joined = images.join(' ');
    expect(joined).not.toContain('supabase/postgres');
    expect(joined).not.toContain('logflare'); // analytics disabled
    expect(joined).not.toContain('vector'); // vector disabled
    expect(joined).not.toContain('edge-runtime'); // functions disabled
    expect(joined).not.toContain('minio'); // minio disabled
  });

  it('drops refs that fail the shell-safety character allowlist', () => {
    expect(images.join(' ')).not.toContain('rm -rf');
  });

  it('is deterministic and duplicate-free', () => {
    expect(images).toEqual([...new Set(images)]);
    expect(images).toEqual(parseChartImages(FIXTURE, { exclude: PREPULL_EXCLUDED_COMPONENTS }));
  });
});

describe('exclusion list stays in lockstep with the values file', () => {
  it('every component disabled in supabase.values.yaml is excluded from pre-pull', () => {
    const values = read('carbon/k8s/values/supabase.values.yaml');
    // deployment.<comp>.enabled: false entries in our values.
    const disabled = [...values.matchAll(/^ {2}([a-z]+):\n(?: {4}#.*\n)* {4}enabled: false/gm)].map(
      (m) => m[1],
    );
    expect(disabled.length).toBeGreaterThanOrEqual(3); // functions, analytics, vector today
    for (const comp of disabled) {
      expect(PREPULL_EXCLUDED_COMPONENTS).toContain(comp);
    }
    // db is sideloaded — always excluded.
    expect(PREPULL_EXCLUDED_COMPONENTS).toContain('db');
  });
});

/**
 * The cluster-autoscaler pod's two images ride the same pre-pull.
 *
 * Incident 2026-07-31 (e3 k8s e2e): the CA rollout wait burned its full 300s
 * budget on `registry.k8s.io/autoscaling/cluster-autoscaler:v1.32.7` — three
 * pulls, three 403s, BackOff x20 over 5m11s. PR "ca-image-ghcr-mirror" moves
 * that image onto ghcr; pre-pulling it is the second, independent line of
 * defense: the pull starts minutes before applyK3sManifests waits on the
 * rollout, so a slow registry costs overlap instead of the deploy.
 */
describe('cluster-autoscaler pod images lead the pre-pull list', () => {
  it('pre-pulls BOTH containers of the cluster-autoscaler pod', () => {
    expect(clusterAutoscalerPodImages()).toEqual([
      clusterAutoscalerImageRef(),
      carbonAutoscalerImageRef(),
    ]);
  });

  it('puts them ahead of the chart images (pulls run sequentially per node)', () => {
    const chart = ['docker.io/supabase/gotrue:v2.177.0', 'docker.io/library/kong:2.8.1'];
    expect(buildPrePullImages(chart)).toEqual([...clusterAutoscalerPodImages(), ...chart]);
  });

  it('is duplicate-free even if a CA image also appears in the chart list', () => {
    const withDupe = [clusterAutoscalerImageRef(), 'docker.io/library/kong:2.8.1'];
    const out = buildPrePullImages(withDupe);
    expect(out).toEqual([...new Set(out)]);
    expect(out[0]).toBe(clusterAutoscalerImageRef());
  });

  it('CA refs clear the same shell-safety allowlist the chart refs must clear', () => {
    // They are interpolated into a remote `sh -s` script, same as every
    // parsed chart ref.
    for (const ref of clusterAutoscalerPodImages()) {
      expect(ref).toMatch(/^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$/);
    }
  });
});

describe('prePullChartImages', () => {
  const NODES = ['10.0.0.1', '10.0.0.2'];
  const call = () =>
    prePullChartImages({ nodeIps: NODES, sshKeyPath: '/tmp/key', khPath: '/tmp/known_hosts' });
  const sshScripts = () =>
    runCommandAsync.mock.calls
      .filter(([argv]: [string[]]) => argv[0] === 'ssh')
      .map(([, opts]: [string[], { input: string }]) => opts.input);

  beforeEach(() => {
    runCommandAsync.mockReset();
    runCommandAsync.mockImplementation(async (argv: string[]) =>
      argv[0] === 'helm' && argv[1] === 'show' ? FIXTURE : '',
    );
  });

  it('leads every node’s script with the two cluster-autoscaler pulls', async () => {
    const result = await call();
    expect(result.nodes).toBe(2);
    const scripts = sshScripts();
    expect(scripts).toHaveLength(2);
    for (const script of scripts) {
      const pulled = [...script.matchAll(/images pull (\S+)/g)].map((m) => m[1]);
      expect(pulled.slice(0, 2)).toEqual(clusterAutoscalerPodImages());
      expect(pulled).toContain('docker.io/supabase/gotrue:v2.177.0');
    }
  });

  it('still pre-pulls the CA images when chart enumeration fails', async () => {
    // Defense in depth is worthless if a `helm show values` hiccup takes the
    // incident-critical pair down with it.
    runCommandAsync.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'helm' && argv[1] === 'show') throw new Error('helm repo unreachable');
      return '';
    });
    const result = await call();
    expect(result.chartError).toBeInstanceOf(Error);
    expect(result.images).toBe(2);
    for (const script of sshScripts()) {
      const pulled = [...script.matchAll(/images pull (\S+)/g)].map((m) => m[1]);
      expect(pulled).toEqual(clusterAutoscalerPodImages());
    }
  });

  it('is a no-op ssh-wise when there are no nodes', async () => {
    await prePullChartImages({ nodeIps: [], sshKeyPath: '/tmp/key', khPath: '/tmp/kh' });
    expect(sshScripts()).toHaveLength(0);
  });

  it('reports a degraded run without claiming nothing was pulled', () => {
    const ok = formatPrePullSummary({ images: 12, nodes: 3, chartError: null }, 42_000);
    expect(ok).toBe('[prepull] 12 images on 3 node(s) in 42s');

    const degraded = formatPrePullSummary(
      { images: 2, nodes: 3, chartError: new Error('helm repo unreachable') },
      9_000,
    );
    expect(degraded).toContain('2 images on 3 node(s)');
    expect(degraded).toContain('helm repo unreachable');
    expect(degraded).toContain('cluster-autoscaler images only');
  });
});

describe('deployK3s wiring', () => {
  it('fires the pre-pull opportunistically after k3s is ready (never awaited into the critical path)', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toMatch(/prePullChartImages\(/);
    // Fire-and-forget: the call site must swallow failures.
    expect(k3s).toMatch(/prePullChartImages\([\s\S]{0,400}?\.catch\(/);
  });
});
