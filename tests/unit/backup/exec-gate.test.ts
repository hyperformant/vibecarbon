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
      if (argv[0] === 'logs') return 'BACKUP_RESULT=pushed:base_000000010000000000000004';
      return '';
    });
    const runScriptImpl = vi.fn(async () => 'JOB_RESULT=complete');

    const backup = await triggerBackupJob('1.2.3.4', '/tmp/key', {
      kubectlImpl,
      runScriptImpl,
      sleep: async () => {},
    });

    // The outcome is read from the completed Job's logs.
    expect(backup).toEqual({
      result: 'pushed',
      name: 'base_000000010000000000000004',
      job: expect.stringMatching(/^backup-manual-/),
    });
    expect(calls.at(-1)).toEqual([
      'logs',
      '-n',
      'vibecarbon',
      '-l',
      `job-name=${backup.job}`,
      '--tail=-1',
    ]);
    expect(readyAttempts).toBe(3);

    // The gate must EXEC into the db workload (proving the apiserver→kubelet
    // transport the Job's own `kubectl exec` will use), not merely query the
    // apiserver.
    const probeArgv = calls[0];
    expect(probeArgv).toContain('exec');
    expect(probeArgv.join(' ')).toContain('statefulset/db');

    // Job creation happens strictly AFTER the condition held.
    const createIdx = calls.findIndex((a) => a[0] === 'create' && a[1] === 'job');
    const lastProbeIdx = calls.map((a) => a.includes('pg_isready')).lastIndexOf(true);
    expect(createIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(lastProbeIdx);
    expect(runScriptImpl).toHaveBeenCalledTimes(1);
  });

  it('a Job that failed after printing a pushed marker returns pushed with the cause', async () => {
    const { triggerBackupJob } = await modulePromise;
    const kubectlImpl = vi.fn(async (_ip: string, _key: string, argv: string[]) =>
      argv.includes('pg_isready') ? 'accepting connections' : '',
    );
    const waitErr = Object.assign(new Error('Command failed: ssh ... bash /tmp/vb-script.sh'), {
      stdout:
        'JOB_RESULT=failed\n=== current container logs ===\nBACKUP_RESULT=pushed:base_000000010000000000000009\n' +
        'retention failed after pushing base_000000010000000000000009: ERROR: AccessDenied\n',
    });
    const runScriptImpl = vi
      .fn()
      .mockRejectedValueOnce(waitErr)
      .mockResolvedValueOnce('(diagnostics)');
    const backup = await triggerBackupJob('1.2.3.4', '/tmp/key', {
      kubectlImpl,
      runScriptImpl,
      sleep: async () => {},
    });
    expect(backup).toMatchObject({ result: 'pushed', name: 'base_000000010000000000000009' });
    expect(backup.retentionError).toContain(
      'retention failed after pushing base_000000010000000000000009: ERROR: AccessDenied',
    );
  });

  it('a Job that failed with no pushed marker throws with the diagnostics', async () => {
    const { triggerBackupJob } = await modulePromise;
    const kubectlImpl = vi.fn(async () => 'accepting connections');
    const runScriptImpl = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('wait failed'), { stdout: 'JOB_RESULT=failed' }),
      )
      .mockResolvedValueOnce('pod crashed');
    await expect(
      triggerBackupJob('1.2.3.4', '/tmp/key', {
        kubectlImpl,
        runScriptImpl,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/did not complete:\npod crashed/);
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
