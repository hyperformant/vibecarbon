/**
 * k8s failover: post-promotion readiness gate.
 *
 * Live RCA (k8s-ha full-lifecycle 2026-07-07 — failover PASSED first-ever):
 * `vibecarbon failover` returned in ~44s (promotion ~9s via the skip-if-
 * streaming fast path) BEFORE the promoted cluster's API layer was ready.
 * Post-promotion the promoted supabase services restart/reconnect; during that
 * window auth 502s and PostgREST serves schema-cache misses against the
 * (present) tables. verify-failover ran inside that window → auth_admin_login /
 * auth_signup / db_schema all failed while the db was healthy ~5 min later.
 *
 * The gate (Task 10): rollout-status EACH persisted scale-up entry on the
 * PROMOTED cluster (best-effort — a stuck/missing deployment must not sink a
 * promotion that already happened), then poll the public API (health + auth)
 * until it actually serves 2xx. Best-effort throughout (loud warning, never
 * throws) — the promotion + DNS flip already happened.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  gatePromotedApiReadiness,
  getPromotedAnonKey,
  promotedProbeArgv,
  waitForPromotedApiServing,
} from '../../../src/failover.js';

/** Persisted scale-up list: app + supabase-* (vibecarbon) + CA (kube-system). */
const SCALE_UP_LIST = [
  { name: 'app', namespace: 'vibecarbon', replicas: 2 },
  { name: 'supabase-supabase-auth', namespace: 'vibecarbon', replicas: 1 },
  { name: 'cluster-autoscaler', namespace: 'kube-system', replicas: 1 },
];

const noopSpinner = () => ({ start: vi.fn(), stop: vi.fn() });

describe('gatePromotedApiReadiness', () => {
  it('rollout-status-waits EVERY persisted scale-up entry in its own namespace, THEN probes', async () => {
    const trace: string[] = [];
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv[0] === 'rollout' && argv[1] === 'status') trace.push(`rollout:${argv[2]}`);
      else if (argv.includes('secret')) trace.push('secret');
      return argv.includes('secret') ? Buffer.from('anon-jwt').toString('base64') : '';
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
      'rollout:deployment/supabase-supabase-auth',
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
      return argv.includes('secret') ? Buffer.from('anon-jwt').toString('base64') : '';
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
        return argv.includes('secret') ? Buffer.from('anon-jwt').toString('base64') : '';
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
      if (argv.includes('deployment/supabase-supabase-auth')) {
        throw new Error('deployments.apps "supabase-supabase-auth" not found');
      }
      return argv.includes('secret') ? Buffer.from('anon-jwt').toString('base64') : '';
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

  it('sends the apikey header when an anon key is provided', () => {
    // Kong's declarative config has a key-auth plugin on /auth/v1/* — a
    // keyless probe gets 401 from kong before GoTrue is even reached, so
    // the gate could NEVER confirm auth and burned its full budget on
    // every k8s failover (observed 2026-07-08 matrix: "last auth=401",
    // 4m48s soft-fail). Same trap documented in tests/e2e/checks/health.ts.
    const argv = promotedProbeArgv('app.example.com', '/auth/v1/health', 'anon-jwt');
    const h = argv.indexOf('-H');
    expect(h).toBeGreaterThan(-1);
    expect(argv[h + 1]).toBe('apikey: anon-jwt');
  });

  it('omits the apikey header when no key is available', () => {
    expect(promotedProbeArgv('app.example.com', '/api/health')).not.toContain('-H');
  });
});

describe('getPromotedAnonKey', () => {
  it('reads and base64-decodes ANON_KEY from vibecarbon-secrets on the promoted node', async () => {
    const kubectl = vi.fn(async () => Buffer.from('anon-jwt').toString('base64'));
    const key = await getPromotedAnonKey('9.9.9.9', '/key', { kubectl });
    expect(key).toBe('anon-jwt');
    expect(kubectl.mock.calls[0][0]).toBe('9.9.9.9');
    expect(kubectl.mock.calls[0][2]).toEqual([
      'get',
      'secret',
      'vibecarbon-secrets',
      '-n',
      'vibecarbon',
      '-o',
      'jsonpath={.data.ANON_KEY}',
    ]);
    // Bounded: the secret read happens mid-failover against a possibly-sick
    // apiserver — it must not inherit sshRun's 120s default and stall the
    // gate; the probes themselves run on 12s timeouts.
    expect(kubectl.mock.calls[0][3]).toMatchObject({ timeout: 15_000 });
  });

  it('is best-effort: returns empty string when kubectl fails', async () => {
    const kubectl = vi.fn(async () => {
      throw new Error('secrets "vibecarbon-secrets" not found');
    });
    await expect(getPromotedAnonKey('9.9.9.9', '/key', { kubectl })).resolves.toBe('');
  });
});

describe('waitForPromotedApiServing', () => {
  const pathOf = (argv: string[]) => argv[argv.length - 1];

  it('returns true only once health, auth, AND storage all serve 200', async () => {
    const seen: string[] = [];
    const runner = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      const url = pathOf(argv);
      seen.push(url);
      return '200';
    });

    const ok = await waitForPromotedApiServing('app.example.com', '9.9.9.9', '/key', { runner });
    expect(ok).toBe(true);

    // Health is probed before auth, and every restarted Kong-routed upstream
    // the verify suite single-shots is exercised — storage included (its
    // absence is what let DO run 32309395314's compose sibling 502; the k8s
    // gate had the same one-service-short premise).
    expect(seen[0]).toContain('/api/health');
    expect(seen.some((u) => u.includes('/auth/v1/health'))).toBe(true);
    expect(seen.some((u) => u.includes('/storage/v1/status'))).toBe(true);
  });

  it('does NOT probe auth while health is still non-200', async () => {
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
    // Auth endpoint was never hit because health short-circuited the probe.
    expect(seen.every((u) => !u.includes('/auth/v1/health'))).toBe(true);
  });

  it('does NOT pass while ONLY storage is still coming up (migration window)', async () => {
    const runner = vi.fn(async (_ip: string, _key: string, argv: string[]) =>
      pathOf(argv).includes('/storage/v1/status') ? '502' : '200',
    );

    const ok = await waitForPromotedApiServing('app.example.com', '9.9.9.9', '/key', {
      runner,
      budgetMs: 10,
    });
    expect(ok).toBe(false);
  });

  it('passes once storage finishes its boot-time migrations and serves 200', async () => {
    let storageProbes = 0;
    const runner = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (pathOf(argv).includes('/storage/v1/status')) {
        storageProbes++;
        return storageProbes < 3 ? '502' : '200';
      }
      return '200';
    });

    const ok = await waitForPromotedApiServing('app.example.com', '9.9.9.9', '/key', {
      runner,
      budgetMs: 60_000,
      // keep the poll fast in unit time
      initialDelayMs: 1,
      maxDelayMs: 1,
    });
    expect(ok).toBe(true);
    expect(storageProbes).toBe(3);
  });

  it('is best-effort: returns false (never throws) when the budget lapses', async () => {
    const runner = vi.fn(async () => '502');
    await expect(
      waitForPromotedApiServing('app.example.com', '9.9.9.9', '/key', { runner, budgetMs: 10 }),
    ).resolves.toBe(false);
  });

  it('threads opts.anonKey into every probe as the apikey header', async () => {
    const argvs: string[][] = [];
    const runner = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      argvs.push(argv);
      return '200';
    });

    const ok = await waitForPromotedApiServing('app.example.com', '9.9.9.9', '/key', {
      runner,
      anonKey: 'anon-jwt',
    });
    expect(ok).toBe(true);
    expect(argvs.length).toBeGreaterThan(1);
    for (const argv of argvs) {
      expect(argv).toContain('apikey: anon-jwt');
    }
  });
});
