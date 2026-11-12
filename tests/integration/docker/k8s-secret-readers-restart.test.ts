/**
 * What a cloud Secret's readers do when the CLI hands the token over, on a
 * cluster that runs pods.
 *
 * The cloud controller and CSI driver read the provider API token from a
 * kube-system Secret when they start (applyCloudSecrets). How their pods
 * come up around the CLI's apply is the scheduler's, the kubelet's and the
 * workload controllers' business, so this asks them: the k3s release the CLI
 * installs (or VC_K3S_VERSION), a control plane and one agent node, the only
 * node pods can run on, and the kubectl on this machine, the one a deploy
 * runs. The readers here are stand-ins (busybox), built with the shapes that
 * matter: the workload kind, its update strategy, and whether its pods take
 * ports on their node.
 *
 * - A Secret this deploy creates: its readers have waited for it since the
 *   master booted, and the kubelet starts each waiting pod on its own retry.
 *   The CLI restarts nothing, so each starts once. (A restart there started a
 *   StatefulSet's pod twice, and ran a Deployment's waiting pod beside its
 *   replacement.)
 * - A rotated token: the CLI restarts what reads it and waits for each
 *   rollout. A Deployment whose pods take a port on their node (hostNetwork,
 *   or a hostPort) cannot run its new pod beside the old one there: the new
 *   one cannot bind or is never scheduled, the default rolling update keeps
 *   the old one, and that one holds the old token. So the CLI moves such a
 *   reader to the Recreate strategy first, and each ends with its new pod
 *   alone. The DigitalOcean CCM is one (hostNetwork, upstream's default
 *   strategy, `--leader-elect=false`): a stand-in built from upstream's own
 *   manifest, holding the port the CCM serves on, is rotated the same way.
 *
 * Needs Docker and kubectl. Images are loaded into the node from this
 * machine's Docker (pulled once if missing), so nothing is pulled in the
 * cluster. Every container and network here is named vctest-* and removed
 * in afterAll.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCloudSecrets } from '../../../src/lib/deploy/k8s/k3s.js';
import { k3sVersion } from '../../../src/lib/images.js';
import { BaseProvider } from '../../../src/lib/providers/base.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { CLOUD_SECRET_READERS } from '../../_shared/cloud-secret-readers.js';

const SKIPPED =
  process.env.DOCKER_INTEGRATION === 'true'
    ? null
    : 'skipped: needs Docker and kubectl; run it with DOCKER_INTEGRATION=true (pnpm test:docker)';
if (SKIPPED) console.info(`k8s-secret-readers-restart: ${SKIPPED}`);

const VERSION = process.env.VC_K3S_VERSION || k3sVersion();
const IMAGE = `rancher/k3s:${VERSION.replace('+', '-')}`;
const NET = `vctest-readers-net-${process.pid}`;
const SERVER = `vctest-readers-server-${process.pid}`;
const AGENT = `vctest-readers-agent-${process.pid}`;
const SERVER_IP = '10.0.37.1';
const AGENT_IP = '10.0.37.10';
const K3S_TOKEN = 'vctest-readers-join-token-8e21';
const BUSYBOX = 'busybox:1.38';
/** Where the stand-in readers live; the Secrets they read are in it too. */
const NS = 'vctest-readers';
const TOKEN_A = 'vc-sentinel-token-readers-a';
const TOKEN_B = 'vc-sentinel-token-readers-b';
/** cloud-controller-manager's default secure port, which the DigitalOcean CCM serves on. */
const CCM_PORT = '10258';
const LONG = 240_000;

const run = (cmd: string, args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv) =>
  spawnSync(cmd, args, { input, env, timeout: LONG, maxBuffer: 512 * 1024 * 1024 });
const must = (cmd: string, args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv) => {
  const r = run(cmd, args, input, env);
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.slice(0, 4).join(' ')} exited ${r.status}: ${String(r.stderr).trim()}`,
    );
  }
  return String(r.stdout);
};
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (what: string, probe: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    sleepSync(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** The cluster's master, as the provisioning recorded it. */
const MASTER_ID = '4242';

/**
 * `Provider` with its API answered here: every token sees the master. The
 * check that a token sees the cluster (assertTokenSeesCluster) is the unit
 * tests'; this file reaches no provider.
 */
const seeing = <P extends typeof BaseProvider>(Provider: P) =>
  class extends Provider {
    async getServer(id: string) {
      return { id };
    }
  };

/** A provider whose token goes into one Secret in NS, named `secret`. */
const providerFor = (secret: string) =>
  seeing(
    class extends BaseProvider {
      static NAME = 'Test Cloud';
      static TOKEN_ENV = 'VCTEST_TOKEN';
      static k8sCloudSecrets({ token }: { token: string }) {
        return [{ namespace: NS, name: secret, stringData: { token } }];
      }
    },
  );

type Pod = {
  metadata: { name: string; uid: string; deletionTimestamp?: string };
  status: {
    phase: string;
    containerStatuses?: {
      ready: boolean;
      restartCount: number;
      state: { waiting?: { reason: string } };
    }[];
  };
};

describe.skipIf(SKIPPED)(`a cloud Secret's readers, on a node (k3s ${VERSION})`, () => {
  let dir: string;
  let kubeconfig: string;
  const kube = (args: string[], input?: string) =>
    must('kubectl', args, input, { ...process.env, KUBECONFIG: kubeconfig });
  const pods = (app: string, ns = NS): Pod[] =>
    JSON.parse(kube(['-n', ns, 'get', 'pods', '-l', `app=${app}`, '-o', 'json'])).items;
  const workload = (id: string, ns = NS) => JSON.parse(kube(['-n', ns, 'get', id, '-o', 'json']));
  const template = (id: string) => workload(id).spec.template;
  const handTo = (ProviderClass: typeof BaseProvider, token: string) =>
    applyCloudSecrets({
      env: { ...process.env, KUBECONFIG: kubeconfig },
      ProviderClass,
      token,
      masterId: MASTER_ID,
      environment: 'test',
    });
  const hand = (secret: string, token: string) => handTo(providerFor(secret), token);

  /**
   * After a rotation: each app's one pod is a new one, running and ready,
   * never restarted (a second pod that could not bind would have been), and
   * the old one is gone.
   */
  const onlyNewPods = (before: Record<string, string>, ns = NS) => {
    waitFor(
      'the old pods to go',
      () => Object.keys(before).every((app) => pods(app, ns).length === 1),
      60_000,
    );
    for (const [app, oldUid] of Object.entries(before)) {
      const [pod] = pods(app, ns);
      expect(pod.metadata.uid, `${app}: a new pod`).not.toBe(oldUid);
      expect(pod.status.phase, app).toBe('Running');
      expect(pod.status.containerStatuses?.[0]?.ready, app).toBe(true);
      expect(pod.status.containerStatuses?.[0]?.restartCount, app).toBe(0);
    }
  };
  const uidOf = (app: string, ns = NS) => {
    const all = pods(app, ns);
    expect(all, app).toHaveLength(1);
    return all[0].metadata.uid;
  };

  /**
   * A stand-in reader of `secret`'s token: busybox running `command`, one
   * replica, labelled app=<name>. `pod`, `container` and `spec` add to its
   * pod spec, its one container and the workload's spec.
   */
  const reader = ({
    kind,
    name,
    secret,
    command,
    pod = {},
    container = {},
    spec = {},
  }: {
    kind: 'Deployment' | 'StatefulSet';
    name: string;
    secret: string;
    command: string[];
    pod?: Record<string, unknown>;
    container?: Record<string, unknown>;
    spec?: Record<string, unknown>;
  }) => ({
    apiVersion: 'apps/v1',
    kind,
    metadata: { name, namespace: NS },
    spec: {
      replicas: 1,
      ...(kind === 'StatefulSet' && { serviceName: name }),
      selector: { matchLabels: { app: name } },
      ...spec,
      template: {
        metadata: { labels: { app: name } },
        spec: {
          // busybox as PID 1 ignores SIGTERM: without this every pod takes
          // the default 30 s to go.
          terminationGracePeriodSeconds: 2,
          ...pod,
          containers: [
            {
              name: 'reader',
              image: BUSYBOX,
              imagePullPolicy: 'Never',
              command,
              env: [{ name: 'TOKEN', valueFrom: { secretKeyRef: { name: secret, key: 'token' } } }],
              ...container,
            },
          ],
        },
      },
    },
  });
  const applyJson = (objects: object[]) =>
    kube(['apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }));

  beforeAll(() => {
    expect(run('kubectl', ['version', '--client']).status, 'kubectl on PATH').toBe(0);
    dir = mkdtempSync(join(tmpdir(), 'vctest-readers-'));
    must('docker', [
      'network',
      'create',
      '--subnet',
      '10.0.37.0/24',
      '--gateway',
      '10.0.37.254',
      NET,
    ]);
    const node = (name: string, ip: string, extra: string[], args: string[]) =>
      must('docker', [
        'run',
        '-d',
        '--privileged',
        '--name',
        name,
        '--hostname',
        name,
        '--network',
        NET,
        '--ip',
        ip,
        '--tmpfs',
        '/run',
        '--tmpfs',
        '/var/run',
        ...extra,
        IMAGE,
        ...args,
      ]);
    node(
      SERVER,
      SERVER_IP,
      ['-p', '127.0.0.1::6443'],
      [
        'server',
        // Pods run on the agent alone, so a reader's old and new pods share
        // one node, as on a cluster whose CCM can run on its master only.
        '--disable-agent',
        '--disable',
        'coredns,servicelb,traefik,local-storage,metrics-server',
        '--token',
        K3S_TOKEN,
        '--tls-san',
        '127.0.0.1',
      ],
    );
    waitFor(
      'the k3s apiserver',
      () =>
        String(run('docker', ['exec', SERVER, 'kubectl', 'get', '--raw', '/readyz']).stdout) ===
        'ok',
      120_000,
    );
    node(
      AGENT,
      AGENT_IP,
      ['-v', '/var/lib/rancher/k3s', '-e', `K3S_URL=https://${SERVER_IP}:6443`],
      ['agent', '--token', K3S_TOKEN, '--node-name', AGENT],
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
    waitFor(
      `${AGENT} to go Ready`,
      () =>
        String(
          run(
            'kubectl',
            [
              'get',
              'node',
              AGENT,
              '-o',
              'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
            ],
            undefined,
            { ...process.env, KUBECONFIG: kubeconfig },
          ).stdout,
        ) === 'True',
      120_000,
    );
    // The sandbox image and busybox, from this machine: nothing is pulled in
    // the cluster.
    const pause = must('docker', ['exec', AGENT, 'k3s', 'agent', '--help']).match(
      /--pause-image value[^\n]*default: "([^"]+)"/,
    )?.[1];
    expect(pause, 'the pause image k3s runs pods with').toBeTruthy();
    for (const image of [BUSYBOX, pause as string]) {
      if (run('docker', ['image', 'inspect', image]).status !== 0) must('docker', ['pull', image]);
    }
    const tar = run('docker', ['save', BUSYBOX, pause as string]);
    expect(tar.status, String(tar.stderr)).toBe(0);
    must(
      'docker',
      ['exec', '-i', AGENT, 'ctr', '-n', 'k8s.io', 'images', 'import', '-'],
      tar.stdout,
    );
    kube(['create', 'namespace', NS]);
  }, LONG);

  afterAll(() => {
    run('docker', ['rm', '-f', '-v', SERVER, AGENT]);
    run('docker', ['network', 'rm', NET]);
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

  it(
    'a Secret this deploy creates: each reader waiting for it starts once, as the kubelet starts it',
    async () => {
      const secret = 'vctest-created';
      applyJson([
        reader({ kind: 'StatefulSet', name: 'waits-sts', secret, command: ['sleep', '36000'] }),
        reader({ kind: 'Deployment', name: 'waits-deploy', secret, command: ['sleep', '36000'] }),
      ]);
      const apps = ['waits-sts', 'waits-deploy'];
      // Each pod waits for the Secret, as the CCM and CSI do on a new master.
      waitFor(
        'the readers to wait for their Secret',
        () =>
          apps.every((app) =>
            pods(app).some(
              (p) =>
                p.status.containerStatuses?.[0]?.state.waiting?.reason ===
                'CreateContainerConfigError',
            ),
          ),
        LONG,
      );
      const waiting = Object.fromEntries(
        apps.map((app) => [app, pods(app).map((p) => p.metadata.uid)]),
      );
      expect(Object.values(waiting).map((uids) => uids.length)).toEqual([1, 1]);

      await hand(secret, TOKEN_A);

      kube([
        '-n',
        NS,
        'rollout',
        'status',
        'statefulset/waits-sts',
        'deployment/waits-deploy',
        '--timeout=120s',
      ]);
      for (const app of apps) {
        const now = pods(app);
        // The pod that waited is the pod that runs: none replaced it, and
        // none ran beside it.
        expect(
          now.map((p) => p.metadata.uid),
          app,
        ).toEqual(waiting[app]);
        expect(now[0].status.phase, app).toBe('Running');
        expect(now[0].status.containerStatuses?.[0]?.restartCount, app).toBe(0);
      }
      for (const workload of ['statefulset/waits-sts', 'deployment/waits-deploy']) {
        expect(template(workload).metadata?.annotations ?? {}, workload).not.toHaveProperty([
          'kubectl.kubernetes.io/restartedAt',
        ]);
      }
    },
    LONG,
  );

  it(
    'a rotated token: a reader that takes a port on its node ends with its new pod alone',
    async () => {
      const secret = 'vctest-rotated';
      await hand(secret, TOKEN_A);
      // hostNetwork with no port declared, as the DigitalOcean CCM: the
      // scheduler cannot see the port, so a second pod lands beside the first
      // and cannot bind. And a declared hostPort: the scheduler sees it, so a
      // second pod is never scheduled.
      applyJson([
        reader({
          kind: 'Deployment',
          name: 'host-net',
          secret,
          command: ['httpd', '-f', '-p', '18258'],
          pod: { hostNetwork: true },
        }),
        reader({
          kind: 'Deployment',
          name: 'host-port',
          secret,
          command: ['httpd', '-f', '-p', '18259'],
          container: { ports: [{ containerPort: 18259, hostPort: 18259 }] },
        }),
      ]);
      kube([
        '-n',
        NS,
        'rollout',
        'status',
        'deployment/host-net',
        'deployment/host-port',
        '--timeout=120s',
      ]);
      const before = { 'host-net': uidOf('host-net'), 'host-port': uidOf('host-port') };

      await hand(secret, TOKEN_B);

      onlyNewPods(before);
      for (const id of ['deployment/host-net', 'deployment/host-port']) {
        expect(workload(id).spec.strategy, id).toEqual({ type: 'Recreate' });
      }
    },
    LONG * 2,
  );

  it(
    "a rotated token: the DigitalOcean CCM's shape, from upstream's manifest, ends with its new pod alone",
    async () => {
      const [url] = CLOUD_SECRET_READERS.digitalocean.manifests;
      const response = await fetch(url);
      expect(response.ok, url).toBe(true);
      // biome-ignore lint/suspicious/noExplicitAny: upstream's whole manifest, read field by field below
      const ccm = (loadAll(await response.text()) as Record<string, any>[]).find(
        (doc) => doc?.kind === 'Deployment' && doc.metadata.name.includes('cloud-controller'),
      );
      expect(ccm, 'the CCM Deployment').toBeTruthy();
      const pod = ccm?.spec.template.spec;
      // The shape this case is about, as upstream ships it.
      expect(pod.hostNetwork).toBe(true);
      expect(ccm?.spec.strategy).toBeUndefined();
      expect(ccm?.spec.replicas).toBe(1);
      expect(JSON.stringify(pod.containers)).toContain('--leader-elect=false');
      // Upstream's Deployment with a stand-in in each container: busybox
      // holding the port the CCM serves on, reading the same Secret key.
      const standIn = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: ccm?.metadata.name, namespace: ccm?.metadata.namespace },
        spec: {
          replicas: ccm?.spec.replicas,
          selector: ccm?.spec.selector,
          template: {
            metadata: { labels: ccm?.spec.template.metadata.labels },
            spec: {
              hostNetwork: pod.hostNetwork,
              dnsPolicy: pod.dnsPolicy,
              tolerations: pod.tolerations,
              terminationGracePeriodSeconds: 2,
              containers: pod.containers.map((c: Record<string, unknown>) => ({
                name: c.name,
                image: BUSYBOX,
                imagePullPolicy: 'Never',
                command: ['httpd', '-f', '-p', CCM_PORT],
                env: c.env,
                ...(c.ports ? { ports: c.ports } : {}),
              })),
            },
          },
        },
      };
      const DigitalOcean = seeing(PROVIDERS.digitalocean);
      await handTo(DigitalOcean, TOKEN_A);
      applyJson([standIn]);
      const ns = ccm?.metadata.namespace;
      const app = ccm?.spec.template.metadata.labels.app;
      const id = `deployment/${ccm?.metadata.name}`;
      kube(['-n', ns, 'rollout', 'status', id, '--timeout=120s']);
      const before = { [app]: uidOf(app, ns) };

      await handTo(DigitalOcean, TOKEN_B);

      onlyNewPods(before, ns);
      expect(workload(id, ns).spec.strategy).toEqual({ type: 'Recreate' });
    },
    LONG * 2,
  );
});
