/**
 * The CLI's server-side apply takes over the cloud Secrets a master's boot
 * script made, on a real apiserver, and restarts what reads a changed one.
 *
 * deployK3s hands the provider API token to the cluster on every deploy
 * (applyCloudSecrets), while the master boot scripts still create the same
 * Secrets with `kubectl create secret generic ... | kubectl apply -f -`, a
 * client-side apply. Whether a server-side apply owned by vibecarbon-cli takes
 * those over without a conflict, and what it leaves in them, is the
 * apiserver's and kubectl's business, so this asks a real one: the k3s
 * release the CLI installs (or VC_K3S_VERSION, the release the version
 * channel is about to publish), control plane only, and the kubectl on this
 * machine, the one a deploy runs.
 *
 * For every provider with a k8s tier, the cloud controller and CSI driver
 * manifests its boot script applies are applied here from the same URLs, so
 * the workloads that read the token are upstream's own. Then each test starts
 * from what a fresh master has: the boot script's own Secret commands (read
 * out of it, tests/_shared/master-init-secrets.ts) run on the node, and no
 * workload carries a restart. applyCloudSecrets runs from here. It must take
 * the Secrets over with their data as it set it, leave an unchanged Secret
 * alone, resourceVersion included, since it runs on every deploy, and replace
 * a rotated token, restarting exactly the workloads that read it: no pod
 * reads a Secret again once it has started.
 *
 * Needs Docker, kubectl and GitHub (the upstream manifests). The version
 * channel's k3s smoke runs it too (.github/workflows/version-channel.yml).
 * Every container here is named vctest-* and removed in afterAll.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCloudSecrets } from '../../../src/lib/deploy/k8s/k3s.js';
import { renderScript } from '../../../src/lib/iac/cloud-init.js';
import { k3sVersion } from '../../../src/lib/images.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { kubectlClientVersion } from '../../../src/lib/runtime-floors.js';
import { masterInitSecrets } from '../../_shared/master-init-secrets.js';

const SKIPPED =
  process.env.DOCKER_INTEGRATION === 'true'
    ? null
    : 'skipped: needs Docker, kubectl and GitHub; run it with DOCKER_INTEGRATION=true (pnpm test:docker)';
if (SKIPPED) console.info(`k8s-cloud-secrets-takeover: ${SKIPPED}`);

const VERSION = process.env.VC_K3S_VERSION || k3sVersion();
const IMAGE = `rancher/k3s:${VERSION.replace('+', '-')}`;
const NODE = `vctest-k3s-secrets-${process.pid}`;
const LONG = 180_000;

/** What the boot script renders: a real token is shell-safe, so this one is. */
const BOOT_TOKEN = 'vc-sentinel-token-boot-1d2c';
/** A rotated token, YAML-hostile, so the stdin manifest's quoting is proven too. */
const ROTATED_TOKEN = `vc-sentinel-token-rotated: "dq" 'sq' #hash \\bs {x}`;
const NETWORK = '4210337';
const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt';
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

/**
 * The workloads that read each provider's token, from the manifests its boot
 * script applies, all through an env var from a secretKeyRef:
 *   hcloud ccm.yaml v1.39.2 L149-153 (HCLOUD_TOKEN from hcloud/token),
 *   hcloud-csi.yml v2.24.1 L331-335 (HCLOUD_TOKEN from hcloud/token),
 *   DO CCM v0.1.72.yml L48-52 (DO_ACCESS_TOKEN from digitalocean/access-token),
 *   DO csi driver.yaml v4.19.0 L177-181 (DIGITALOCEAN_ACCESS_TOKEN, same key),
 *   Linode csi v1.1.5 L357-361 (LINODE_TOKEN from linode/token).
 * Nothing reads hcloud-csi or hcloud's network key. Written out, not read
 * from the code under test: this is what its discovery must find.
 */
const READERS: Record<string, string[]> = {
  hetzner: ['deployment/hcloud-cloud-controller-manager', 'deployment/hcloud-csi-controller'],
  digitalocean: [
    'deployment/digitalocean-cloud-controller-manager',
    'statefulset/csi-do-controller',
  ],
  linode: ['statefulset/csi-linode-controller'],
};

const K8S_PROVIDERS = Object.entries(PROVIDERS).filter(([, P]) =>
  P.SUPPORTED_TIERS.includes('k8s'),
);

const run = (cmd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) =>
  spawnSync(cmd, args, { encoding: 'utf-8', input, env, timeout: LONG });
const must = (cmd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) => {
  const r = run(cmd, args, input, env);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
  }
  return r.stdout;
};
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The boot script's value for a template variable, by the naming the scripts use. */
const bootValue = (variable: string) =>
  variable === 'network_id' ? NETWORK : variable.endsWith('_token') ? BOOT_TOKEN : undefined;

/** The manifests a boot script applies by URL, in its order. */
const manifestUrls = (script: string) =>
  [...script.matchAll(/kubectl apply -f (https:\/\/[^\s;]+)/g)].map(([, url]) => url);

describe.skipIf(SKIPPED)(
  `the CLI takes over the boot script's cloud Secrets (k3s ${VERSION})`,
  () => {
    let dir: string;
    let kubeconfig: string;
    let kubectlMinor: number;
    const kube = (args: string[], input?: string) =>
      must('kubectl', args, input, { ...process.env, KUBECONFIG: kubeconfig });

    /** A Secret as the apiserver holds it: data decoded, its managers, annotations, version. */
    const read = (namespace: string, name: string) => {
      const secret = JSON.parse(
        kube(['-n', namespace, 'get', 'secret', name, '-o', 'json', '--show-managed-fields']),
      );
      return {
        data: Object.fromEntries(
          Object.entries(secret.data as Record<string, string>).map(([k, v]) => [
            k,
            Buffer.from(v, 'base64').toString('utf8'),
          ]),
        ),
        managers: (secret.metadata.managedFields as { manager: string; operation: string }[]).map(
          ({ manager, operation }) => `${manager}:${operation}`,
        ),
        annotations: (secret.metadata.annotations ?? {}) as Record<string, string>,
        resourceVersion: secret.metadata.resourceVersion as string,
      };
    };

    type Workload = {
      kind: string;
      metadata: { name: string };
      spec: { template: { metadata?: { annotations?: Record<string, string> } } };
    };
    const workloads = (): Workload[] =>
      JSON.parse(
        kube(['-n', 'kube-system', 'get', 'deployments,statefulsets,daemonsets', '-o', 'json']),
      ).items;
    const id = (w: Workload) => `${w.kind.toLowerCase()}/${w.metadata.name}`;
    /** The workloads `kubectl rollout restart` has stamped, sorted. */
    const restarted = () =>
      workloads()
        .filter((w) => w.spec.template.metadata?.annotations?.[RESTARTED_AT])
        .map(id)
        .sort();

    beforeAll(() => {
      const client = run('kubectl', ['version', '--client', '-o', 'json']);
      expect(client.status, 'kubectl on PATH').toBe(0);
      kubectlMinor = Number(kubectlClientVersion(client.stdout)?.split('.')[1]);
      dir = mkdtempSync(join(tmpdir(), 'vctest-k3s-secrets-'));
      must('docker', [
        'run',
        '-d',
        '--privileged',
        '--name',
        NODE,
        '--tmpfs',
        '/run',
        '--tmpfs',
        '/var/run',
        '-p',
        '127.0.0.1::6443',
        IMAGE,
        'server',
        // The apiserver is the subject; no node, no system pods, nothing pulled.
        // The CCM and CSI workloads are created and never scheduled.
        '--disable-agent',
        '--disable',
        'coredns,servicelb,traefik,local-storage,metrics-server,gateway-api-crd',
        '--tls-san',
        '127.0.0.1',
      ]);
      const deadline = Date.now() + 120_000;
      while (run('docker', ['exec', NODE, 'kubectl', 'get', '--raw', '/readyz']).stdout !== 'ok') {
        if (Date.now() > deadline) throw new Error('timed out waiting for the k3s apiserver');
        sleepSync(1000);
      }
      const port = must('docker', ['port', NODE, '6443']).trim().split(':').pop();
      kubeconfig = join(dir, 'kubeconfig');
      writeFileSync(
        kubeconfig,
        must('docker', ['exec', NODE, 'cat', '/etc/rancher/k3s/k3s.yaml']).replace(
          'https://127.0.0.1:6443',
          `https://127.0.0.1:${port}`,
        ),
        { mode: 0o600 },
      );
    }, LONG);

    afterAll(() => {
      run('docker', ['rm', '-f', '-v', NODE]);
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    // applyCloudSecrets says what it hands over and restarts.
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe.each(K8S_PROVIDERS)('%s', (providerId, Provider) => {
      let script: string;

      // What the boot script installs besides the Secrets: upstream's cloud
      // controller and CSI driver, from the URLs it applies them from.
      beforeAll(async () => {
        script = await Provider.getK8sMasterUserData({});
        const urls = manifestUrls(script);
        expect(urls.length, 'the boot script applies upstream manifests').toBeGreaterThan(0);
        for (const url of urls) {
          kube(['apply', '-f', url]);
          // A later manifest may hold objects of a CRD this one created. By
          // name: `crd --all` fails outright while k3s has registered none
          // of its own yet.
          const crds = kube(['get', 'crd', '-o', 'name']).split('\n').filter(Boolean);
          if (crds.length > 0) {
            kube(['wait', '--for=condition=established', ...crds, '--timeout=60s']);
          }
        }
      }, LONG);

      const hand = (token: string) =>
        applyCloudSecrets({
          env: { ...process.env, KUBECONFIG: kubeconfig },
          ProviderClass: Provider,
          token,
          networkId: NETWORK,
          stack: 'vctest',
          operatorEnv: 'vctest',
        });
      const expected = (token: string) => Provider.k8sCloudSecrets({ token, networkId: NETWORK });

      /**
       * A fresh master: the boot script's Secrets as it creates them and no
       * restart stamped on any workload, whatever the test before left.
       */
      const freshMaster = () => {
        for (const { namespace, name } of expected(BOOT_TOKEN)) {
          kube(['-n', namespace, 'delete', 'secret', name, '--ignore-not-found']);
        }
        for (const w of workloads()) {
          if (!w.spec.template.metadata?.annotations?.[RESTARTED_AT]) continue;
          kube([
            '-n',
            'kube-system',
            'patch',
            id(w),
            '--type=json',
            '-p',
            JSON.stringify([
              {
                op: 'remove',
                path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt',
              },
            ]),
          ]);
        }
        for (const { namespace, name, keys, command } of masterInitSecrets(script)) {
          const vars = Object.fromEntries(Object.values(keys).map((v) => [v, bootValue(v)]));
          must('docker', ['exec', '-i', NODE, 'sh', '-eu'], renderScript(command, vars));
          expect(read(namespace, name).managers).toEqual(['kubectl-client-side-apply:Update']);
        }
        expect(restarted()).toEqual([]);
      };

      it(
        'takes over what the boot script made, with no conflict, its data as it set it, and restarts nothing',
        async () => {
          freshMaster();
          for (const { namespace, name } of expected(BOOT_TOKEN)) {
            expect(read(namespace, name).annotations).toHaveProperty([LAST_APPLIED]);
          }
          await hand(BOOT_TOKEN);
          for (const { namespace, name, stringData } of expected(BOOT_TOKEN)) {
            const secret = read(namespace, name);
            expect(secret.data).toEqual(stringData);
            expect(secret.managers).toContain('vibecarbon-cli:Apply');
            // The boot script's client-side record of what it applied, token
            // and all, goes with the takeover: kubectl since 1.26 moves a
            // client-side apply's fields to the server-side manager and drops
            // the annotation. kubectl 1.24.17 and 1.25.16, inside the CLI's
            // floor, leave it, with the boot script's token in it and its
            // manager beside vibecarbon-cli (measured against this k3s,
            // 2026-11-11), so only a 1.26+ client is held to it.
            if (kubectlMinor >= 26) expect(secret.annotations).not.toHaveProperty([LAST_APPLIED]);
            else expect(secret.annotations).toHaveProperty([LAST_APPLIED]);
          }
          expect(restarted()).toEqual([]);
        },
        LONG,
      );

      it(
        'leaves an unchanged Secret alone, resourceVersion included, and restarts nothing',
        async () => {
          freshMaster();
          await hand(BOOT_TOKEN);
          const before = expected(BOOT_TOKEN).map(({ namespace, name }) => read(namespace, name));
          await hand(BOOT_TOKEN);
          const after = expected(BOOT_TOKEN).map(({ namespace, name }) => read(namespace, name));
          expect(after.map((s) => s.resourceVersion)).toEqual(before.map((s) => s.resourceVersion));
          expect(restarted()).toEqual([]);
        },
        LONG,
      );

      it(
        'replaces a rotated token, with no conflict, and restarts exactly what reads it',
        async () => {
          freshMaster();
          await hand(ROTATED_TOKEN);
          for (const { namespace, name, stringData } of expected(ROTATED_TOKEN)) {
            expect(read(namespace, name).data).toEqual(stringData);
          }
          expect(restarted()).toEqual(READERS[providerId]);
        },
        LONG,
      );

      it(
        'creates Secrets a master lacks, and restarts nothing',
        async () => {
          freshMaster();
          for (const { namespace, name } of expected(BOOT_TOKEN)) {
            kube(['-n', namespace, 'delete', 'secret', name]);
          }
          await hand(ROTATED_TOKEN);
          for (const { namespace, name, stringData } of expected(ROTATED_TOKEN)) {
            expect(read(namespace, name).data).toEqual(stringData);
          }
          expect(restarted()).toEqual([]);
        },
        LONG,
      );

      it(
        'wins over another server-side owner of the same keys (--force-conflicts)',
        async () => {
          freshMaster();
          // Someone else's server-side apply, say an operator's own tooling,
          // took the keys over with another value. Without --force-conflicts
          // the deploy's apply would stop on the conflict.
          const other = expected('vc-sentinel-token-other').map(({ namespace, name, stringData }) =>
            [
              'apiVersion: v1',
              'kind: Secret',
              `metadata: {name: ${name}, namespace: ${namespace}}`,
              `stringData: ${JSON.stringify(stringData)}`,
            ].join('\n'),
          );
          kube(
            [
              'apply',
              '--server-side',
              '--force-conflicts',
              '--field-manager=vctest-other',
              '-f',
              '-',
            ],
            other.join('\n---\n'),
          );
          await hand(BOOT_TOKEN);
          for (const { namespace, name, stringData } of expected(BOOT_TOKEN)) {
            expect(read(namespace, name).data).toEqual(stringData);
          }
          // The other owner's value was the one in effect.
          expect(restarted()).toEqual(READERS[providerId]);
        },
        LONG,
      );
    });
  },
);
