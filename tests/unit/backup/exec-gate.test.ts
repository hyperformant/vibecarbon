/**
 * The k8s manual-backup trigger must gate on the CONDITION the backup Job
 * actually depends on before creating it: a `kubectl exec` round-trip into the
 * db workload that reports Postgres accepting connections.
 *
 * RCA 2026-08-16 (run 31927810430, k8s backup FAIL 55s): the scale step's
 * vertical resize rebooted every node; verify-scale passed on app health 3s
 * later; backup was triggered ~30s after the nodes came back, while the
 * apiserver→kubelet exec path (k3s agent tunnels) was still converging. The
 * Job's container — whose first act is `kubectl exec` into the db pod — failed
 * fast, hit backoffLimit, Failed=True. Pod-Ready and API healthz (what scale
 * verifies) do not prove the exec transport; only an exec round-trip does.
 * `pg_isready` through that exec proves BOTH halves at once: transport up and
 * database accepting. Same condition-not-timer shape as the deploy path's
 * awaitPostgresAccepting (mitigation-audit cluster 5), reused here.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/cli/progress.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/cli/progress.js')>(
    '../../../src/lib/cli/progress.js',
  );
  return { ...actual, progressLog: vi.fn() };
});

const modulePromise = import('../../../src/backup.js');

type KubectlCall = string[];

describe('triggerBackupJob exec+pg condition gate', () => {
  it('polls the exec round-trip until pg_isready succeeds, THEN creates the Job', async () => {
    const { triggerBackupJob } = await modulePromise;
    const calls: KubectlCall[] = [];
    let readyAttempts = 0;
    const kubectlImpl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      calls.push(argv);
      if (argv.includes('pg_isready')) {
        readyAttempts++;
        // Two failures model the post-reboot exec-path window, then it holds.
        if (readyAttempts < 3) {
          throw new Error('error: unable to upgrade connection: pod does not exist');
        }
        return 'accepting connections';
      }
      return '';
    });
    const runScriptImpl = vi.fn(async () => 'JOB_RESULT=complete');

    const jobName = await triggerBackupJob('1.2.3.4', '/tmp/key', {
      kubectlImpl,
      runScriptImpl,
      sleep: async () => {},
    });

    expect(jobName).toMatch(/^backup-manual-/);
    expect(readyAttempts).toBe(3);

    // The gate must EXEC into the db workload (proving the apiserver→kubelet
    // transport the Job's own `kubectl exec` will use), not merely query the
    // apiserver.
    const probeArgv = calls[0];
    expect(probeArgv).toContain('exec');
    expect(probeArgv.join(' ')).toContain('statefulset/supabase-supabase-db');

    // Job creation happens strictly AFTER the condition held.
    const createIdx = calls.findIndex((a) => a[0] === 'create' && a[1] === 'job');
    const lastProbeIdx = calls.map((a) => a.includes('pg_isready')).lastIndexOf(true);
    expect(createIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(lastProbeIdx);
    expect(runScriptImpl).toHaveBeenCalledTimes(1);
  });

  it('fails loud with the last real error on budget exhaustion — and never creates the Job', async () => {
    const { triggerBackupJob } = await modulePromise;
    const kubectlImpl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv.includes('pg_isready')) {
        throw new Error('error: unable to upgrade connection: pod does not exist');
      }
      return '';
    });
    const runScriptImpl = vi.fn(async () => 'JOB_RESULT=complete');
    // Each nowFn call advances a minute, so the default budget exhausts after
    // a single failed probe instead of the test sleeping.
    let t = 0;
    const nowFn = () => (t += 61_000);

    await expect(
      triggerBackupJob('1.2.3.4', '/tmp/key', {
        kubectlImpl,
        runScriptImpl,
        sleep: async () => {},
        nowFn,
      }),
    ).rejects.toThrow(/unable to upgrade connection/);

    // No Job was created on the unproven cluster.
    expect(kubectlImpl.mock.calls.every((c) => (c[2] as string[]).includes('pg_isready'))).toBe(
      true,
    );
    expect(runScriptImpl).not.toHaveBeenCalled();
  });
});
