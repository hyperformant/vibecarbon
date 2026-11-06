/**
 * A hung pod call costs its bound, never the deploy's whole wait.
 *
 * Proved against a silent process, not by the option's presence: `kubectl`
 * here is a real child that never answers on the attempts a test names, the
 * real runner kills it, and the real loop has to carry on. The seam shortens
 * the bound so the test does not wait for it, and records the bound the
 * production call asked for.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triggerBackupJob } from '../../../src/backup.js';
import { runCommandAsync } from '../../../src/lib/command.js';
import {
  POD_EXEC_PROBE_MS,
  POD_EXEC_QUERY_MS,
  POD_EXEC_WRITE_MS,
} from '../../../src/lib/deploy/db-workload.js';
import { withRegistryRelay } from '../../../src/lib/deploy/k8s/ha/index.js';
import { runKubectlWithRetry } from '../../../src/lib/deploy/k8s/k3s.js';
import {
  awaitAppAdminReady,
  awaitDbPodReady,
  awaitPostgresAccepting,
  awaitPostgresPromoted,
  watchAppMigrationFailure,
} from '../../../src/lib/deploy/k8s/readiness.js';
import { WALG_AUDIT_PROBE_TIMEOUT_MS } from '../../../src/lib/deploy/walg-audit.js';
import { verifyPostgres } from '../../../src/restore.js';

const ROOT = join(__dirname, '../../..');
const KILL_AFTER_MS = 150;

let dir: string;
let env: NodeJS.ProcessEnv;

/**
 * A `kubectl` that hangs on the attempts in `hangOn` (1-based) and otherwise
 * prints `out` and exits `code`. `exec sleep` so the kill lands on the process
 * holding stdout: a real kubectl has no child to keep the pipe open.
 */
function fakeKubectl({
  hangOn = [1],
  out = '',
  code = 0,
}: {
  hangOn?: number[];
  out?: string;
  code?: number;
} = {}) {
  const count = join(dir, 'count');
  const script = [
    '#!/bin/sh',
    `n=$(($(cat ${count} 2>/dev/null || echo 0) + 1))`,
    `echo "$n" > ${count}`,
    `case " ${hangOn.join(' ')} " in *" $n "*) exec sleep 60 ;; esac`,
    `printf '%s' ${JSON.stringify(out)}`,
    `exit ${code}`,
  ].join('\n');
  const bin = join(dir, 'kubectl');
  writeFileSync(bin, `${script}\n`);
  chmodSync(bin, 0o755);
  return { attempts: () => Number(readFileSync(count, 'utf-8').trim()) };
}

/** The production call's `exec`, with the bound shortened and the asked-for one kept. */
function boundedExec() {
  const asked: Array<number | undefined> = [];
  const exec = (argv: string[], opts: { timeout?: number }) => {
    asked.push(opts?.timeout);
    return runCommandAsync(argv, { ...opts, env, silent: true, timeout: KILL_AFTER_MS });
  };
  return { asked, exec };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-pod-exec-'));
  mkdirSync(dir, { recursive: true });
  env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const noSleep = async () => {};

describe('the runner', () => {
  it('kills a silent child at its timeout and says it timed out', async () => {
    fakeKubectl({ hangOn: [1] });
    const started = Date.now();
    const err = await runCommandAsync(['kubectl', 'exec', 'db-0'], {
      env,
      silent: true,
      timeout: KILL_AFTER_MS,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('runKubectlWithRetry bounds one attempt and does not turn a hang into a retry', async () => {
    const stub = fakeKubectl({ hangOn: [1, 2, 3] });
    const started = Date.now();
    await expect(
      runKubectlWithRetry(['-n', 'x', 'exec', 'db-0', '--', 'ls'], {
        env,
        timeout: KILL_AFTER_MS,
        description: 'test',
      }),
    ).rejects.toThrow(/test failed/);
    expect(stub.attempts()).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('a loop treats a hung attempt as a failed one, and carries on', () => {
  it('awaitPostgresAccepting', async () => {
    const stub = fakeKubectl();
    const { asked, exec } = boundedExec();
    await awaitPostgresAccepting({ env, dbPod: 'db-0', exec, sleep: noSleep });
    expect(stub.attempts()).toBe(2);
    expect(asked).toEqual([POD_EXEC_PROBE_MS, POD_EXEC_PROBE_MS]);
  });

  it('awaitPostgresPromoted', async () => {
    const stub = fakeKubectl({ out: 'f' });
    const { asked, exec } = boundedExec();
    await awaitPostgresPromoted({ env, dbPod: 'db-0', dbContainer: 'db', exec, sleep: noSleep });
    expect(stub.attempts()).toBe(2);
    expect(asked).toEqual([POD_EXEC_QUERY_MS, POD_EXEC_QUERY_MS]);
  });

  it('awaitAppAdminReady', async () => {
    const stub = fakeKubectl();
    const { asked, exec } = boundedExec();
    await awaitAppAdminReady({ env, exec, sleep: noSleep });
    expect(stub.attempts()).toBe(2);
    expect(asked).toEqual([POD_EXEC_QUERY_MS, POD_EXEC_QUERY_MS]);
  });

  it('watchAppMigrationFailure keeps watching past a hung probe', async () => {
    const rs = {
      metadata: {
        annotations: { 'deployment.kubernetes.io/revision': '1' },
        labels: { 'pod-template-hash': 'abc' },
      },
    };
    const pod = { metadata: { name: 'app-1' }, status: {} };
    const controller = new AbortController();
    const asked: Array<number | undefined> = [];
    const exec = vi.fn(async (argv: string[], opts: { timeout?: number }) => {
      if (argv.includes('get')) {
        return JSON.stringify({ items: argv.includes('replicasets') ? [rs] : [pod] });
      }
      asked.push(opts?.timeout);
      if (asked.length === 1) throw Object.assign(new Error('timed out'), { timedOut: true });
      controller.abort();
      return '';
    });
    await watchAppMigrationFailure({ env, signal: controller.signal, exec, sleep: noSleep });
    expect(asked).toEqual([POD_EXEC_QUERY_MS, POD_EXEC_QUERY_MS]);
  });

  it('restore: verifyPostgres over ssh asks for the probe bound and loops past a failure', async () => {
    const opts: unknown[] = [];
    let n = 0;
    await verifyPostgres('1.1.1.1', '/k', {
      getPod: async () => 'db-0',
      sleep: noSleep,
      exec: async (_ip: string, _key: string, _argv: string[], o: unknown) => {
        opts.push(o);
        n += 1;
        if (n === 1) throw new Error('timed out');
        return '';
      },
    });
    expect(opts).toEqual([{ timeout: POD_EXEC_PROBE_MS }, { timeout: POD_EXEC_PROBE_MS }]);
  });
});

describe('the backup trigger', () => {
  it('passes the probe bound through its ssh seam, which would otherwise default to 120 s', async () => {
    const calls: Array<{ argv: string[]; timeout?: number }> = [];
    const kubectlImpl = vi.fn(
      async (_ip: string, _key: string, argv: string[], o: { timeout?: number }) => {
        calls.push({ argv, timeout: o?.timeout });
        return argv[0] === 'logs' ? 'BACKUP_RESULT=pushed:base_1' : '';
      },
    );
    await triggerBackupJob('1.2.3.4', '/k', {
      kubectlImpl,
      runScriptImpl: vi.fn(async () => 'JOB_RESULT=complete'),
      sleep: noSleep,
    });
    expect(calls.find((c) => c.argv.includes('pg_isready'))?.timeout).toBe(POD_EXEC_PROBE_MS);
    expect(calls.find((c) => c.argv[0] === 'logs')?.timeout).toBe(POD_EXEC_WRITE_MS);
  });
});

describe('a warm deploy reads readiness from the API', () => {
  const pod = (ready: string) =>
    JSON.stringify({ status: { conditions: [{ type: 'Ready', status: ready }] } });

  it('awaitDbPodReady never reaches the pod', async () => {
    const seen: string[][] = [];
    const exec = vi.fn(async (argv: string[]) => {
      seen.push(argv);
      return pod('True');
    });
    await awaitDbPodReady({ env, exec, sleep: noSleep });
    expect(seen).toEqual([['kubectl', '-n', 'vibecarbon', 'get', 'pod', 'db-0', '-o', 'json']]);
  });

  it('it waits for Ready, and a hung API read is a failed attempt', async () => {
    const answers = [
      () => {
        throw new Error('timed out');
      },
      () => pod('False'),
      () => 'not json',
      () => pod('True'),
    ];
    const exec = vi.fn(async () => (answers.shift() as () => string)());
    await awaitDbPodReady({ env, exec, sleep: noSleep });
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('it gives up at its budget, naming the pod', async () => {
    let t = 0;
    await expect(
      awaitDbPodReady({
        env,
        exec: async () => pod('False'),
        sleep: async () => {
          t += 1_000;
        },
        nowFn: () => t,
        budgetMs: 3_000,
      }),
    ).rejects.toThrow(/db-0/);
  });

  it('every API read is bounded', async () => {
    const exec = vi.fn(async (_a: string[], _o: { timeout?: number }) => pod('True'));
    await awaitDbPodReady({ env, exec, sleep: noSleep });
    expect(exec.mock.calls[0][1].timeout).toBeGreaterThan(0);
  });

  const deploy = () => {
    const src = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    return src.slice(src.indexOf('async function deployK3sSteps('));
  };

  it('a skipped apply waits on the API, not on an exec', () => {
    const body = deploy();
    const skip = body.slice(body.indexOf('if (skipApply) {'), body.indexOf('writeDeployWalgRole('));
    expect(skip).toContain('awaitDbPodReady(');
    expect(skip).not.toContain('awaitPostgresAccepting(');
  });

  it('a standby does not exec the audit: it would only read the role this deploy just proved', () => {
    expect(deploy()).toMatch(
      /if \(options\.s3Config\?\.accessKey && options\.role !== 'standby'\) \{\s*await perfAsync\(`deploy\.\$\{perfPrefix\}\.verifyWalgBackups`/,
    );
  });
});

describe('the registry relay', () => {
  it('asks a relay that never got Ready for its logs under the query bound', async () => {
    const calls: Array<{ script: string; timeout?: number }> = [];
    const run = async (_ip: string, script: string, _input?: string, timeout?: number) => {
      calls.push({ script, timeout });
      if (script.includes('kubectl wait')) throw new Error('timed out waiting');
      return '';
    };
    await expect(
      withRegistryRelay(
        {
          primaryIp: '192.0.2.1',
          standbyIp: '192.0.2.2',
          primaryMasterPrivateIp: '10.0.0.1',
          sshKeyPath: '/key',
          run,
        },
        async () => 'unreached',
      ),
    ).rejects.toThrow(/registry relay not ready/);
    expect(calls.find((c) => c.script.startsWith('kubectl logs'))?.timeout).toBe(POD_EXEC_QUERY_MS);
  });
});

describe('the bounds', () => {
  it('fit the slowest real run of what they cover, and stay short', () => {
    // Slowest real runs in perf_substep, k8s modes on DigitalOcean and Hetzner:
    // auditRls 1.5 s, awaitAdminReady 1.8 s, primaryInit 4.9 s, replication.hba
    // 1.2 s, the wal-g audit 9.3 s when it did not hang. The one that hung was
    // killed at the old 120 s bound and its retry answered in under a second.
    expect(POD_EXEC_PROBE_MS).toBe(10_000);
    expect(POD_EXEC_QUERY_MS).toBe(15_000);
    expect(POD_EXEC_WRITE_MS).toBe(30_000);
    expect(WALG_AUDIT_PROBE_TIMEOUT_MS).toBe(30_000);
  });
});
