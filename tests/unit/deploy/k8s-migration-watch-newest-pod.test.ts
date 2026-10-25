/**
 * Final review M3: the k8s migration watch probed `deploy/app`, and during a
 * rolling update kubectl may pick an OLD-ReplicaSet pod, which reports the
 * migrations it applied long ago. A failed migration on the new pod then
 * surfaced only at the rollout's 10-min timeout. The watch now probes the
 * newest pod of the Deployment's current ReplicaSet (highest revision).
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_PROBE_EXIT } from '../../../src/lib/deploy/admin-ready.js';
import {
  APP_POD_SELECTOR,
  failedMigrateExitCode,
  newestAppPod,
  watchAppMigrationFailure,
} from '../../../src/lib/deploy/k8s/readiness.js';

const rs = (revision: number, hash: string) => ({
  metadata: {
    name: `app-${hash}`,
    annotations: { 'deployment.kubernetes.io/revision': String(revision) },
    labels: { app: 'vibecarbon-app', 'pod-template-hash': hash },
  },
});
const pod = (name: string, hash: string, created: string, extra: object = {}) => ({
  metadata: {
    name,
    creationTimestamp: created,
    labels: { app: 'vibecarbon-app', 'pod-template-hash': hash },
    ...extra,
  },
});

/** A fake kubectl: get replicasets / get pods answer JSON, exec answers per pod. */
function cluster({
  sets,
  pods,
  execExit,
}: {
  sets: object[];
  pods: Array<ReturnType<typeof pod>>;
  execExit: Record<string, number>;
}) {
  const calls: string[][] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv);
    if (argv.includes('get') && argv.includes('replicasets')) {
      return JSON.stringify({ items: sets });
    }
    if (argv.includes('get') && argv.includes('pods')) {
      const selector = argv[argv.indexOf('-l') + 1];
      const hash = /pod-template-hash=(\S+)/.exec(selector)?.[1];
      return JSON.stringify({
        items: pods.filter((p) => p.metadata.labels['pod-template-hash'] === hash),
      });
    }
    if (argv.includes('exec')) {
      const target = argv[argv.indexOf('exec') + 1];
      const code = execExit[target] ?? 0;
      if (code !== 0) throw Object.assign(new Error(`exit ${code}`), { status: code });
      return '';
    }
    if (argv.includes('logs')) return `logs of ${argv[argv.indexOf('logs') + 1]}`;
    return '';
  };
  return { exec, calls };
}

describe('newestAppPod', () => {
  it('picks the highest-revision ReplicaSet, then its newest live pod', async () => {
    const { exec, calls } = cluster({
      sets: [rs(3, 'old'), rs(4, 'new'), rs(2, 'older')],
      pods: [
        pod('app-old-1', 'old', '2026-10-16T05:00:00Z'),
        pod('app-new-1', 'new', '2026-10-16T05:10:00Z'),
        pod('app-new-2', 'new', '2026-10-16T05:11:00Z'),
        pod('app-new-3', 'new', '2026-10-16T05:12:00Z', { deletionTimestamp: 'x' }),
      ],
      execExit: {},
    });
    expect(await newestAppPod({ env: {}, namespace: 'vibecarbon', exec })).toBe('app-new-2');
    expect(calls[0]).toEqual([
      'kubectl',
      '-n',
      'vibecarbon',
      'get',
      'replicasets',
      '-l',
      APP_POD_SELECTOR,
      '-o',
      'json',
    ]);
    expect(calls[1]).toContain(`${APP_POD_SELECTOR},pod-template-hash=new`);
  });

  it('null while the current ReplicaSet has no pod yet', async () => {
    const { exec } = cluster({ sets: [rs(1, 'a')], pods: [], execExit: {} });
    expect(await newestAppPod({ env: {}, namespace: 'vibecarbon', exec })).toBeNull();
  });

  it('null when no ReplicaSet exists', async () => {
    const { exec } = cluster({ sets: [], pods: [], execExit: {} });
    expect(await newestAppPod({ env: {}, namespace: 'vibecarbon', exec })).toBeNull();
  });
});

describe('watchAppMigrationFailure probes the rollout pod, not deploy/app', () => {
  it('rejects on the NEW pod failing even while an old pod reports applied', async () => {
    const { exec, calls } = cluster({
      sets: [rs(1, 'old'), rs(2, 'new')],
      pods: [
        pod('app-old-1', 'old', '2026-10-16T05:00:00Z'),
        pod('app-new-1', 'new', '2026-10-16T05:10:00Z'),
      ],
      execExit: { 'pod/app-new-1': ADMIN_PROBE_EXIT.MIGRATIONS_FAILED },
    });
    const controller = new AbortController();
    await expect(
      watchAppMigrationFailure({
        env: {},
        signal: controller.signal,
        exec,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/pod app-new-1[\s\S]*logs of pod\/app-new-1/);
    expect(calls.some((a) => a.includes('deploy/app'))).toBe(false);
    expect(calls.some((a) => a.includes('pod/app-old-1'))).toBe(false);
  });

  it('keeps watching while the new pod is pending, and stops on abort', async () => {
    const { exec, calls } = cluster({
      sets: [rs(2, 'new')],
      pods: [pod('app-new-1', 'new', '2026-10-16T05:10:00Z')],
      execExit: { 'pod/app-new-1': ADMIN_PROBE_EXIT.MIGRATIONS_PENDING },
    });
    const controller = new AbortController();
    let polls = 0;
    await watchAppMigrationFailure({
      env: {},
      signal: controller.signal,
      exec,
      sleep: async () => {
        polls += 1;
        if (polls === 3) controller.abort();
      },
    });
    expect(calls.filter((a) => a.includes('pod/app-new-1') && a.includes('exec'))).toHaveLength(3);
  });

  it("rejects at once when the new pod's migrate init container exited non-zero", async () => {
    const failing = pod('app-new-1', 'new', '2026-10-16T05:10:00Z');
    Object.assign(failing, {
      status: {
        initContainerStatuses: [
          {
            name: 'migrate',
            state: { waiting: { reason: 'CrashLoopBackOff' } },
            lastState: { terminated: { exitCode: 1 } },
          },
        ],
      },
    });
    const { exec, calls } = cluster({
      sets: [rs(2, 'new')],
      pods: [failing],
      execExit: {},
    });
    const controller = new AbortController();
    await expect(
      watchAppMigrationFailure({
        env: {},
        signal: controller.signal,
        exec,
        sleep: async () => {},
      }),
    ).rejects.toThrow(
      /migrate init container exited 1 \(pod app-new-1\)[\s\S]*logs of pod\/app-new-1/,
    );
    const logs = calls.find((a) => a.includes('logs'));
    expect(logs).toEqual(expect.arrayContaining(['-c', 'migrate', '--previous']));
    // The app container never ran, so it is never probed.
    expect(calls.some((a) => a.includes('exec'))).toBe(false);
  });

  it('a migrate init container that is still running or exited 0 is not a failure', () => {
    const running = {
      status: { initContainerStatuses: [{ name: 'migrate', state: { running: {} } }] },
    };
    const done = {
      status: {
        initContainerStatuses: [{ name: 'migrate', state: { terminated: { exitCode: 0 } } }],
      },
    };
    expect(failedMigrateExitCode(running)).toBeNull();
    expect(failedMigrateExitCode(done)).toBeNull();
    expect(failedMigrateExitCode(null)).toBeNull();
  });

  it('a failing ReplicaSet lookup is "no pod yet", never a migration failure', async () => {
    const controller = new AbortController();
    let polls = 0;
    const exec = async () => {
      throw Object.assign(new Error('boom'), { status: ADMIN_PROBE_EXIT.MIGRATIONS_FAILED });
    };
    await expect(
      watchAppMigrationFailure({
        env: {},
        signal: controller.signal,
        exec,
        sleep: async () => {
          polls += 1;
          if (polls === 2) controller.abort();
        },
      }),
    ).resolves.toBeUndefined();
  });
});
