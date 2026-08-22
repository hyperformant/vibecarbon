/**
 * Supabase PVC storage-class pin + the wrong-StorageClass guard.
 *
 * Live RCA (kept k8s-ha rig e4, 2026-08-05). The rig's STANDBY, installed 4
 * days earlier, carried `hcloud-volumes` (Hetzner CSI) on `supabase-db` and
 * `supabase-pgsodium`. A state-resumed deploy that re-ran the PRIMARY's
 * `installSupabase` produced the SAME PVCs on **local-path** — k3s' built-in
 * node-local provisioner. supabase-db + supabase-pgsodium sat Pending;
 * imgproxy/snippets/storage bound to node-local disk. On a customer that is
 * silent data-durability loss: the database's volume is no longer detachable,
 * which breaks the replication / failover / wal-g restore model with no error
 * anywhere.
 *
 * Mechanism: NOTHING pinned the storage class. installSupabase's values render
 * substitutes 14 `{{TOKEN}}`s and `storageClassName` was never one of them; the
 * chart's `_pvc.tpl` emits the field only `{{- if $persistence.storageClassName }}`,
 * so every Supabase PVC was created WITHOUT a class and the kube-apiserver's
 * DefaultStorageClass admission plugin stamped whatever was default at that
 * instant. Both candidates are annotated `is-default-class: "true"` — k3s ships
 * `local-path` that way, and hetznercloud/csi-driver's `hcloud-volumes` does
 * too (byte-identical StorageClass at the v2.9.0 of the incident and at the
 * v2.18.1 pinned now) — and with two defaults the plugin picks the NEWEST by
 * creationTimestamp. The provider static `K8S_STORAGE_CLASS` reached only the
 * add-on kustomize manifests (renderK8sStorageClassPlaceholder), never the
 * chart. So which storage a customer's database lands on was decided by an
 * unpinned race the deploy never asserted.
 *
 * Mocking strategy mirrors k3s-install-supabase.test.ts: every shell-out
 * reaches node's `spawn` via command.js, so mocking spawn drives the function
 * while fs and command.js stay real.
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
const providersPromise = import('../../../src/lib/providers/index.js');

const CHART_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/supabase-chart-workloads.json'), 'utf-8'),
) as { pvcs: string[] };

let cmdCalls: string[][] = [];
/** Scripted kubectl stdout, keyed by a substring of the joined argv. */
let kubectlStdout: { match: string; stdout: string; exitCode?: number }[] = [];
let helmUpgradeExit = { code: 0, stderr: '' };

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
      if (ev === 'exit' || ev === 'close') setTimeout(() => cb(exitCode), 0);
      return child;
    },
  };
  return child;
}

function installSpawnMock() {
  vi.mocked(spawn).mockImplementation(((cmd: string, args: string[] = []) => {
    const argv = [cmd, ...(args ?? [])];
    cmdCalls.push(argv);
    const joined = argv.join(' ');
    if (cmd === 'helm' && (args ?? [])[0] === 'upgrade') {
      return fakeChild({
        exitCode: helmUpgradeExit.code,
        stderr: helmUpgradeExit.stderr,
      }) as unknown as ReturnType<typeof spawn>;
    }
    const scripted = kubectlStdout.find((s) => joined.includes(s.match));
    if (scripted) {
      return fakeChild({
        stdout: scripted.stdout,
        exitCode: scripted.exitCode ?? 0,
      }) as unknown as ReturnType<typeof spawn>;
    }
    return fakeChild() as unknown as ReturnType<typeof spawn>;
  }) as typeof spawn);
}

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'k3s-supabase-sc-'));
  mkdirSync(join(dir, 'k8s/values'), { recursive: true });
  writeFileSync(
    join(dir, 'k8s/values/supabase.values.yaml'),
    'secret:\n  dashboard:\n    username: {{ADMIN_EMAIL}}\n    password: {{ADMIN_PASSWORD}}\ndomain: {{DOMAIN}}\n',
  );
  return dir;
}

const baseArgs = {
  kubeconfig: '/tmp/fake-kubeconfig',
  projectName: 'testproj',
  domain: 'test.example.com',
  dbImageTag: 'ghcr.io/test/postgres:17-walg1',
  storageClass: 'hcloud-volumes',
};

async function runInstall(overrides: Record<string, unknown> = {}) {
  const { installSupabase } = await k3sPromise;
  return installSupabase({ ...baseArgs, projectDir: makeProjectDir(), ...overrides });
}

const helmUpgradeArgv = () => cmdCalls.find(([cmd, sub]) => cmd === 'helm' && sub === 'upgrade');

/** The `--set` value that pins the chart's persistence storage classes. */
function storageClassSetArg(): string | undefined {
  const argv = helmUpgradeArgv() ?? [];
  return argv.find((a, i) => argv[i - 1] === '--set' && a.includes('storageClassName'));
}

beforeEach(() => {
  cmdCalls = [];
  helmUpgradeExit = { code: 0, stderr: '' };
  // Healthy cluster by default: the provider SC exists, no PVCs yet.
  kubectlStdout = [
    { match: 'get storageclass', stdout: 'local-path\nhcloud-volumes\n' },
    { match: 'get pvc', stdout: '' },
  ];
  installSpawnMock();
});

describe('installSupabase — provider StorageClass is pinned on every chart PVC', () => {
  it('passes the provider storage class to helm for the db PVC', async () => {
    await runInstall();
    expect(storageClassSetArg()).toContain('persistence.db.storageClassName=hcloud-volumes');
  });

  it('pins EVERY PVC the pinned chart renders (fixture drift guard)', async () => {
    await runInstall();
    const setArg = storageClassSetArg() ?? '';
    for (const pvc of CHART_FIXTURE.pvcs) {
      expect(setArg).toContain(`persistence.${pvc}.storageClassName=hcloud-volumes`);
    }
  });

  it("uses the DigitalOcean provider's class when that is what the deploy resolved", async () => {
    const { DigitalOceanProvider } = await providersPromise;
    kubectlStdout = [
      { match: 'get storageclass', stdout: 'local-path\ndo-block-storage\n' },
      { match: 'get pvc', stdout: '' },
    ];
    await runInstall({ storageClass: DigitalOceanProvider.K8S_STORAGE_CLASS });
    expect(storageClassSetArg()).toContain('persistence.db.storageClassName=do-block-storage');
    expect(storageClassSetArg()).not.toContain('hcloud-volumes');
  });

  it('never leaves the class to the cluster default — empty storageClass throws', async () => {
    await expect(runInstall({ storageClass: '' })).rejects.toThrow(/K8S_STORAGE_CLASS/);
    expect(helmUpgradeArgv()).toBeUndefined();
  });

  it('throws when no storageClass is threaded at all (silent-default regression)', async () => {
    await expect(runInstall({ storageClass: undefined })).rejects.toThrow(/K8S_STORAGE_CLASS/);
    expect(helmUpgradeArgv()).toBeUndefined();
  });

  it('keeps the standby zero-overlay ordering intact (--set still wins)', async () => {
    const dir = makeProjectDir();
    writeFileSync(
      join(dir, 'k8s/values/supabase.standby.values.yaml'),
      'deployment:\n  auth:\n    replicaCount: 0\n',
    );
    await runInstall({ projectDir: dir, role: 'standby', walgRole: 'standby' });
    const argv = helmUpgradeArgv() ?? [];
    // helm applies --set AFTER every -f, so the pin cannot be shadowed by a
    // stale project values file or by the standby overlay.
    expect(argv.filter((a) => a === '-f')).toHaveLength(2);
    expect(storageClassSetArg()).toContain('persistence.db.storageClassName=hcloud-volumes');
  });
});

describe('installSupabase — wrong-StorageClass guard (db-critical PVCs)', () => {
  it('refuses to proceed when supabase-db already exists on the wrong class', async () => {
    kubectlStdout = [
      { match: 'get storageclass', stdout: 'local-path\nhcloud-volumes\n' },
      { match: 'get pvc', stdout: 'supabase-db=local-path\nsupabase-pgsodium=local-path\n' },
    ];
    await expect(runInstall()).rejects.toThrow(/supabase-db/);
    // Loud AND early: helm must never run on top of a node-local database.
    expect(helmUpgradeArgv()).toBeUndefined();
  });

  it('names the observed class, the expected class, and the remediation', async () => {
    kubectlStdout = [
      { match: 'get storageclass', stdout: 'local-path\nhcloud-volumes\n' },
      { match: 'get pvc', stdout: 'supabase-db=local-path\n' },
    ];
    const err = await runInstall().catch((e: Error) => e);
    const msg = String((err as Error).message);
    expect(msg).toContain('local-path');
    expect(msg).toContain('hcloud-volumes');
    expect(msg).toMatch(/delete pvc/i);
    // Deleting a node-local db PVC destroys the only copy of that data —
    // the message must say so rather than reading like a safe retry.
    expect(msg).toMatch(/restore/i);
  });

  it('flags a db-critical PVC that carries no class at all', async () => {
    kubectlStdout = [
      { match: 'get storageclass', stdout: 'local-path\nhcloud-volumes\n' },
      { match: 'get pvc', stdout: 'supabase-pgsodium=\n' },
    ];
    await expect(runInstall()).rejects.toThrow(/supabase-pgsodium/);
  });

  it('ignores non-db-critical PVCs on another class (bounded blast radius)', async () => {
    kubectlStdout = [
      { match: 'get storageclass', stdout: 'local-path\nhcloud-volumes\n' },
      {
        match: 'get pvc',
        stdout:
          'supabase-db=hcloud-volumes\nsupabase-pgsodium=hcloud-volumes\nsupabase-storage=local-path\n',
      },
    ];
    await expect(runInstall()).resolves.not.toThrow();
    expect(helmUpgradeArgv()).toBeDefined();
  });

  it('proceeds when the existing db PVCs already carry the provider class', async () => {
    kubectlStdout = [
      { match: 'get storageclass', stdout: 'local-path\nhcloud-volumes\n' },
      {
        match: 'get pvc',
        stdout: 'supabase-db=hcloud-volumes\nsupabase-pgsodium=hcloud-volumes\n',
      },
    ];
    await expect(runInstall()).resolves.not.toThrow();
    expect(helmUpgradeArgv()).toBeDefined();
  });

  it('fails loud when the provider StorageClass is absent from the cluster', async () => {
    // cloud-init's CSI install is a best-effort 3-try loop whose failure is
    // never checked, so a cluster CAN come up with only k3s' local-path.
    kubectlStdout = [
      { match: 'get storageclass', stdout: 'local-path\n' },
      { match: 'get pvc', stdout: '' },
    ];
    const err = await runInstall().catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/hcloud-volumes/);
    expect(String((err as Error).message)).toMatch(/CSI/i);
    expect(helmUpgradeArgv()).toBeUndefined();
  });

  it('does not block the deploy when the probe itself cannot answer', async () => {
    // A transient apiserver blip must not turn into a deploy failure — the
    // pinned --set still prevents a silent local-path bind (the PVC would
    // stay Pending and helm --wait would fail loudly instead).
    kubectlStdout = [
      { match: 'get storageclass', stdout: '', exitCode: 1 },
      { match: 'get pvc', stdout: '', exitCode: 1 },
    ];
    await expect(runInstall()).resolves.not.toThrow();
    expect(helmUpgradeArgv()).toBeDefined();
  });
});
