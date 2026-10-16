/**
 * k8s failover: post-promotion readiness gate.
 *
 * Live RCA (k8s-ha full-lifecycle 2026-07-07 — failover PASSED first-ever):
 * `vibecarbon failover` returned in ~44s (promotion ~9s via the skip-if-
 * streaming fast path) BEFORE the promoted cluster's API layer was ready.
 * Post-promotion the promoted cluster's API services (since folded into the
 * app) restart/reconnect; during that window auth 502s and the REST layer
 * serves schema-cache misses against the (present) tables. verify-failover ran inside that window → auth_admin_login /
 * auth_signup / db_schema all failed while the db was healthy ~5 min later.
 *
 * The gate (Task 10): rollout-status EACH persisted scale-up entry on the
 * PROMOTED cluster (best-effort — a stuck/missing deployment must not sink a
 * promotion that already happened), then poll the public API (health + ready)
 * until it actually serves 2xx. Auth runs inside the app on the promoted
 * database, so the app's readiness (it answers against that database) is
 * the sign-in condition; there is no separate auth service to probe. Best-effort throughout (loud warning, never
 * throws) — the promotion + DNS flip already happened.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  gatePromotedApiReadiness,
  promotedProbeArgv,
  waitForPromotedApiServing,
} from '../../../src/failover.js';

/**
 * Persisted scale-up list: app + another vibecarbon-namespace Deployment + CA
 * (kube-system). The middle entry is a stand-in for any extra Deployment a
 * persisted list can carry, including a stale one the cluster no longer runs.
 */
const SCALE_UP_LIST = [
  { name: 'app', namespace: 'vibecarbon', replicas: 2 },
  { name: 'retired-worker', namespace: 'vibecarbon', replicas: 1 },
  { name: 'cluster-autoscaler', namespace: 'kube-system', replicas: 1 },
];

const noopSpinner = () => ({ start: vi.fn(), stop: vi.fn() });

describe('gatePromotedApiReadiness', () => {
  it('rollout-status-waits EVERY persisted scale-up entry in its own namespace, THEN probes', async () => {
    const trace: string[] = [];
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv[0] === 'rollout' && argv[1] === 'status') trace.push(`rollout:${argv[2]}`);
      return '';
    });
    const runner = vi.fn(async () => {
      trace.push('probe');
      return '200';
    });

    await gatePromotedApiReadiness('app.example.com', '9.9.9.9', '/key', noopSpinner(), {
      scaleUpList: SCALE_UP_LIST,
      kubectl,
      runner,
    });

    const rollouts = trace.filter((t) => t.startsWith('rollout:'));
    expect(rollouts).toEqual([
      'rollout:deployment/app',
      'rollout:deployment/retired-worker',
      'rollout:deployment/cluster-autoscaler',
    ]);
    // Each rollout targets its persisted namespace (CA lives in kube-system).
    const nsOf = (name: string) => {
      const argv = kubectl.mock.calls.find((c) =>
        (c[2] as string[]).includes(`deployment/${name}`),
      )?.[2] as string[];
      return argv[argv.indexOf('-n') + 1];
    };
    expect(nsOf('app')).toBe('vibecarbon');
    expect(nsOf('cluster-autoscaler')).toBe('kube-system');

    // Ordering: every rollout-status is issued before the first public probe.
    const lastRollout = trace.map((t) => t.startsWith('rollout:')).lastIndexOf(true);
    const firstProbe = trace.indexOf('probe');
    expect(firstProbe).toBeGreaterThan(-1);
    expect(lastRollout).toBeLessThan(firstProbe);
  });

  it('dispatches all rollout-status waits in PARALLEL, not serially', async () => {
    // The gate now includes real provisioning + a scale-up + up to ~11 rollout
    // waits; serially at 130s each that alone could blow the e2e failover
    // budget. Promise.all dispatches every rollout-status before any awaits —
    // a serial for-await would leave only the first in flight behind the barrier.
    let dispatched = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv[0] === 'rollout' && argv[1] === 'status') {
        dispatched++;
        await barrier; // hold every rollout open until we release
      }
      return '';
    });
    const runner = vi.fn(async () => '200');

    const gatePromise = gatePromotedApiReadiness(
      'app.example.com',
      '9.9.9.9',
      '/key',
      noopSpinner(),
      { scaleUpList: SCALE_UP_LIST, kubectl, runner },
    );
    // Synchronous check: Promise.all's map fired all three rollout-status calls
    // before any resolved. (A serial for-await would read 1 here.)
    expect(dispatched).toBe(SCALE_UP_LIST.length);
    release();
    await gatePromise;
    // Still swallowed + still probed after the parallel rollouts settled.
    expect(runner).toHaveBeenCalled();
  });

  it('bounds each rollout-status inside the SSH client timeout (server 120s < client 130s)', async () => {
    // Reconciliation invariant: the kubectl-side --timeout must sit INSIDE the
    // SSH client timeout, or the client kills the connection first and the
    // kubectl error (which names the stuck deployment) never surfaces.
    const calls: Array<{ argv: string[]; opts?: { timeout?: number } }> = [];
    const kubectl = vi.fn(
      async (_ip: string, _key: string, argv: string[], opts?: { timeout?: number }) => {
        calls.push({ argv, opts });
        return '';
      },
    );
    const runner = vi.fn(async () => '200');

    await gatePromotedApiReadiness('app.example.com', '9.9.9.9', '/key', noopSpinner(), {
      scaleUpList: SCALE_UP_LIST,
      kubectl,
      runner,
    });

    const statuses = calls.filter((c) => c.argv[0] === 'rollout' && c.argv[1] === 'status');
    expect(statuses.length).toBe(SCALE_UP_LIST.length);
    for (const c of statuses) {
      expect(c.argv).toContain('--timeout=120s');
      expect(c.opts).toMatchObject({ timeout: 130_000 });
    }
  });

  it('swallows a per-deployment rollout failure so one bad name cannot sink the gate', async () => {
    const runner = vi.fn(async () => '200');
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv.includes('deployment/retired-worker')) {
        throw new Error('deployments.apps "retired-worker" not found');
      }
      return '';
    });

    await expect(
      gatePromotedApiReadiness('app.example.com', '9.9.9.9', '/key', noopSpinner(), {
        scaleUpList: SCALE_UP_LIST,
        kubectl,
        runner,
      }),
    ).resolves.toBeUndefined();
    // The gate still went on to probe the public API.
    expect(runner).toHaveBeenCalled();
  });

  it('skips the public probe cleanly when no domain is configured', async () => {
    const runner = vi.fn(async () => '200');
    const kubectl = vi.fn(async () => '');
    await gatePromotedApiReadiness('', '9.9.9.9', '/key', noopSpinner(), {
      scaleUpList: SCALE_UP_LIST,
      kubectl,
      runner,
    });
    // Rollouts still ran, but no probe fired without a domain.
    expect(kubectl.mock.calls.some((c) => c[2][0] === 'rollout')).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('promotedProbeArgv', () => {
  it('builds a --resolve curl that hits the promoted node ingress directly', () => {
    const argv = promotedProbeArgv('app.example.com', '/api/health');
    // --resolve pins the domain to loopback so the probe traverses the real
    // public path (traefik hostPort) without waiting on DNS propagation.
    expect(argv).toContain('--resolve');
    expect(argv).toContain('app.example.com:443:127.0.0.1');
    expect(argv).toContain('https://app.example.com/api/health');
    // Emits ONLY the HTTP status code to stdout.
    expect(argv).toContain('%{http_code}');
  });

  it('sends no gateway key: the app routes need none', () => {
    expect(promotedProbeArgv('app.example.com', '/api/health')).not.toContain('-H');
  });
});

describe('waitForPromotedApiServing', () => {
  const pathOf = (argv: string[]) => argv[argv.length - 1];

  it('returns true only once health AND ready both serve 200', async () => {
    const seen: string[] = [];
    const runner = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      const url = pathOf(argv);
      seen.push(url);
      return '200';
    });

    const ok = await waitForPromotedApiServing('app.example.com', '9.9.9.9', '/key', { runner });
    expect(ok).toBe(true);

    // Liveness first, then readiness (the app answers against the promoted
    // database, which is also what sign-in needs). No gateway routes: auth
    // runs inside the app, and the storage service is gone.
    expect(seen[0]).toMatch(/\/api\/health$/);
    expect(seen.some((u) => u.endsWith('/api/health/ready'))).toBe(true);
    expect(seen.some((u) => u.includes('/auth/v1/'))).toBe(false);
    expect(seen.some((u) => u.includes('/storage/v1/'))).toBe(false);
  });

  it('does NOT probe readiness while liveness is still non-200', async () => {
    const seen: string[] = [];
    const runner = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      seen.push(pathOf(argv));
      return '503'; // health never comes up
    });

    // Tiny budget so pollUntil gives up after a single probe round.
    const ok = await waitForPromotedApiServing('app.example.com', '9.9.9.9', '/key', {
      runner,
      budgetMs: 10,
    });
    expect(ok).toBe(false);
    expect(seen.every((u) => !u.endsWith('/api/health/ready'))).toBe(true);
  });

  it('is best-effort: returns false (never throws) when the budget lapses', async () => {
    const runner = vi.fn(async () => '502');
    await expect(
      waitForPromotedApiServing('app.example.com', '9.9.9.9', '/key', { runner, budgetMs: 10 }),
    ).resolves.toBe(false);
  });
});
