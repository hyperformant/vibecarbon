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

  it('probes over TCP, never the Unix socket — the first-boot temp server is socket-only', async () => {
    // d4 run 2 RCA (2026-08-28, timestamped in the standby db log): when the
    // chart's initdb runs (first boot — e.g. a restore-path standby whose
    // seed exited UNSEEDED by design), the docker-entrypoint starts a
    // TEMPORARY postgres that listens ONLY on the Unix socket, runs the init
    // scripts, then stops it before starting the real server. A socket
    // pg_isready passes against that temp server, and the very next psql
    // lands in the shutdown gap — exit 2, deploy dead. The real server is
    // the only one listening on TCP, so TCP is the condition that actually
    // discriminates "serving" from "mid-init".
    const exec = vi.fn(async (argv: string[]) => {
      const i = argv.indexOf('-h');
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).toBe('127.0.0.1');
      return 'accepting connections';
    });
    await awaitPostgresAccepting({
      env: {},
      dbPod: 'supabase-supabase-db-0',
      exec,
      sleep: noSleep,
    });
    expect(exec).toHaveBeenCalledTimes(1);
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

/**
 * Family census — "socket pg_isready against a db that can be in the
 * docker-entrypoint first-boot flow" (d4 run 2 RCA, 2026-08-28).
 *
 * The temp init server is socket-only; only the real server binds TCP. Every
 * pg_isready that can meet a FIRST-BOOT db must probe TCP — k8s AND compose
 * (the compose db image runs the same docker-entrypoint init flow; its
 * members were normalized 2026-08-28 after the k8s fix). Members that probe
 * a db with existing PGDATA (no init flow) are recorded here with their
 * reason rather than left to memory.
 */
import { readFileSync as readSrc } from 'node:fs';
import { join as joinPath } from 'node:path';

describe('pg_isready TCP census (k8s path)', () => {
  const root = joinPath(__dirname, '../../..');
  it('every kubectl-exec pg_isready in the k8s deploy path carries -h (TCP)', () => {
    const files = [
      'src/lib/deploy/k8s/readiness.js',
      'src/lib/deploy/k8s/ha/index.js',
      'src/lib/deploy/replication.js',
      'src/lib/deploy/compose/index.js',
      'src/lib/deploy/compose/ha.js',
      'src/lib/deploy/effects/compose-ha.js',
      'src/lib/deploy/walg-role.js',
    ];
    for (const rel of files) {
      const src = readSrc(joinPath(root, rel), 'utf8');
      // Every pg_isready occurrence in CODE must be followed by a -h flag
      // before the argv/command ends. Walk occurrences, not files.
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('pg_isready') || line.trimStart().startsWith('//')) return;
        if (line.trimStart().startsWith('*') || line.includes('does NOT authenticate')) return;
        // The flag may be on the same line (shell string) or within the next
        // few argv lines (array form).
        const window = lines.slice(i, i + 4).join('\n');
        expect(window, `${rel}:${i + 1} pg_isready without -h (TCP)`).toMatch(/-h/);
      });
    }
  });

  it('recorded socket-safe members (existing-PGDATA probes) are the only exceptions', () => {
    // restore.js:~181 (post-wal-g-restore replay wait) and failover.js:~203
    // (established primary probe) meet only non-empty-PGDATA servers — the
    // entrypoint skips the init flow there, so no temp server can exist.
    // This test documents the disposition; if either file grows a first-boot
    // window, move it into the census above.
    for (const rel of ['src/restore.js', 'src/failover.js']) {
      expect(readSrc(joinPath(root, rel), 'utf8')).toContain('pg_isready');
    }
  });
});
