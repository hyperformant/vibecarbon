import { describe, expect, it, vi } from 'vitest';
import {
  awaitCertManagerAdmission,
  awaitControlPlaneServing,
  awaitPostgresAccepting,
  CERT_MANAGER_ADMISSION_PROBE_MANIFEST,
  // @ts-expect-error — JS module without types
} from '../../../src/lib/deploy/k8s/readiness.js';

vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));

/**
 * Condition probes replacing timer-shaped gates (mitigation audit clusters
 * 1+4, 2026-08-16). The property under test throughout: these poll until the
 * CONDITION holds — an apiserver that answers /readyz and round-trips a
 * server-side dry-run, an admission pipeline that round-trips a real
 * cert-manager resource — and never "pass" on elapsed time. The downstream
 * ladders (KUBECTL_WEBHOOK_RETRY_DELAYS_MS, runHelmWithWebhookRetry) exist
 * precisely because the old Available gate measured the wrong thing; these
 * probes measure the right thing, so those ladders become tripwires.
 */

const noSleep = () => Promise.resolve();

describe('awaitControlPlaneServing', () => {
  it('resolves only when BOTH /readyz and the dry-run apply succeed', async () => {
    const calls: string[][] = [];
    let readyzFails = 2;
    const exec = vi.fn(async (argv: string[]) => {
      calls.push(argv);
      if (argv.includes('/readyz')) {
        if (readyzFails-- > 0)
          throw new Error('the server is currently unable to handle the request');
        return 'ok';
      }
      return 'configmap/vibecarbon-readiness-probe created (server dry run)';
    });

    await awaitControlPlaneServing({ env: {}, exec, sleep: noSleep, budgetMs: 60_000 });

    // /readyz was retried through its failures, and the dry-run ran after it
    // succeeded — both conditions, in order, within one passing iteration.
    const readyzCalls = calls.filter((a) => a.includes('/readyz')).length;
    const dryRunCalls = calls.filter((a) => a.includes('--dry-run=server')).length;
    expect(readyzCalls).toBe(3);
    expect(dryRunCalls).toBe(1);
  });

  it('keeps polling when /readyz is ok but admission dry-run still fails', async () => {
    // The whole point: a control plane can answer health checks while its
    // admission/discovery chain still 500s. Time alone must never pass it.
    let dryRunFails = 2;
    const exec = vi.fn(async (argv: string[]) => {
      if (argv.includes('/readyz')) return 'ok';
      if (dryRunFails-- > 0) throw new Error('Internal error occurred: failed calling webhook');
      return 'created (server dry run)';
    });

    await awaitControlPlaneServing({ env: {}, exec, sleep: noSleep, budgetMs: 60_000 });
    expect(exec.mock.calls.filter((c) => c[0].includes('--dry-run=server')).length).toBe(3);
  });

  it('throws the REAL last error at budget exhaustion, not a generic timeout', async () => {
    const exec = vi.fn(async () => {
      throw new Error('connection refused: 127.0.0.1:6443');
    });
    let now = 0;
    await expect(
      awaitControlPlaneServing({
        env: {},
        exec,
        sleep: async () => {
          now += 10_000;
        },
        nowFn: () => now,
        budgetMs: 30_000,
      }),
    ).rejects.toThrow(/connection refused/);
  });
});

describe('awaitCertManagerAdmission', () => {
  it('probes with a real Issuer manifest through server-side dry-run', async () => {
    const inputs: string[] = [];
    const exec = vi.fn(async (_argv: string[], opts: { input?: string }) => {
      if (opts?.input) inputs.push(opts.input);
      return 'issuer.cert-manager.io/vibecarbon-admission-probe created (server dry run)';
    });

    await awaitCertManagerAdmission({ env: {}, exec, sleep: noSleep });

    // The probe must exercise the ACTUAL admission pipeline for cert-manager
    // resources — apiserver -> ValidatingWebhookConfiguration -> caBundle ->
    // webhook pod. Only a cert-manager.io resource does that.
    expect(inputs[0]).toContain('cert-manager.io');
    expect(inputs[0]).toContain('selfSigned');
    expect(exec.mock.calls[0][0]).toContain('--dry-run=server');
  });

  it('rides through the exact observed warm-up failures until the pipeline serves', async () => {
    // Both August incident shapes, verbatim: the 502 window (webhook pod not
    // dialable, 2026-08-07 d3) and the caBundle window (2026-08-10 e2e).
    const failures = [
      'Internal error occurred: failed calling webhook "webhook.cert-manager.io": failed to call webhook: Post "https://cert-manager-webhook.cert-manager.svc:443/validate?timeout=30s": 502 Bad Gateway',
      'Internal error occurred: failed calling webhook "webhook.cert-manager.io": failed to call webhook: tls: failed to verify certificate: x509: certificate signed by unknown authority',
    ];
    let i = 0;
    const exec = vi.fn(async () => {
      if (i < failures.length) throw new Error(failures[i++]);
      return 'created (server dry run)';
    });

    await awaitCertManagerAdmission({ env: {}, exec, sleep: noSleep });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('surfaces the real webhook error at exhaustion so a broken webhook fails loudly', async () => {
    const exec = vi.fn(async () => {
      throw new Error('failed calling webhook "webhook.cert-manager.io": no endpoints available');
    });
    let now = 0;
    await expect(
      awaitCertManagerAdmission({
        env: {},
        exec,
        sleep: async () => {
          now += 30_000;
        },
        nowFn: () => now,
        budgetMs: 60_000,
      }),
    ).rejects.toThrow(/no endpoints available/);
  });

  it('the probe manifest is inert — namespaced, self-signed, dry-run only by name', () => {
    // A probe that could mutate cluster state or collide with real resources
    // would be worse than the ladders it replaces.
    expect(CERT_MANAGER_ADMISSION_PROBE_MANIFEST).toContain('kind: Issuer');
    expect(CERT_MANAGER_ADMISSION_PROBE_MANIFEST).toContain('namespace: cert-manager');
    expect(CERT_MANAGER_ADMISSION_PROBE_MANIFEST).toContain('vibecarbon-admission-probe');
    expect(CERT_MANAGER_ADMISSION_PROBE_MANIFEST).not.toContain('ClusterIssuer');
  });
});

describe('awaitPostgresAccepting', () => {
  it('polls pg_isready through the mid-lifecycle window until accepting', async () => {
    // The 0fbb296f RCA shape: pod Running, database "shutting down". pg_isready
    // exits nonzero through exactly that window; the gate holds until it
    // exits 0 — the condition, not the pod phase.
    let rejects = 2;
    const exec = vi.fn(async (argv: string[]) => {
      expect(argv).toContain('pg_isready');
      if (rejects-- > 0) throw new Error('pg_isready exited 1');
      return 'accepting connections';
    });
    await awaitPostgresAccepting({
      env: {},
      dbPod: 'supabase-supabase-db-0',
      exec,
      sleep: noSleep,
    });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('surfaces the real failure at exhaustion', async () => {
    const exec = vi.fn(async () => {
      throw new Error('error: unable to upgrade connection: container not found ("supabase-db")');
    });
    let now = 0;
    await expect(
      awaitPostgresAccepting({
        env: {},
        dbPod: 'supabase-supabase-db-0',
        exec,
        sleep: async () => {
          now += 30_000;
        },
        nowFn: () => now,
        budgetMs: 60_000,
      }),
    ).rejects.toThrow(/container not found/);
  });
});
