/**
 * The deploy's CSI re-pin changes nothing on a cluster whose master installed
 * the CSI manifest through its image rewrite.
 *
 * applyK3sManifests step 0a runs `kubectl -n kube-system set image <workload>
 * <container>=<ref>...` from csiSidecarSetImagePlan on every deploy. Each
 * master's cloud-init rewrites the CSI manifest to those refs before it
 * applies it (csi_fetch_mirrored, carbon/cloud-init/k3s/_csi-image-mirror.sh),
 * so on a new cluster that command must change nothing: no new pod template,
 * so no rollout of the node plugin while the db PVC waits for it (run
 * 44623637422). This asks a real k3s and the kubectl a deploy runs. Per
 * provider, the CSI workloads (as UPSTREAM_CSI_MANIFESTS records them) go
 * through the rewrite rendered into that provider's master and into the
 * cluster, the plan's command runs as the deploy runs it, and each workload
 * keeps its generation and pod template. The same command on the workloads
 * as upstream ships them, a cluster built before the rewrite, changes both,
 * so the check can see a change.
 *
 * Needs Docker and kubectl. One k3s server and no agent: nothing here needs
 * a pod, only the API and its controllers. The container is named vctest-*
 * and removed in afterAll.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csiSidecarSetImagePlan, k3sVersion } from '../../../src/lib/images.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import {
  csiManifest,
  runCsiInstallRewrite,
  UPSTREAM_CSI_MANIFESTS,
} from '../../_shared/csi-install-rewrite.js';
import { dockerRunner, dockerTierSkip, waitFor } from '../../_shared/docker-sync.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

const SKIPPED = dockerTierSkip('csi-repin-noop', 'Docker and kubectl');

const VERSION = process.env.VC_K3S_VERSION || k3sVersion();
const IMAGE = `rancher/k3s:${VERSION.replace('+', '-')}`;
const SERVER = `vctest-csi-repin-${process.pid}`;
/** Where the workloads as upstream ships them go; the re-pin's own namespace holds the rewritten ones. */
const UPSTREAM_NS = 'vctest-upstream';
const LONG = 240_000;

const { run, must } = dockerRunner({ timeoutMs: LONG });

type MasterUserData = { getK8sMasterUserData: (vars: object) => Promise<string> };
const MASTER_VARS = {
  k3s_version: VERSION,
  k3s_token: 'vctest-csi-repin-token',
  floating_ip: '203.0.113.10',
  project_name: 'vctest',
  project_tag: 'project:vctest',
};

type Workload = { metadata: { generation: number }; spec: { template: unknown } };

describe.skipIf(SKIPPED)(`the deploy's CSI re-pin on a real k3s (${VERSION})`, () => {
  let dir: string;
  let kubeconfig: string;
  const kube = (args: string[], input?: string) =>
    must('kubectl', args, { input, env: { ...process.env, KUBECONFIG: kubeconfig } });
  const get = (ns: string, workload: string): Workload =>
    JSON.parse(kube(['-n', ns, 'get', workload, '-o', 'json']));
  /** The deploy's step 0a command, in `ns`. */
  const repin = (ns: string, workload: string, setImageArgs: string[]) =>
    kube(['-n', ns, 'set', 'image', workload, ...setImageArgs]);

  beforeAll(() => {
    expect(run('kubectl', ['version', '--client']).status, 'kubectl on PATH').toBe(0);
    dir = createTempDir('vctest-csi-repin-');
    must('docker', [
      'run',
      '-d',
      '--privileged',
      '--name',
      SERVER,
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/var/run',
      '-p',
      '127.0.0.1::6443',
      IMAGE,
      'server',
      '--disable-agent',
      '--disable',
      'coredns,servicelb,traefik,local-storage,metrics-server',
      '--tls-san',
      '127.0.0.1',
    ]);
    waitFor(
      'the k3s apiserver',
      () =>
        String(run('docker', ['exec', SERVER, 'kubectl', 'get', '--raw', '/readyz']).stdout) ===
        'ok',
      120_000,
    );
    const port = must('docker', ['port', SERVER, '6443']).trim().split(':').pop();
    kubeconfig = join(dir, 'kubeconfig');
    writeFileSync(
      kubeconfig,
      must('docker', ['exec', SERVER, 'cat', '/etc/rancher/k3s/k3s.yaml']).replace(
        'https://127.0.0.1:6443',
        `https://127.0.0.1:${port}`,
      ),
      { mode: 0o600 },
    );
    kube(['create', 'namespace', UPSTREAM_NS]);
  }, LONG);

  afterAll(() => {
    run('docker', ['rm', '-f', '-v', SERVER]);
    if (dir) cleanupTempDir(dir);
  });

  it.each(Object.keys(UPSTREAM_CSI_MANIFESTS))(
    '%s: on the rewritten workloads it sends nothing and rolls nothing; on upstream’s it changes the template',
    async (provider) => {
      const upstream = UPSTREAM_CSI_MANIFESTS[provider as keyof typeof UPSTREAM_CSI_MANIFESTS]
        .workloads as Record<string, Record<string, string>>;
      const rendered = await (PROVIDERS as unknown as Record<string, MasterUserData>)[
        provider
      ].getK8sMasterUserData(MASTER_VARS);
      const { status, stderr, installed } = runCsiInstallRewrite(rendered, csiManifest(upstream));
      expect(status, stderr).toBe(0);
      kube(['apply', '-f', '-'], installed as string);
      kube(['apply', '-f', '-'], csiManifest(upstream, UPSTREAM_NS));

      const plan = csiSidecarSetImagePlan(provider);
      expect(plan.length).toBeGreaterThan(0);
      for (const { workload, setImageArgs } of plan) {
        // A new cluster: the pods started on the mirrors.
        const before = get('kube-system', workload);
        expect(
          repin('kube-system', workload, setImageArgs),
          `${workload}: kubectl sent a patch`,
        ).toBe('');
        const after = get('kube-system', workload);
        expect(after.metadata.generation, workload).toBe(before.metadata.generation);
        expect(after.spec.template, workload).toEqual(before.spec.template);

        // A cluster built before the rewrite: the same command is a change.
        const old = get(UPSTREAM_NS, workload);
        expect(repin(UPSTREAM_NS, workload, setImageArgs)).toContain('image updated');
        const moved = get(UPSTREAM_NS, workload);
        expect(moved.metadata.generation, workload).toBe(old.metadata.generation + 1);
        expect(moved.spec.template, workload).not.toEqual(old.spec.template);
        // ...to exactly what the rewrite installs.
        expect(moved.spec.template, workload).toEqual(after.spec.template);
      }
    },
    LONG,
  );
});
