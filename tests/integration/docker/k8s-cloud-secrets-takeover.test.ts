/**
 * The CLI's server-side apply takes over the cloud Secrets an earlier
 * vibecarbon's boot script made, on a real apiserver, removes what nothing
 * reads any more, and restarts what reads a changed one.
 *
 * deployK3s hands the provider API token to the cluster on every deploy
 * (applyCloudSecrets). Masters an earlier vibecarbon booted hold the same
 * Secrets from their boot script's `kubectl create secret generic ... |
 * kubectl apply -f -`, a client-side apply, and Hetzner's hold two things
 * nothing reads: a second copy of the token in hcloud-csi, and hcloud's
 * network key. Whether a server-side apply owned by vibecarbon-cli takes
 * those over without a conflict, and what it leaves in them, is the
 * apiserver's and kubectl's business, so this asks a real one: the k3s
 * release the CLI installs (or VC_K3S_VERSION, the release the version
 * channel is about to publish), control plane only, and the kubectl on this
 * machine, the one a deploy runs.
 *
 * For every provider with a k8s tier, the cloud controller and CSI driver
 * manifests its boot script applies are applied here from the same URLs, so
 * the workloads that read the token are upstream's own, and what they read
 * is held to the census's record of it (tests/_shared/cloud-secret-readers.ts).
 * Then each test starts from what an old master has: the old boot script's
 * Secret commands (tests/_shared/legacy-master-init-secrets.ts) run on the
 * node, and no workload carries a restart. applyCloudSecrets runs from here.
 * It must take the Secrets over with exactly the keys it writes, delete the
 * Secrets it no longer writes (and never call a retired key kept that the
 * takeover itself dropped, though something reads it), and leave no
 * last-applied annotation, a copy
 * of the token the boot script applied, whatever the kubectl (run it with an
 * older one first on PATH to check one). It must leave an unchanged Secret
 * alone, resourceVersion included, since it runs on every deploy, replace a
 * rotated token, and restart exactly the workloads that read a changed one:
 * no pod reads a Secret again once it has started. (With no node, those
 * readers run at zero replicas, so the CLI's wait for each restart finishes
 * at once.) A new one restarts
 * nothing: the kubelet starts what waited for it
 * (tests/integration/docker/k8s-secret-readers-restart.test.ts).
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
import { applyCloudSecrets, CLOUD_SECRETS_APPLY_ARGV } from '../../../src/lib/deploy/k8s/k3s.js';
import { renderScript } from '../../../src/lib/iac/cloud-init.js';
import { k3sVersion } from '../../../src/lib/images.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import {
  CLOUD_SECRET_READERS,
  manifestUrls,
  type SecretRef,
} from '../../_shared/cloud-secret-readers.js';
import { LEGACY_MASTER_INIT_SECRETS } from '../../_shared/legacy-master-init-secrets.js';
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
 * The workloads that read each provider's token, as the census records them
 * from upstream's manifests (each test below checks the record against the
 * manifests it applies). Not read from the code under test: this is what its
 * discovery must find.
 */
const READERS: Record<string, string[]> = Object.fromEntries(
  Object.entries(CLOUD_SECRET_READERS).map(([id, { refs }]) => [
    id,
    [...new Set(refs.filter(({ optional }) => !optional).map(({ workload }) => workload))].sort(),
  ]),
);

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

/** The old boot script's value for a template variable, by the naming the scripts used. */
const bootValue = (variable: string) =>
  variable === 'network_id' ? NETWORK : variable.endsWith('_token') ? BOOT_TOKEN : undefined;

describe.skipIf(SKIPPED)(
  `the CLI takes over the boot script's cloud Secrets (k3s ${VERSION})`,
  () => {
    let dir: string;
    let kubeconfig: string;
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
      metadata: { name: string; namespace: string };
      spec: {
        template: {
          metadata?: { annotations?: Record<string, string> };
          spec: {
            containers?: {
              env?: {
                valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
              }[];
              envFrom?: { secretRef?: { name: string } }[];
            }[];
            initContainers?: Workload['spec']['template']['spec']['containers'];
            volumes?: { secret?: { secretName: string }; projected?: unknown }[];
          };
        };
      };
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
      expect(run('kubectl', ['version', '--client']).status, 'kubectl on PATH').toBe(0);
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

    /**
     * Every Secret reference in these workloads' pod templates, as the
     * census records them. A reference it has no field for (envFrom, a
     * volume) is recorded as such, so a new kind of reader fails the match.
     */
    const secretRefs = (items: Workload[]): SecretRef[] =>
      items
        .flatMap((w) => {
          const pod = w.spec.template.spec;
          const workload = id(w);
          const namespace = w.metadata.namespace;
          return [
            ...[...(pod.containers ?? []), ...(pod.initContainers ?? [])].flatMap((c) => [
              ...(c.env ?? []).flatMap(({ valueFrom }) => {
                const ref = valueFrom?.secretKeyRef;
                if (!ref) return [];
                return [
                  {
                    workload,
                    namespace,
                    secret: ref.name,
                    key: ref.key,
                    ...(ref.optional && { optional: true }),
                  },
                ];
              }),
              ...(c.envFrom ?? [])
                .filter(({ secretRef }) => secretRef)
                .map(({ secretRef }) => ({
                  workload,
                  namespace,
                  secret: secretRef?.name ?? '',
                  key: '(envFrom)',
                })),
            ]),
            ...(pod.volumes ?? [])
              .filter((v) => v.secret || v.projected)
              .map((v) => ({
                workload,
                namespace,
                secret: v.secret?.secretName ?? '(projected)',
                key: '(volume)',
              })),
          ];
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const byJson = (refs: SecretRef[]) =>
      [...refs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    describe.each(K8S_PROVIDERS)('%s', (providerId, Provider) => {
      let script: string;
      let installed: Workload[];
      const legacy = masterInitSecrets(LEGACY_MASTER_INIT_SECRETS[providerId]);

      // What the boot script installs besides the Secrets: upstream's cloud
      // controller and CSI driver, from the URLs it applies them from.
      beforeAll(async () => {
        script = await Provider.getK8sMasterUserData({});
        const urls = manifestUrls(script);
        expect(urls.length, 'the boot script applies upstream manifests').toBeGreaterThan(0);
        const before = new Set(workloads().map(id));
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
        installed = workloads().filter((w) => !before.has(id(w)));
        // No node runs their pods, and a rotation waits for each restarted
        // reader's rollout: at zero replicas one finishes at once. What this
        // file checks is the Secrets and which workloads were restarted;
        // pods on a node are k8s-secret-readers-restart.test.ts's.
        const scalable = installed.filter((w) => w.kind !== 'DaemonSet').map(id);
        if (scalable.length > 0) {
          kube(['-n', 'kube-system', 'scale', ...scalable, '--replicas=0']);
        }
      }, LONG);

      // Its API answered here: every token sees the master. The check that a
      // token sees the cluster is the unit tests' (k8s-cloud-secrets.test.ts);
      // this file reaches no provider.
      const Seeing = class extends Provider {
        async getServer(id: string) {
          return { id };
        }
      };
      const hand = (token: string) =>
        applyCloudSecrets({
          env: { ...process.env, KUBECONFIG: kubeconfig },
          ProviderClass: Seeing,
          token,
          masterId: '4242',
          environment: 'test',
        });
      const expected = (token: string) => Provider.k8sCloudSecrets({ token });
      /** Whether the cluster holds a Secret. */
      const holds = (namespace: string, name: string) =>
        kube([
          '-n',
          namespace,
          'get',
          'secret',
          name,
          '--ignore-not-found',
          '-o',
          'name',
        ]).trim() !== '';

      /**
       * An old master: the old boot script's Secrets as it created them and
       * no restart stamped on any workload, whatever the test before left.
       */
      const oldMaster = () => {
        for (const { namespace, name } of [...legacy, ...expected(BOOT_TOKEN)]) {
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
        for (const { namespace, name, keys, command } of legacy) {
          const vars = Object.fromEntries(Object.values(keys).map((v) => [v, bootValue(v)]));
          must('docker', ['exec', '-i', NODE, 'sh', '-eu'], renderScript(command, vars));
          expect(read(namespace, name).managers).toEqual(['kubectl-client-side-apply:Update']);
        }
        expect(restarted()).toEqual([]);
      };

      it('what upstream reads is what the census records', () => {
        expect(manifestUrls(script)).toEqual(CLOUD_SECRET_READERS[providerId].manifests);
        expect(secretRefs(installed)).toEqual(byJson(CLOUD_SECRET_READERS[providerId].refs));
      });

      it(
        'takes over what the old boot script made, with no conflict, keeps only what it writes, and restarts nothing',
        async () => {
          oldMaster();
          for (const { namespace, name } of expected(BOOT_TOKEN)) {
            expect(read(namespace, name).annotations).toHaveProperty([LAST_APPLIED]);
          }
          await hand(BOOT_TOKEN);
          // A Secret it no longer writes is gone, and one it does holds only
          // the keys it writes: nothing reads the rest.
          for (const { namespace, name } of legacy) {
            const kept = expected(BOOT_TOKEN).some(
              (w) => w.namespace === namespace && w.name === name,
            );
            expect(holds(namespace, name), `${namespace}/${name}`).toBe(kept);
          }
          for (const { namespace, name, stringData } of expected(BOOT_TOKEN)) {
            const secret = read(namespace, name);
            expect(secret.data).toEqual(stringData);
            expect(secret.managers).toContain('vibecarbon-cli:Apply');
            // The boot script's client-side record of what it applied, token
            // and all, goes with the takeover, whatever the kubectl: 1.26 and
            // later drop it as they move its fields to the server-side
            // manager, and for 1.24 and 1.25, which keep it (measured against
            // this k3s, 2026-11-11), applyCloudSecrets removes it.
            expect(secret.annotations).not.toHaveProperty([LAST_APPLIED]);
          }
          expect(restarted()).toEqual([]);
        },
        LONG,
      );

      it(
        'leaves an unchanged Secret alone, resourceVersion included, and restarts nothing',
        async () => {
          oldMaster();
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
          oldMaster();
          await hand(ROTATED_TOKEN);
          for (const { namespace, name, stringData } of expected(ROTATED_TOKEN)) {
            expect(read(namespace, name).data).toEqual(stringData);
            // The replaced token is nowhere in the Secret, metadata included.
            const whole = kube(['-n', namespace, 'get', 'secret', name, '-o', 'json']);
            expect(whole).not.toContain(BOOT_TOKEN);
            expect(whole).not.toContain(Buffer.from(BOOT_TOKEN).toString('base64'));
          }
          expect(restarted()).toEqual(READERS[providerId]);
        },
        LONG,
      );

      it(
        'creates the Secrets a new master lacks, and restarts nothing',
        async () => {
          // A master the current boot script booted: no cloud Secret at all.
          oldMaster();
          for (const { namespace, name } of legacy) {
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

      it.runIf(Provider.K8S_RETIRED_CLOUD_SECRETS.length > 0)(
        'removes what the apply alone leaves: a Secret it stopped sending, a key an earlier apply set',
        async () => {
          // The cluster as an earlier CLI left it: its server-side apply sent
          // every key the old boot script set, through stringData.
          oldMaster();
          const ssa = (docs: { namespace: string; name: string; stringData: object }[]) =>
            kube(
              [...CLOUD_SECRETS_APPLY_ARGV],
              docs
                .map(({ namespace, name, stringData }) =>
                  [
                    'apiVersion: v1',
                    'kind: Secret',
                    `metadata: {name: ${name}, namespace: ${namespace}}`,
                    `stringData: ${JSON.stringify(stringData)}`,
                  ].join('\n'),
                )
                .join('\n---\n'),
            );
          ssa(
            legacy.map(({ namespace, name, keys }) => ({
              namespace,
              name,
              stringData: Object.fromEntries(
                Object.entries(keys).map(([key, variable]) => [key, bootValue(variable)]),
              ),
            })),
          );
          // The premise: an apply of only what the CLI writes now leaves both.
          ssa(expected(BOOT_TOKEN));
          const retired = Provider.K8S_RETIRED_CLOUD_SECRETS;
          for (const { namespace, name, keys } of retired) {
            if (!keys) expect(holds(namespace, name), `${namespace}/${name}`).toBe(true);
            else
              expect(Object.keys(read(namespace, name).data)).toEqual(expect.arrayContaining(keys));
          }
          // A deploy removes them.
          await hand(BOOT_TOKEN);
          for (const { namespace, name, keys } of retired) {
            if (!keys) expect(holds(namespace, name), `${namespace}/${name}`).toBe(false);
          }
          for (const { namespace, name, stringData } of expected(BOOT_TOKEN)) {
            expect(read(namespace, name).data).toEqual(stringData);
          }
          expect(restarted()).toEqual([]);
        },
        LONG,
      );

      it.runIf(Provider.K8S_RETIRED_CLOUD_SECRETS.some((r) => r.keys))(
        'a retired key the takeover drops is never called kept, though something reads it',
        async () => {
          oldMaster();
          // An operator's own workload reading each retired key, at zero
          // replicas: removeRetired keeps a key something reads, but the
          // takeover apply may already have dropped it.
          const keyed = Provider.K8S_RETIRED_CLOUD_SECRETS.flatMap(({ namespace, name, keys }) =>
            (keys ?? []).map((key) => ({ namespace, name, key, app: `vctest-reads-${key}` })),
          );
          const readers = keyed.map(({ namespace, name, key, app }) => ({
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: app, namespace },
            spec: {
              replicas: 0,
              selector: { matchLabels: { app } },
              template: {
                metadata: { labels: { app } },
                spec: {
                  containers: [
                    {
                      name: 'c',
                      image: 'busybox',
                      env: [{ name: 'V', valueFrom: { secretKeyRef: { name, key } } }],
                    },
                  ],
                },
              },
            },
          }));
          kube(
            ['apply', '-f', '-'],
            JSON.stringify({ apiVersion: 'v1', kind: 'List', items: readers }),
          );
          const lines: string[] = [];
          vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            lines.push(args.map(String).join(' '));
          });
          try {
            await hand(BOOT_TOKEN);
          } finally {
            for (const { namespace, app } of keyed) {
              kube(['-n', namespace, 'delete', 'deployment', app, '--ignore-not-found']);
            }
          }
          // kubectl 1.26 and later drop it in the takeover; 1.24 and 1.25 leave it.
          const minor = Number(
            JSON.parse(must('kubectl', ['version', '--client', '-o', 'json'])).clientVersion.minor,
          );
          for (const { namespace, name, key, app } of keyed) {
            const kept = `Kept the ${key} key in ${namespace}/${name}`;
            expect(key in read(namespace, name).data).toBe(minor < 26);
            if (key in read(namespace, name).data) {
              // kubectl 1.24 and 1.25 leave it: it stays while read.
              expect(lines.join('\n')).toContain(kept);
            } else {
              expect(lines.join('\n')).not.toContain(kept);
              expect(lines.join('\n')).toContain(
                `The apply took the ${key} key out of ${namespace}/${name} (kubectl 1.26 and ` +
                  "later drop a key an earlier vibecarbon's boot script set once a deploy takes " +
                  `its Secret over), and deployment/${app} still reads it`,
              );
            }
          }
        },
        LONG,
      );

      it(
        'wins over another server-side owner of the same keys (--force-conflicts)',
        async () => {
          oldMaster();
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
