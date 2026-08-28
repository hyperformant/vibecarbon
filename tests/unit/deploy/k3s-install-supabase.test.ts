/**
 * installSupabase — chart-version pin + fail-loud on helm failure.
 *
 * Live RCA (CI matrix run 29348429215, 2026-07-14): supabase-community
 * published chart 0.7.1 at 11:42 UTC with a breaking values schema
 * (environment.* switched from maps to lists of {name,value}). The deploy
 * installed the chart UNPINNED, so every fresh k8s/k8s-ha deploy that
 * afternoon picked up 0.7.1 and helm exited 1 in ~1.5s ("supabase.env.render
 * at <.name>: can't evaluate field name"). Two defects:
 *
 *   1. No `--version` pin — a values file is schema-coupled to a chart
 *      version; floating the chart guarantees overnight breakage.
 *   2. The helm failure DIDN'T fail the deploy: runCommandAsync resolves
 *      `false` (instead of rejecting) for non-silent callers, and
 *      installSupabase never checked the result — the deploy marched on and
 *      died 3 steps later with a misleading "pods supabase-supabase-db-0 not
 *      found" at WAL-archiving setup.
 *
 * Mocking strategy mirrors k3s-apply-manifests-ordering.test.ts: every
 * shell-out reaches node's `spawn` (helm via command.js runCommandAsync), so
 * mocking spawn drives the function; fs and command.js stay real. The temp
 * projectDir carries the values template installSupabase renders.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const k3sPromise = import('../../../src/lib/deploy/k8s/k3s.js');

let cmdCalls: string[][] = [];
let helmUpgradeExit = { code: 0, stderr: '' };
/**
 * What `kubectl get pods -l app.kubernetes.io/instance=supabase` reports.
 * `null` models kubectl itself failing (exit 1), which the failure path has to
 * survive without swallowing the helm error it was trying to explain.
 */
let supabasePodsOutput: string | null = '';
// installSupabase deletes its rendered values tmp file (and any standby
// overlay tmp file) in a `finally` once `helm upgrade` exits — by the time
// `await installSupabase(...)` resolves in the test, those files are already
// gone. Snapshot `-f` file contents synchronously at spawn-time (the files
// are still on disk then; cleanup only runs after the mocked child's async
// 'exit' event fires) so assertions can inspect content post-hoc.
let helmFileSnapshots: Record<string, string> = {};

function fakeChild({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const child: Record<string, unknown> = {
    stdout: {
      on(ev: string, cb: (chunk: unknown) => void) {
        if (ev === 'data' && stdout) Promise.resolve().then(() => cb(Buffer.from(stdout)));
      },
    },
    stderr: {
      on(ev: string, cb: (chunk: unknown) => void) {
        if (ev === 'data' && stderr) Promise.resolve().then(() => cb(Buffer.from(stderr)));
      },
    },
    stdin: { write() {}, end() {} },
    kill() {},
    unref() {},
    on(ev: string, cb: (...a: unknown[]) => void) {
      if (ev === 'exit' || ev === 'close') Promise.resolve().then(() => cb(exitCode));
      return child;
    },
  };
  return child;
}

function installSpawnMock() {
  vi.mocked(spawn).mockImplementation(((cmd: string, args: string[] = []) => {
    cmdCalls.push([cmd, ...(args ?? [])]);
    if (cmd === 'helm' && (args ?? [])[0] === 'upgrade') {
      (args ?? []).forEach((a, i) => {
        if (a === '-f') {
          const path = (args ?? [])[i + 1];
          try {
            helmFileSnapshots[path] = readFileSync(path, 'utf-8');
          } catch {
            // best-effort snapshot
          }
        }
      });
      return fakeChild({
        exitCode: helmUpgradeExit.code,
        stderr: helmUpgradeExit.stderr,
      }) as unknown as ReturnType<typeof spawn>;
    }
    // The pod listing behind both the post-wait snapshot and the
    // helm-failure explanation.
    if (cmd === 'kubectl' && (args ?? []).includes('pods')) {
      return (supabasePodsOutput === null
        ? fakeChild({
            exitCode: 1,
            stderr: 'error: the server could not find the requested resource',
          })
        : fakeChild({ stdout: supabasePodsOutput })) as unknown as ReturnType<typeof spawn>;
    }
    return fakeChild() as unknown as ReturnType<typeof spawn>;
  }) as typeof spawn);
}

function makeProjectDir({ withStandbyOverlay = false } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'k3s-install-supabase-'));
  mkdirSync(join(dir, 'k8s/values'), { recursive: true });
  writeFileSync(
    join(dir, 'k8s/values/supabase.values.yaml'),
    'secret:\n  dashboard:\n    username: {{ADMIN_EMAIL}}\n    password: {{ADMIN_PASSWORD}}\ndomain: {{DOMAIN}}\n',
  );
  if (withStandbyOverlay) {
    // Mirrors carbon/k8s/values/supabase.standby.values.yaml's shape (Task
    // 2): scalar replicaCount keys only, no {{PLACEHOLDER}} tokens.
    writeFileSync(
      join(dir, 'k8s/values/supabase.standby.values.yaml'),
      'deployment:\n  auth:\n    replicaCount: 0\n  kong:\n    replicaCount: 0\n',
    );
  }
  return dir;
}

const baseArgs = {
  kubeconfig: '/tmp/fake-kubeconfig',
  projectName: 'testproj',
  domain: 'test.example.com',
  dbImageTag: 'ghcr.io/test/postgres:17-walg1',
  // Required since the storage-class pin — installSupabase refuses to let the
  // chart inherit the cluster default. See k3s-supabase-storage-class.test.ts.
  storageClass: 'hcloud-volumes',
  // Required since the d4 lift — installSupabase refuses to assume the
  // Hetzner-static relay host. See supabase-private-ip-required.test.ts.
  supabasePrivateIp: '10.0.1.2',
};

async function runInstall(overrides: Record<string, unknown> = {}) {
  const { installSupabase } = await k3sPromise;
  return installSupabase({
    ...baseArgs,
    projectDir: makeProjectDir({ withStandbyOverlay: overrides.role === 'standby' }),
    ...overrides,
  });
}

beforeEach(() => {
  cmdCalls = [];
  helmUpgradeExit = { code: 0, stderr: '' };
  helmFileSnapshots = {};
  supabasePodsOutput = '';
  installSpawnMock();
});

describe('installSupabase', () => {
  it('pins the chart with an explicit --version', async () => {
    await runInstall();
    const helmUpgrade = cmdCalls.find(([cmd, sub]) => cmd === 'helm' && sub === 'upgrade');
    expect(helmUpgrade).toBeDefined();
    const versionIdx = helmUpgrade?.indexOf('--version') ?? -1;
    expect(versionIdx).toBeGreaterThan(-1);
    // A concrete semver, not a range — ranges re-open the floating-chart hole.
    expect(helmUpgrade?.[versionIdx + 1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('throws when helm upgrade exits non-zero (no silent march to WAL setup)', async () => {
    helmUpgradeExit = { code: 1, stderr: '' };
    await expect(runInstall()).rejects.toThrow(/helm/i);
  });

  it('resolves when helm succeeds', async () => {
    await expect(runInstall()).resolves.not.toThrow();
  });

  it('standby role appends the zero overlay as a second -f', async () => {
    await runInstall({ role: 'standby', walgRole: 'standby' });
    const helmUpgrade = cmdCalls.find(([cmd, sub]) => cmd === 'helm' && sub === 'upgrade');
    expect(helmUpgrade).toBeDefined();
    const fIdx = helmUpgrade?.flatMap((a, i) => (a === '-f' ? [i] : [])) ?? [];
    expect(fIdx).toHaveLength(2);
    const overlayContent = helmFileSnapshots[helmUpgrade?.[fIdx[1] + 1] ?? ''];
    expect(overlayContent).toContain('replicaCount: 0');
    expect(overlayContent).not.toMatch(/\{\{/);
  });

  it('primary/single role keeps a single -f (no standby overlay)', async () => {
    await runInstall({ role: 'primary', walgRole: 'primary' });
    const helmUpgrade = cmdCalls.find(([cmd, sub]) => cmd === 'helm' && sub === 'upgrade');
    expect(helmUpgrade).toBeDefined();
    expect(helmUpgrade?.filter((a) => a === '-f')).toHaveLength(1);
  });
});

/**
 * `helm upgrade --install --wait` exits non-zero for two very different
 * reasons, and the failure message used to assert the wrong one
 * unconditionally: "No Supabase pods were installed."
 *
 *   - The chart never rendered / never applied (the 2026-07-14 schema break
 *     above): genuinely zero pods, and the old wording was right.
 *   - `--wait` TIMED OUT: the release IS installed and its pods exist, some of
 *     them Ready. Observed on a fresh k8s-ha rig, 2026-08-05: 6 Running, 3
 *     Pending — while the error told the operator nothing had been installed,
 *     which points RCA at helm/the chart instead of at the three pods that
 *     could not schedule (there, a CSI node plugin that never registered).
 *
 * So the message now READS the release's pods after helm fails and reports
 * what is actually there. Still exactly one loud error — the per-pod detail
 * beyond names and phases is already captured by the #221 diagnostics.
 */
describe('installSupabase helm-failure message truthfulness', () => {
  it('names the not-ready pods and their phases when --wait timed out on a live release', async () => {
    helmUpgradeExit = { code: 1, stderr: 'Error: context deadline exceeded' };
    supabasePodsOutput = [
      'supabase-supabase-db-0        Running   True',
      'supabase-supabase-auth-abc    Running   True',
      'supabase-supabase-rest-def    Running   True',
      'supabase-supabase-kong-ghi    Running   True',
      'supabase-supabase-meta-jkl    Running   True',
      'supabase-supabase-studio-mno  Running   True',
      'supabase-supabase-storage-pqr Pending   <none>',
      'supabase-supabase-realtime-st Pending   <none>',
      'supabase-supabase-imgproxy-uv Pending   <none>',
      '',
    ].join('\n');

    const err = await runInstall().catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    // The false claim is gone.
    expect(msg).not.toMatch(/No Supabase pods were installed/);
    // What actually happened, with the counts.
    expect(msg).toMatch(/6\/9/);
    // The pods that held it up, named, with their phase.
    expect(msg).toMatch(/supabase-supabase-storage-pqr \(Pending\)/);
    expect(msg).toMatch(/supabase-supabase-realtime-st \(Pending\)/);
    expect(msg).toMatch(/supabase-supabase-imgproxy-uv \(Pending\)/);
    // A Ready pod is not named — the message is about what is holding it up.
    expect(msg).not.toMatch(/supabase-supabase-db-0/);
    // Still one loud error that identifies the release and chart.
    expect(msg).toMatch(/helm upgrade --install failed/);
  });

  it('a Running-but-not-Ready pod counts as not ready (--wait gates on Ready, not phase)', async () => {
    helmUpgradeExit = { code: 1, stderr: '' };
    supabasePodsOutput = [
      'supabase-supabase-db-0     Running   True',
      'supabase-supabase-auth-abc Running   False',
      '',
    ].join('\n');

    const err = await runInstall().catch((e: Error) => e);

    const msg = (err as Error).message;
    expect(msg).toMatch(/1\/2/);
    expect(msg).toMatch(/supabase-supabase-auth-abc \(Running\)/);
  });

  it('still says so when the release genuinely produced zero pods', async () => {
    helmUpgradeExit = { code: 1, stderr: "Error: values don't meet the specifications" };
    supabasePodsOutput = '';

    const err = await runInstall().catch((e: Error) => e);

    const msg = (err as Error).message;
    expect(msg).toMatch(/No Supabase pods/);
    expect(msg).toMatch(/helm upgrade --install failed/);
  });

  it('reports that every pod is Ready rather than inventing a pod-side cause', async () => {
    // helm can fail a post-install hook, or lose its release lock, with the
    // workload perfectly healthy. Claiming a pod problem here would be the
    // same class of lie in the other direction.
    helmUpgradeExit = { code: 1, stderr: 'Error: release supabase failed' };
    supabasePodsOutput = ['supabase-supabase-db-0 Running True', ''].join('\n');

    const err = await runInstall().catch((e: Error) => e);

    const msg = (err as Error).message;
    expect(msg).toMatch(/All 1 Supabase pods? (is|are) Ready/);
    expect(msg).not.toMatch(/No Supabase pods/);
  });

  it('survives kubectl itself failing without swallowing the helm error', async () => {
    helmUpgradeExit = { code: 1, stderr: '' };
    supabasePodsOutput = null; // the pod listing exits non-zero

    const err = await runInstall().catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/helm upgrade --install failed/);
    expect(msg).toMatch(/could not list/i);
    // Never asserts a pod state it failed to read.
    expect(msg).not.toMatch(/No Supabase pods/);
  });

  it('scopes the listing to the release, not the whole namespace', async () => {
    helmUpgradeExit = { code: 1, stderr: '' };

    await runInstall().catch(() => {});

    const podGets = cmdCalls.filter(([cmd, ...rest]) => cmd === 'kubectl' && rest.includes('pods'));
    expect(podGets.length).toBeGreaterThan(0);
    for (const call of podGets) {
      expect(call).toContain('app.kubernetes.io/instance=supabase');
      expect(call).toContain('vibecarbon');
    }
  });
});

describe('summarizeSupabasePods', () => {
  it('returns the zero-pod wording for empty and whitespace-only output', async () => {
    const { summarizeSupabasePods } = await k3sPromise;
    expect(summarizeSupabasePods('')).toMatch(/No Supabase pods/);
    expect(summarizeSupabasePods('   \n  \n')).toMatch(/No Supabase pods/);
    expect(summarizeSupabasePods(undefined as unknown as string)).toMatch(/No Supabase pods/);
  });

  it('treats any READY value other than True as not ready', async () => {
    const { summarizeSupabasePods } = await k3sPromise;
    const out = summarizeSupabasePods(
      ['a Pending <none>', 'b Running False', 'c Succeeded True'].join('\n'),
    );
    expect(out).toMatch(/1\/3/);
    expect(out).toMatch(/a \(Pending\)/);
    expect(out).toMatch(/b \(Running\)/);
    expect(out).not.toMatch(/c \(/);
  });

  it('does not paste an unbounded pod list into a deploy error', async () => {
    const { summarizeSupabasePods } = await k3sPromise;
    const many = Array.from({ length: 60 }, (_, i) => `pod-${i} Pending <none>`).join('\n');
    const out = summarizeSupabasePods(many);
    expect(out).toMatch(/0\/60/);
    expect(out.length).toBeLessThan(600);
    // The overflow is acknowledged, not silently dropped.
    expect(out).toMatch(/more/);
  });
});
