/**
 * Offline repro of the 2026-08-05 kept k8s-ha rig (e4) data-durability bug.
 *
 * What happened: a mid-deploy failure left `.vibecarbon/deploy-state-<env>.json`
 * with `k3s-apply` STARTED but never completed. The operator re-ran deploy
 * (`node scripts/iter-step.js k8s-ha deploy`), the resumed run re-executed the
 * primary's database install — and its PVCs came out on k3s' node-local
 * `local-path` instead of the Hetzner CSI `hcloud-volumes` the standby had
 * carried since its own deploy 4 days earlier: the database PVCs Pending, the
 * cache PVCs bound to node-local disk. Customer impact: the DATABASE on a
 * non-detachable volume, silently breaking replication / failover / wal-g
 * restore. (The database then ran from a Helm chart; it is now our own
 * StatefulSet, whose volumeClaimTemplate renders the class.)
 *
 * This file pins the two halves of the fix that a RESUMED deploy depends on:
 *
 *   1. the resumed run re-renders with the provider's storage class pinned
 *      (not left to whichever StorageClass happens to be cluster-default), and
 *   2. the `k3s-apply` skip-gate is aware of the storage class, so a warm
 *      resume against a state file written by a pre-fix CLI cannot skip the
 *      step and leave the cluster on the wrong class forever.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const { buildDbManifestValues, buildK3sApplyInputs, renderK8sBase } = await import(
  '../../../src/lib/deploy/k8s/k3s.js'
);
const { StateTracker } = await import('../../../src/lib/deploy/state.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');

const K3S_SRC = readFileSync(
  join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'),
  'utf-8',
) as string;

let cmdCalls: string[][] = [];

function fakeChild({ exitCode = 0, stdout = '' } = {}) {
  const child: Record<string, unknown> = {
    stdout: {
      on(ev: string, cb: (chunk: unknown) => void) {
        if (ev === 'data' && stdout) Promise.resolve().then(() => cb(Buffer.from(stdout)));
      },
    },
    stderr: { on() {} },
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

describe('state-resumed k8s deploy keeps the provider StorageClass', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cmdCalls = [];
    dir = mkdtempSync(join(tmpdir(), 'vc-resume-sc-'));
    mkdirSync(join(dir, 'k8s', 'base', 'db'), { recursive: true });
    writeFileSync(join(dir, 'k8s', 'base', 'kustomization.yaml'), 'resources:\n  - db/\n');
    // The real StatefulSet, as `create` lays it down.
    writeFileSync(
      join(dir, 'k8s', 'base', 'db', 'statefulset.yaml'),
      readFileSync(join(__dirname, '../../../carbon/k8s/base/db/statefulset.yaml'), 'utf-8'),
    );
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.mocked(spawn).mockImplementation(((cmd: string, args: string[] = []) => {
      const argv = [cmd, ...(args ?? [])];
      cmdCalls.push(argv);
      // Healthy cluster: provider SC present, no PVCs yet (fresh release).
      if (argv.join(' ').includes('get storageclass')) {
        return fakeChild({ stdout: 'local-path\nhcloud-volumes\n' }) as unknown as ReturnType<
          typeof spawn
        >;
      }
      return fakeChild() as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const applyArgs = () => ({
    imageTag: '10.0.1.1:5000/proj:abc123-20260805000000',
    dbImageTag: 'ghcr.io/org/postgres:17-walg1',
    restore: undefined,
    projectDir: dir,
    storageClass: HetznerProvider.K8S_STORAGE_CLASS,
  });

  /** The state file a mid-deploy failure leaves behind: k3s-apply STARTED. */
  function seedMidDeployFailureState() {
    const tracker = new StateTracker('proj', 'e4');
    tracker.startStep('k3s-infra', { region: 'nbg1' });
    tracker.completeStep('k3s-infra', { masterIp: '1.2.3.4', floatingIp: '1.2.3.5' });
    tracker.startStep('k3s-ready', { masterIp: '1.2.3.4' });
    tracker.completeStep('k3s-ready');
    tracker.startStep('k3s-kubeconfig', { masterIp: '1.2.3.4' });
    tracker.completeStep('k3s-kubeconfig', { kubeconfig: join(dir, 'kubeconfig') });
    // …and then the deploy died here, mid-apply.
    tracker.startStep('k3s-apply', buildK3sApplyInputs(applyArgs()));
  }

  it('re-runs k3s-apply after a mid-deploy failure (the rig’s state)', () => {
    seedMidDeployFailureState();
    const resumed = new StateTracker('proj', 'e4');
    expect(resumed.shouldSkip('k3s-apply', buildK3sApplyInputs(applyArgs()))).toBe(false);
  });

  it('the resumed render pins the provider class on the db PVC', () => {
    seedMidDeployFailureState();
    // What the resumed k3s-apply does: applyK3sManifests renders k8s/base
    // with ProviderClass.K8S_STORAGE_CLASS before applying it.
    const rendered = renderK8sBase(
      join(dir, 'k8s', 'base'),
      buildDbManifestValues({
        projectName: 'proj',
        dbImageTag: 'ghcr.io/org/postgres:17-walg1',
        storageClass: HetznerProvider.K8S_STORAGE_CLASS,
        dbPrivateIp: '10.0.1.2',
        walArchiveSha: 'abc',
      }),
      undefined,
      {
        dnsNames: ['app.example.test'],
        issuerName: 'letsencrypt-prod-manual',
        effectiveIssuer: 'letsencrypt-prod-manual',
      },
    );
    try {
      const sts = readFileSync(join(rendered, 'db', 'statefulset.yaml'), 'utf-8');
      expect(sts).toContain('storageClassName: "hcloud-volumes"');
      expect(sts).not.toContain('{{K8S_STORAGE_CLASS}}');
    } finally {
      rmSync(rendered, { recursive: true, force: true });
    }
  });

  it('a warm resume against a pre-fix state file cannot skip k3s-apply', () => {
    // A state file written by a CLI whose apply-inputs had no storage class:
    // every other input is byte-identical on the redeploy, so without the new
    // gate input the fix would never reach an already-deployed cluster.
    const preFix = { ...applyArgs() };
    delete (preFix as Record<string, unknown>).storageClass;
    const tracker = new StateTracker('proj', 'e4');
    tracker.startStep('k3s-apply', buildK3sApplyInputs(preFix));
    tracker.completeStep('k3s-apply');

    const resumed = new StateTracker('proj', 'e4');
    expect(resumed.shouldSkip('k3s-apply', buildK3sApplyInputs(applyArgs()))).toBe(false);
  });

  it('busts the gate when the provider (and therefore the class) changed', () => {
    const tracker = new StateTracker('proj', 'e4');
    tracker.startStep('k3s-apply', buildK3sApplyInputs(applyArgs()));
    tracker.completeStep('k3s-apply');

    const resumed = new StateTracker('proj', 'e4');
    expect(
      resumed.shouldSkip(
        'k3s-apply',
        buildK3sApplyInputs({ ...applyArgs(), storageClass: 'do-block-storage' }),
      ),
    ).toBe(false);
    // …and an unchanged redeploy still skips (no needless 20-minute re-apply).
    expect(
      new StateTracker('proj', 'e4').shouldSkip('k3s-apply', buildK3sApplyInputs(applyArgs())),
    ).toBe(true);
  });
});

describe('deployK3s threads the provider StorageClass end to end', () => {
  it('feeds ProviderClass.K8S_STORAGE_CLASS into the k3s-apply skip-gate', () => {
    const deployStart = K3S_SRC.indexOf('export async function deployK3s(');
    expect(deployStart).toBeGreaterThan(-1);
    const body = K3S_SRC.slice(deployStart);
    const gateCall = body.slice(body.indexOf('buildK3sApplyInputs({'));
    expect(gateCall.slice(0, gateCall.indexOf('});'))).toContain(
      'storageClass: Provider.K8S_STORAGE_CLASS',
    );
  });

  it('applyK3sManifests renders the db with the provider class (no silent default)', () => {
    const applyStart = K3S_SRC.indexOf('export async function applyK3sManifests(');
    expect(applyStart).toBeGreaterThan(-1);
    const body = K3S_SRC.slice(applyStart);
    expect(body).toContain('const storageClass = ProviderClass?.K8S_STORAGE_CLASS;');
    const valuesCall = body.slice(body.indexOf('buildDbManifestValues({'));
    expect(valuesCall.slice(0, valuesCall.indexOf('})'))).toMatch(/\n\s+storageClass,\n/);
    // …and checks the cluster has it (and the PGDATA claim is on it) first.
    expect(body.indexOf('assertDbStorageClass({ storageClass, env })')).toBeLessThan(
      body.indexOf('renderK8sBase('),
    );
  });
});
