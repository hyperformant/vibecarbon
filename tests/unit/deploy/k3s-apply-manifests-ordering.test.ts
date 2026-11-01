import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEPLOY_OWNED_CERTIFICATES } from '../../../src/lib/deploy/k8s/acme-order-recovery.js';
import { namesHost } from '../../_shared/hosts.js';

/**
 * Integration-style unit tests for applyK3sManifests deploy-time behavior:
 *
 *   #1 — the one image delivery (deliverImage: a layer delta into the
 *        master, then `ctr images push` into its registry) starts after the
 *        registry pod is Ready and runs CONCURRENTLY with the CA apply, the
 *        observability apply and the CA rollout, and is AWAITED before the
 *        deployment/app patch, the first reference to the tag, so a failed
 *        delivery fails the deploy before any pod asks for the image.
 *
 *   #2 — the carbon-autoscaler config Secret is applied via stdin as PLAIN
 *        JSON (Task 8: retired the old base64-encoded legacy CA config
 *        Secret + the `--nodes`/HCLOUD_* argv-and-env patch entirely), the
 *        sidecar image placeholder is patched via `set image` AFTER
 *        `apply -k cluster-autoscaler`, and exactly one rollout status wait
 *        gates the roll (no `--nodes=` patch, no HCLOUD_* env upsert).
 *
 * Every shell-out in applyK3sManifests ultimately reaches node's `spawn` —
 * either directly (cert-manager wait, rollout status,
 * kubectl exec, port-forward) or via command.js `runCommandAsync`
 * (kubectl/helm/docker-tag/pkill). So mocking ONLY `spawn` drives the whole
 * function: the fake child succeeds everywhere and captures every stdin
 * write (so tests can inspect the Secret YAML piped via `apply -f -`).
 * retry.js / perf.js / command.js / fs stay real; the temp projectDir carries
 * the real db StatefulSet that renderK8sBase reads. The image delivery is the
 * one exception: deliverImage (layer-delta.js) is mocked, so its own ssh and
 * `docker save` children never reach the spawn mock; its call is logged into
 * cmdCalls as ['deliverImage'] so it orders against the kubectl calls.
 *
 * Admin: applyK3sManifests no longer provisions an account. It waits for
 * the app to report its super admin ready (`kubectl exec deploy/app … node
 * -e`, see awaitAppAdminReady), which the spawn mock answers with exit 0.
 */

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

// The one app image delivery. Its transport is layer-delta.test.ts's subject;
// here only where it starts and where it is awaited matter.
const deliverImage = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/deploy/layer-delta.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  deliverImage,
}));

// The TLS restore before `apply -k base` reads the env's snapshot from S3;
// here there is never one, so no test opens a socket.
vi.mock('../../../src/lib/deploy/tls-snapshot.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    readTlsSnapshot: vi.fn(async () => ({ text: null, reason: 'no snapshot' })),
  };
});

const k3sPromise = import('../../../src/lib/deploy/k8s/k3s.js');
const { RETIRED_CHART_DB_STATEFULSET, RETIRED_CHART_RELEASE } = await k3sPromise;

// Ordered log of every spawn argv ([executable, ...args]).
let cmdCalls: string[][] = [];
// Ordered log of every stdin write, paired with the argv of the call it
// belongs to — lets tests inspect Secret YAML piped via `apply -f -`
// (kubectl argv never carries the secret payload itself). `seq` is the
// cmdCalls index of the owning spawn, so a piped call can be ordered against
// argv-only calls; runCommandAsync writes stdin synchronously after spawn
// returns, so no other spawn can slip in between.
let stdinCalls: { argv: string[]; data: string; seq: number }[] = [];
// Per-Secret resourceVersion stdout; unset = "1", an empty string is unreadable.
let secretVersionOut: Record<string, string> = {};
// A manual gate the image delivery waits on (concurrency test).
let deliverGate: { promise: Promise<void>; release: () => void } | null = null;
// What the image delivery rejects with, or null for success.
let deliverError: Error | null = null;
// Exit codes for the cert-manager DNS-01 webhook install pair (helm install /
// kubectl wait) — drives the fail-loud tests below.
let webhookHelmExit = 0;
let webhookWaitExit = 0;
// Exit code of `kubectl rollout status deployment/local-registry`, and the
// cluster events read when it fails (the mirror-pull diagnosis).
let registryRolloutExit = 0;
let eventsOut = '';
// Exit code of the in-container /api/health probe (`kubectl exec deploy/app
// … node -e`), and whether `kubectl rollout status deployment/app` hangs
// (never exits, as when readiness stays 503) — drive the migration-failure
// short-circuit test.
let appProbeExit = 0;
let rolloutHangs = false;
// Gates on the cert-manager core readiness wait and on the cluster-autoscaler
// rollout status, and the latter's exit code: drive the CA-overlap tests.
let certManagerWaitGate: Promise<void> | null = null;
let caRolloutGate: Promise<void> | null = null;
let caRolloutExit = 0;
// Children killed through their abort signal (argv), in order.
let killed: string[][] = [];
// Exit code of `kubectl wait deploy/cert-manager` (drives a main-chain failure).
let certManagerWaitExit = 0;
// The rendered registry manifest as `kubectl apply -k <rendered base>` saw it
// (the rendered copy is removed right after the apply).
let registryAtBaseApply: string | null = null;
// The rendered vibecarbon-tls Certificate as `kubectl apply -k <rendered
// base>` saw it, parsed.
// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
let certificateAtBaseApply: any = null;

function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/**
 * Universal fake child compatible with both command.js runCommandAsync
 * (settles on 'close', reads stdout/stderr when silent, writes stdin) and the
 * hand-rolled spawns in k3s.js (settle on 'exit', read stderr). Emits `stdout`
 * / `stderr` data to any registered listener; fires 'exit' AND 'close' with
 * `exitCode` on a microtask — unless `gate` is supplied, in which case it waits
 * for the gate first.
 */
function fakeChild({
  exitCode = 0,
  stdout = '',
  stderr = '',
  gate = null,
  argv = [],
  signal = null,
}: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  gate?: Promise<void> | null;
  argv?: string[];
  signal?: AbortSignal | null;
} = {}) {
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
    stdin: {
      write(data: unknown) {
        // cmdCalls already holds this call's own argv, so its index is
        // length-1 (see the stdinCalls declaration).
        stdinCalls.push({ argv, data: String(data), seq: cmdCalls.length - 1 });
      },
      end() {},
    },
    kill() {},
    unref() {},
    on(ev: string, cb: (...a: unknown[]) => void) {
      // Like node's spawn: an aborted signal kills the child and emits
      // 'error' (AbortError).
      if (ev === 'error' && signal) {
        const fire = () => {
          killed.push(argv);
          cb(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        };
        if (signal.aborted) Promise.resolve().then(fire);
        else signal.addEventListener('abort', fire, { once: true });
      }
      if (ev === 'exit' || ev === 'close') {
        if (gate) gate.then(() => cb(exitCode));
        else Promise.resolve().then(() => cb(exitCode));
      }
      return child;
    },
  };
  return child;
}

// `kubectl get nodes -o name` answer for the stale-worker reap (pilot
// standby). Default: no nodes reported — every unrelated test sees an empty
// cluster and the reap stays a no-op.
let getNodesOut = '';
// `kubectl get statefulset <retired chart db>` answer. Default: absent, so
// every test deploys onto a cluster with no chart-era database.
let retiredChartStsOut = '';
// The chart's Helm release record (a Secret), which outlives a deleted StatefulSet.
let retiredChartReleaseOut = '';
// Whether the cluster still carries the observability stack (namespace +
// grafana-tls) from a life as primary — the demoted-standby reconverge case.
// Default: absent, as on every freshly deployed cluster.
let leftoverObservability = false;

const APP_POD = 'app-6f7d9c-abcde';
const APP_RS_JSON = JSON.stringify({
  items: [
    {
      metadata: {
        annotations: { 'deployment.kubernetes.io/revision': '1' },
        labels: { 'pod-template-hash': '6f7d9c' },
      },
    },
  ],
});
const APP_PODS_JSON = JSON.stringify({
  items: [{ metadata: { name: APP_POD, creationTimestamp: '2026-10-16T05:00:00Z' } }],
});

function installSpawnMock() {
  vi.mocked(spawn).mockImplementation(((
    cmd: string,
    args: string[] = [],
    opts: { signal?: AbortSignal } = {},
  ) => {
    cmdCalls.push([cmd, ...(args ?? [])]);
    const argv = args ?? [];
    const full = [cmd, ...argv];
    if (cmd === 'kubectl' && argv.includes('apply') && argv.includes('-k')) {
      const target = String(argv[argv.indexOf('-k') + 1]);
      const registry = join(target, 'registry', 'local-registry.yaml');
      if (/k8s-base/.test(target) && existsSync(registry)) {
        registryAtBaseApply = readFileSync(registry, 'utf-8');
      }
      const certificate = join(target, 'traefik', 'certificate.yaml');
      if (/k8s-base/.test(target) && existsSync(certificate)) {
        certificateAtBaseApply = load(readFileSync(certificate, 'utf-8'));
      }
    }
    if (
      cmd === 'kubectl' &&
      argv.includes('get') &&
      argv.includes('nodes') &&
      argv.includes('-o')
    ) {
      return fakeChild({ exitCode: 0, stdout: getNodesOut, argv: full }) as unknown as ReturnType<
        typeof spawn
      >;
    }
    if (
      cmd === 'kubectl' &&
      argv.includes('statefulset') &&
      argv.includes(RETIRED_CHART_DB_STATEFULSET)
    ) {
      return fakeChild({
        exitCode: 0,
        stdout: retiredChartStsOut,
        argv: full,
      }) as unknown as ReturnType<typeof spawn>;
    }
    if (
      cmd === 'kubectl' &&
      argv.includes('secret') &&
      argv.includes(`owner=helm,name=${RETIRED_CHART_RELEASE}`)
    ) {
      return fakeChild({
        exitCode: 0,
        stdout: retiredChartReleaseOut,
        argv: full,
      }) as unknown as ReturnType<typeof spawn>;
    }
    if (
      leftoverObservability &&
      cmd === 'kubectl' &&
      argv.includes('get') &&
      argv.includes('--ignore-not-found') &&
      (argv.includes('vibecarbon-observability') || argv.includes('grafana-tls'))
    ) {
      const stdout = argv.includes('grafana-tls')
        ? 'certificate.cert-manager.io/grafana-tls\n'
        : 'namespace/vibecarbon-observability\n';
      return fakeChild({ stdout, argv: full }) as unknown as ReturnType<typeof spawn>;
    }
    if (
      cmd === 'kubectl' &&
      argv.includes('rollout') &&
      argv.includes('deployment/local-registry')
    ) {
      return fakeChild({ exitCode: registryRolloutExit, argv: full }) as unknown as ReturnType<
        typeof spawn
      >;
    }
    if (
      (certManagerWaitGate || certManagerWaitExit) &&
      cmd === 'kubectl' &&
      argv.includes('wait') &&
      argv.includes('deploy/cert-manager')
    ) {
      return fakeChild({
        gate: certManagerWaitGate,
        exitCode: certManagerWaitExit,
        argv: full,
      }) as unknown as ReturnType<typeof spawn>;
    }
    if (
      cmd === 'kubectl' &&
      argv.includes('rollout') &&
      argv.includes('status') &&
      argv.includes('deploy/cluster-autoscaler')
    ) {
      return fakeChild({
        gate: caRolloutGate,
        signal: opts?.signal ?? null,
        exitCode: caRolloutExit,
        stderr: caRolloutExit
          ? 'error: deployment "cluster-autoscaler" exceeded its progress deadline'
          : '',
        argv: full,
      }) as unknown as ReturnType<typeof spawn>;
    }
    if (cmd === 'kubectl' && argv.includes('get') && argv.includes('events')) {
      return fakeChild({ stdout: eventsOut, argv: full }) as unknown as ReturnType<typeof spawn>;
    }
    if (cmd === 'helm' && argv[0] === 'upgrade' && argv.includes('cert-manager-webhook-hetzner')) {
      return fakeChild({ exitCode: webhookHelmExit, argv: full }) as unknown as ReturnType<
        typeof spawn
      >;
    }
    if (
      cmd === 'kubectl' &&
      argv.includes('wait') &&
      argv.includes('deploy/cert-manager-webhook-hetzner')
    ) {
      return fakeChild({ exitCode: webhookWaitExit, argv: full }) as unknown as ReturnType<
        typeof spawn
      >;
    }
    // The migration watch resolves the rollout's newest pod first
    // (readiness.js newestAppPod): one current ReplicaSet, one pod.
    if (
      cmd === 'kubectl' &&
      argv.includes('get') &&
      argv.includes('secret') &&
      argv.includes('jsonpath={.metadata.resourceVersion}')
    ) {
      const name = String(argv[argv.indexOf('secret') + 1]);
      return fakeChild({
        stdout: secretVersionOut[name] ?? '1',
        argv: full,
      }) as unknown as ReturnType<typeof spawn>;
    }
    if (cmd === 'kubectl' && argv.includes('get') && argv.includes('replicasets')) {
      return fakeChild({ stdout: APP_RS_JSON, argv: full }) as unknown as ReturnType<typeof spawn>;
    }
    if (cmd === 'kubectl' && argv.includes('get') && argv.includes('pods')) {
      return fakeChild({ stdout: APP_PODS_JSON, argv: full }) as unknown as ReturnType<
        typeof spawn
      >;
    }
    if (
      cmd === 'kubectl' &&
      argv.includes('exec') &&
      (argv.includes('deploy/app') || argv.includes(`pod/${APP_POD}`)) &&
      argv.includes('node')
    ) {
      return fakeChild({ exitCode: appProbeExit, argv: full }) as unknown as ReturnType<
        typeof spawn
      >;
    }
    if (
      rolloutHangs &&
      cmd === 'kubectl' &&
      argv.includes('rollout') &&
      argv.includes('status') &&
      argv.includes('deployment/app')
    ) {
      return fakeChild({ gate: new Promise<void>(() => {}), argv: full }) as unknown as ReturnType<
        typeof spawn
      >;
    }
    // RLS audit after the app migrated (auditRls, -tAc). Empty stdout = clean
    // schema (no public tables without RLS) so the audit passes — a non-empty
    // result would be read as a list of unprotected tables and abort the deploy.
    if (cmd === 'kubectl' && argv.includes('exec') && argv.includes('-tAc')) {
      return fakeChild({ stdout: '', argv: full }) as unknown as ReturnType<typeof spawn>;
    }
    // Other kubectl exec probes (psql) read '1' as the ready signal.
    const isExec = cmd === 'kubectl' && argv.includes('exec');
    return fakeChild({ stdout: isExec ? '1\n' : '', argv: full }) as unknown as ReturnType<
      typeof spawn
    >;
  }) as unknown as typeof spawn);
}

function makeProjectDir({ withObservability = false, withRegistry = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-k3s-apply-'));
  // renderK8sBase refuses a base without the db StatefulSet, so the project
  // carries the real one, as `create` lays it down.
  mkdirSync(join(dir, 'k8s', 'base', 'db'), { recursive: true });
  writeFileSync(join(dir, 'k8s', 'base', 'kustomization.yaml'), 'resources:\n  - db/\n');
  writeFileSync(
    join(dir, 'k8s', 'base', 'db', 'statefulset.yaml'),
    readFileSync(join(__dirname, '../../../carbon/k8s/base/db/statefulset.yaml'), 'utf-8'),
  );
  if (withRegistry) {
    mkdirSync(join(dir, 'k8s', 'base', 'registry'), { recursive: true });
    writeFileSync(
      join(dir, 'k8s', 'base', 'registry', 'local-registry.yaml'),
      readFileSync(
        join(__dirname, '../../../carbon/k8s/base/registry/local-registry.yaml'),
        'utf-8',
      ),
    );
  }
  if (withObservability) {
    // The isolated observability stack applies via `kubectl apply -k
    // k8s/base/observability` only when this dir exists (present after
    // `vibecarbon add observability`). Creating it lets the standby test assert
    // the apply is SKIPPED by the role gate (not merely absent for lack of a
    // dir), and the primary test assert it still runs.
    mkdirSync(join(dir, 'k8s', 'base', 'observability'), { recursive: true });
    writeFileSync(
      join(dir, 'k8s', 'base', 'observability', 'kustomization.yaml'),
      'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: vibecarbon-observability\n',
    );
  }
  return dir;
}

// Stand-in for a provider class — applyK3sManifests reads the
// PROVIDER_ID_PREFIX/K8S_IMAGE statics off whatever ProviderClass the deploy
// call site resolved (see providerFor() in lib/providers/index.js), never
// instantiates it, and (M3 Task 5b) dispatches getK8sWorkerUserData(vars) on
// it via renderCarbonAutoscalerConfig to render the CA worker-pool
// cloud-init. K8S_IMAGE (M3 Task 2) and getK8sWorkerUserData mirror
// HetznerProvider's real statics exactly (wraps worker-init.sh via
// loadCloudInit/renderScript).
const FakeHetznerProvider = {
  PROVIDER_ID_PREFIX: 'hcloud://',
  K8S_IMAGE: 'ubuntu-24.04',
  K8S_STORAGE_CLASS: 'hcloud-volumes',
  async getK8sWorkerUserData(vars: Record<string, unknown>) {
    const { loadCloudInit, renderScript } = await import('../../../src/lib/iac/cloud-init.js');
    return renderScript(loadCloudInit('worker-init.sh'), vars);
  },
};

function baseArgs(projectDir: string) {
  return {
    kubeconfig: join(projectDir, 'kubeconfig'),
    projectDir,
    projectName: 'proj',
    imageTag: '10.0.1.1:5000/proj:abc-20260101000000',
    dbImageTag: 'ghcr.io/org/postgres:15-walg1',
    envLocal: {
      ADMIN_EMAIL: 'admin@example.test',
      ADMIN_PASSWORD: 'test-password',
      BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    },
    domain: 'app.example.test',
    // s3Config omitted → no wal-g backup credentials (fewer calls).
    restore: null,
    // dnsProvider omitted → no DNS secret / hetzner webhook path.
    apiToken: 'hetzner-token',
    providerId: 'hetzner',
    ProviderClass: FakeHetznerProvider,
    region: 'nbg1',
    environment: 'e2e',
    minWorkers: 1,
    maxWorkers: 3,
    workerServerType: 'cx23',
    k3sToken: 'k3s-token',
    masterIp: '1.2.3.4',
    sshKeyPath: '/tmp/key',
    perfPrefix: 'k3s',
  };
}

/** Poll `cond` up to `timeoutMs`; resolve true if it ever holds, else false. */
async function waitFor(cond: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

const isDbRolloutWait = (a: string[]) =>
  a[0] === 'kubectl' && a.includes('rollout') && a.includes('statefulset/db');
const isObservabilityApply = (a: string[]) =>
  a[0] === 'kubectl' &&
  a.includes('apply') &&
  a.includes('-k') &&
  a.some((s) => typeof s === 'string' && s.includes('observability'));
const caCalls = (pred: (a: string[]) => boolean) =>
  cmdCalls.filter((a) => a[0] === 'kubectl' && a.includes('deploy/cluster-autoscaler') && pred(a));
// `apply -f -` calls carry their payload over stdin, not argv — this finds
// the ONE piped Secret whose YAML declares the given metadata.name and
// extracts+parses its `config.json` stringData value (a JSON string
// literal wrapping the rendered carbon-autoscaler config document).
function findAppliedSecretConfigJson(secretName: string) {
  const hit = stdinCalls.find(
    (c) =>
      c.argv[0] === 'kubectl' &&
      c.argv.includes('apply') &&
      c.argv.includes('-f') &&
      c.data.includes(`name: ${secretName}`),
  );
  if (!hit) return { hit: null, config: null };
  const match = hit.data.match(/^ {2}config\.json: (".*")\s*$/m);
  if (!match) return { hit, config: null };
  const configJson = JSON.parse(match[1]); // un-escape the YAML double-quoted scalar
  return { hit, config: JSON.parse(configJson) };
}

// The delivery succeeds unless a test sets deliverGate / deliverError. File-level
// so every describe gets it (an outer beforeEach runs before each inner one).
beforeEach(() => {
  deliverImage.mockReset();
  deliverImage.mockImplementation(async (opts: { pushAfter?: Promise<unknown> }) => {
    cmdCalls.push(['deliverImage']);
    if (deliverGate) await deliverGate.promise;
    if (deliverError) throw deliverError;
    // deliverImage pushes into the registry only once pushAfter resolves
    // (layer-delta.test.ts pins that); logged so it orders against kubectl.
    if (opts?.pushAfter) {
      await opts.pushAfter;
      cmdCalls.push(['registryPush']);
    }
    return { bytes: 1, layersSent: 1, layersReused: 0 };
  });
});

describe('applyK3sManifests refuses a chart-era cluster', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });
  afterEach(() => {
    retiredChartStsOut = '';
    retiredChartReleaseOut = '';
  });

  it('refuses before applying k8s/base when the old chart database still runs', async () => {
    const { applyK3sManifests } = await k3sPromise;
    retiredChartStsOut = `statefulset.apps/${RETIRED_CHART_DB_STATEFULSET}\n`;
    await expect(applyK3sManifests(baseArgs(makeProjectDir()))).rejects.toThrow(
      /existing data does not carry over automatically/,
    );
    expect(
      cmdCalls.some(
        (a) =>
          a[0] === 'kubectl' &&
          a.includes('apply') &&
          a.includes('-k') &&
          a.some((x) => /k8s-base/.test(String(x))),
      ),
    ).toBe(false);
  });

  // Task 12 deferral: the StatefulSet can be gone while the Helm release
  // record survives (a half-done uninstall, or a chart scaled away). The
  // release alone still means the chart owns this namespace: refuse.
  it('refuses before applying k8s/base when only the Helm release record remains', async () => {
    const { applyK3sManifests } = await k3sPromise;
    retiredChartReleaseOut = `secret/sh.helm.release.v1.${RETIRED_CHART_RELEASE}.v3\n`;
    await expect(applyK3sManifests(baseArgs(makeProjectDir()))).rejects.toThrow(
      new RegExp(`sh\\.helm\\.release\\.v1\\.${RETIRED_CHART_RELEASE}\\.v3`),
    );
    expect(
      cmdCalls.some(
        (a) =>
          a[0] === 'kubectl' &&
          a.includes('apply') &&
          a.includes('-k') &&
          a.some((x) => /k8s-base/.test(String(x))),
      ),
    ).toBe(false);
  });

  it('proceeds to apply k8s/base when there is no trace of it', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));
    expect(cmdCalls.some((a) => a.includes(RETIRED_CHART_DB_STATEFULSET))).toBe(true);
    expect(
      cmdCalls.some(
        (a) =>
          a[0] === 'kubectl' &&
          a.includes('apply') &&
          a.includes('-k') &&
          a.some((x) => /k8s-base/.test(String(x))),
      ),
    ).toBe(true);
  });
});

describe("applyK3sManifests binds the registry hostPort to the deploy's master private IP", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    registryAtBaseApply = null;
    installSpawnMock();
  });

  it('renders hostIP from masterPrivateIp into the applied base (DO-shaped address)', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests({
      ...baseArgs(makeProjectDir({ withRegistry: true })),
      imageTag: '10.10.0.7:5000/proj:abc-20260101000000',
      masterPrivateIp: '10.10.0.7',
    });
    expect(registryAtBaseApply).toMatch(/hostIP: "10\.10\.0\.7"/);
    expect(registryAtBaseApply).not.toContain('{{MASTER_PRIVATE_IP}}');
  });

  it('refuses to apply the base when masterPrivateIp is missing', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await expect(
      applyK3sManifests(baseArgs(makeProjectDir({ withRegistry: true }))),
    ).rejects.toThrow(/MASTER_PRIVATE_IP/);
    expect(registryAtBaseApply).toBeNull();
  });
});

describe('applyK3sManifests deploy-time optimizations', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    registryRolloutExit = 0;
    eventsOut = '';
    installSpawnMock();
  });

  // A rollout, not a pod wait: after an image ref change the Recreate
  // strategy's old pod is still Ready while it terminates, and a pod wait
  // would let the delivery push into it.
  const isLocalRegistryWait = (a: string[]) =>
    a[0] === 'kubectl' &&
    a.includes('rollout') &&
    a.includes('status') &&
    a.includes('deployment/local-registry');
  const isCaApply = (a: string[]) =>
    a[0] === 'kubectl' &&
    a.includes('apply') &&
    a.includes('-k') &&
    a.some((x) => typeof x === 'string' && x.includes('cluster-autoscaler'));
  const isAppPatch = (a: string[]) =>
    a[0] === 'kubectl' && a.includes('patch') && a.includes('deployment/app');
  const isDelivery = (a: string[]) => a[0] === 'deliverImage';

  const isRegistryPush = (a: string[]) => a[0] === 'registryPush';
  const isCertManagerInstall = (a: string[]) =>
    a[0] === 'kubectl' && a.includes('apply') && a.some((x) => /cert-manager.*\.yaml$/.test(x));

  // The layer delta into the master's containerd needs only ssh and the base
  // pull, so it starts with the apply, before cert-manager; only its push
  // waits for the registry pod, which k8s/base creates (DO e2e 2026-10-31:
  // image.deliver 12 s, which the CA rollout had hidden until it moved out).
  it('#1 the transfer starts before cert-manager; the push waits for the registry; the app patch waits for both', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();
    // Hold the delivery open: the deployment/app patch must not run (it is
    // the barrier).
    deliverGate = makeGate();
    const done = applyK3sManifests(baseArgs(projectDir));
    done.catch(() => {}); // avoid unhandled-rejection noise during the poll window

    const delivering = await waitFor(() => cmdCalls.some(isDelivery), 2000);
    await new Promise((r) => setTimeout(r, 50));
    const patchedWhilePending = cmdCalls.some(isAppPatch);
    deliverGate.release();
    await done;

    expect(delivering).toBe(true);
    expect(patchedWhilePending).toBe(false);
    const delivery = cmdCalls.findIndex(isDelivery);
    expect(delivery).toBeLessThan(cmdCalls.findIndex(isCertManagerInstall));
    expect(cmdCalls.findIndex(isLocalRegistryWait)).toBeLessThan(
      cmdCalls.findIndex(isRegistryPush),
    );
    expect(cmdCalls.findIndex(isRegistryPush)).toBeLessThan(cmdCalls.findIndex(isAppPatch));
  });

  // The cluster autoscaler (kube-system, hostNetwork, its own Secret and
  // kustomization) needs nothing cert-manager or k8s/base provides, so its
  // apply and rollout run alongside the cert-manager readiness chain instead
  // of after the base (DO e2e 2026-10-31: clusterAutoscaler.rollout 15.6 s on
  // the critical path). The app still rolls only after it.
  const isCertManagerWait = (a: string[]) =>
    a[0] === 'kubectl' && a.includes('wait') && a.includes('deploy/cert-manager');
  const isCaRollout = (a: string[]) =>
    a[0] === 'kubectl' &&
    a.includes('rollout') &&
    a.includes('status') &&
    a.includes('deploy/cluster-autoscaler');

  it('the CA apply and rollout run while cert-manager is still becoming Available', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const gate = makeGate();
    certManagerWaitGate = gate.promise;
    try {
      const done = applyK3sManifests(baseArgs(makeProjectDir()));
      done.catch(() => {});
      const waiting = await waitFor(() => cmdCalls.some(isCertManagerWait), 2000);
      const rolledWhileWaiting = await waitFor(() => cmdCalls.some(isCaRollout), 2000);
      const baseAppliedWhileWaiting = cmdCalls.some(
        (a) => a[0] === 'kubectl' && a.includes('-k') && a.some((x) => /k8s-base/.test(String(x))),
      );
      gate.release();
      await done;
      expect(waiting).toBe(true);
      expect(rolledWhileWaiting).toBe(true);
      // The cert-manager chain itself is unchanged: the base still waits for it.
      expect(baseAppliedWhileWaiting).toBe(false);
      // Secret before apply, apply before set image, set image before the wait.
      const caSecret = stdinCalls.find((c) => c.data.includes('name: carbon-autoscaler-config'));
      const apply = cmdCalls.findIndex(isCaApply);
      const setImage = cmdCalls.findIndex(
        (a) =>
          a.includes('set') && a.includes('image') && a.includes('deployment/cluster-autoscaler'),
      );
      expect(caSecret?.seq).toBeLessThan(apply);
      expect(apply).toBeLessThan(setImage);
      expect(setImage).toBeLessThan(cmdCalls.findIndex(isCaRollout));
    } finally {
      certManagerWaitGate = null;
    }
  });

  // M3: when the main chain fails, the CA chain still in flight is stopped
  // and settled before the error is rethrown, so its diagnostics never print
  // after the deploy's failure and no kubectl outlives it.
  it('a failed main chain leaves a stop that kills the in-flight CA rollout, with no CA diagnostics', async () => {
    const { applyK3sManifests } = await k3sPromise;
    caRolloutGate = new Promise<void>(() => {}); // the rollout never ends on its own
    certManagerWaitExit = 1;
    killed = [];
    // The cert-manager wait polls within a long budget: let it give up fast.
    const realNow = Date.now;
    let t = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 60_000));
    try {
      const inFlight: { stopClusterAutoscaler?: () => Promise<void> } = {};
      const err = await applyK3sManifests({ ...baseArgs(makeProjectDir()), inFlight }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/cert-manager/);
      // What deployK3s's catch runs before rethrowing (k3s-build-overlaps-infra.test.ts).
      await inFlight.stopClusterAutoscaler?.();
      expect(killed.some(isCaRollout)).toBe(true);
      const after = cmdCalls.length;
      await new Promise((r) => setTimeout(r, 20));
      expect(cmdCalls.length).toBe(after);
      expect(cmdCalls.some((a) => a.includes('get') && a.includes('app=cluster-autoscaler'))).toBe(
        false,
      );
    } finally {
      vi.mocked(Date.now).mockRestore();
      caRolloutGate = null;
      certManagerWaitExit = 0;
    }
  });

  it('the app is not patched until the CA rollout completes', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const gate = makeGate();
    caRolloutGate = gate.promise;
    try {
      const done = applyK3sManifests(baseArgs(makeProjectDir()));
      done.catch(() => {});
      expect(await waitFor(() => cmdCalls.some(isCaRollout), 2000)).toBe(true);
      // Everything up to the barrier may run; the app patch may not.
      expect(await waitFor(() => cmdCalls.some(isDelivery), 2000)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      const patchedEarly = cmdCalls.some(isAppPatch);
      gate.release();
      await done;
      expect(patchedEarly).toBe(false);
      expect(cmdCalls.findIndex(isCaRollout)).toBeLessThan(cmdCalls.findIndex(isAppPatch));
    } finally {
      caRolloutGate = null;
    }
  });

  it('a failed CA rollout fails the deploy loudly, before the app is patched', async () => {
    const { applyK3sManifests } = await k3sPromise;
    caRolloutExit = 1;
    try {
      await expect(applyK3sManifests(baseArgs(makeProjectDir()))).rejects.toThrow(
        /progress deadline/,
      );
      expect(cmdCalls.some(isAppPatch)).toBe(false);
    } finally {
      caRolloutExit = 0;
    }
  });

  it('the registry is waited by rollout status, never by a pod Ready wait', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));
    const waits = cmdCalls.filter(isLocalRegistryWait);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toEqual([
      'kubectl',
      '-n',
      'vibecarbon',
      'rollout',
      'status',
      'deployment/local-registry',
      '--timeout=120s',
    ]);
    expect(cmdCalls.some((a) => a.includes('wait') && a.includes('app=local-registry'))).toBe(
      false,
    );
  });

  it('a registry rollout that times out on an unpullable system image names the packages', async () => {
    const { applyK3sManifests } = await k3sPromise;
    registryRolloutExit = 1;
    eventsOut =
      'vibecarbon   local-registry-7f9   FailedCreatePodSandBox   failed to get sandbox image ' +
      '"vibecarbon-system.invalid/rancher/mirrored-pause:3.6": failed to pull image ' +
      '"vibecarbon-system.invalid/rancher/mirrored-pause:3.6": 401 Unauthorized\n';
    const err = await applyK3sManifests(baseArgs(makeProjectDir())).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/local-registry rollout did not complete/);
    expect(err.message).toContain('ghcr.io/hyperformant/mirrored-pause');
    // The transfer may have run; nothing is pushed into a registry that never served.
    await new Promise((r) => setTimeout(r, 20));
    expect(cmdCalls.some(isRegistryPush)).toBe(false);
  });

  it('a registry rollout timeout with no mirror pull failure says only that', async () => {
    const { applyK3sManifests } = await k3sPromise;
    registryRolloutExit = 1;
    const err = await applyK3sManifests(baseArgs(makeProjectDir())).catch((e) => e);
    expect(err.message).toMatch(/local-registry rollout did not complete/);
    expect(err.message).not.toMatch(/must be public/);
  });

  it('#1 one delivery, to the master only, of the tag the pods run, with the base pull', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const basePull = Promise.resolve('pulled');
    const args = { ...baseArgs(makeProjectDir()), basePull };
    await applyK3sManifests(args);
    expect(deliverImage).toHaveBeenCalledTimes(1);
    expect(deliverImage).toHaveBeenCalledWith({
      tag: args.imageTag,
      sshTarget: 'root@1.2.3.4',
      sshKey: '/tmp/key',
      runtime: 'k3s',
      registryRef: args.imageTag,
      basePull,
      pushAfter: expect.any(Promise),
    });
  });

  it('#1 a failed delivery fails the deploy before any pod references the tag', async () => {
    const { applyK3sManifests } = await k3sPromise;
    deliverError = new Error('image delivery failed: the import did not create x');
    await expect(applyK3sManifests(baseArgs(makeProjectDir()))).rejects.toThrow(
      'image delivery failed: the import did not create x',
    );
    expect(cmdCalls.some(isAppPatch)).toBe(false);
  });

  it('#2 renders ONE plain-JSON carbon-autoscaler-config Secret via stdin (no base64, no legacy CA config Secret)', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();

    await applyK3sManifests(baseArgs(projectDir));

    const caSecretStdins = stdinCalls.filter((c) =>
      c.data.includes('name: carbon-autoscaler-config'),
    );
    expect(caSecretStdins).toHaveLength(1);
    const { config } = findAppliedSecretConfigJson('carbon-autoscaler-config');
    expect(config).not.toBeNull();
    expect(config.provider).toBe('hetzner');
    expect(config.providerIdPrefix).toBe('hcloud://');
    expect(config.nodeGroups['worker-pool'].minSize).toBe(0);
    // minWorkers:1, maxWorkers:3 (baseArgs) → headroom 2.
    expect(config.nodeGroups['worker-pool'].maxSize).toBe(2);

    // The old base64-encoded legacy CA config Secret (cluster-config.json,
    // shaped with a top-level `nodeConfigs` key) is fully retired — nothing
    // should reference its legacy JSON shape or data key anymore.
    expect(stdinCalls.some((c) => c.data.includes('nodeConfigs'))).toBe(false);
    expect(stdinCalls.some((c) => c.data.includes('cluster-config.json'))).toBe(false);
  });

  it('#2 patches the sidecar image via `set image` AFTER `apply -k cluster-autoscaler`, with no --nodes/HCLOUD_* patch anywhere', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();

    await applyK3sManifests(baseArgs(projectDir));

    const applyKIdx = cmdCalls.findIndex(
      (a) =>
        a[0] === 'kubectl' &&
        a.includes('apply') &&
        a.includes('-k') &&
        a.some((s) => s.endsWith('/cluster-autoscaler')),
    );
    const setImageIdx = cmdCalls.findIndex(
      (a) =>
        a[0] === 'kubectl' &&
        a.includes('set') &&
        a.includes('image') &&
        a.includes('deployment/cluster-autoscaler'),
    );
    expect(applyKIdx).toBeGreaterThanOrEqual(0);
    expect(setImageIdx).toBeGreaterThan(applyKIdx);
    expect(
      cmdCalls[setImageIdx].some((s) =>
        s.startsWith('carbon-autoscaler=ghcr.io/hyperformant/carbon-autoscaler:'),
      ),
    ).toBe(true);
    // BOTH containers are re-pinned in this ONE call. The upstream CA image
    // moved to a ghcr mirror after registry.k8s.io 403'd the pull on Hetzner
    // (2026-07-31, src/lib/images.js); patching it here — not only in the
    // manifest — is what makes images.js authoritative for projects whose
    // checked-in k8s/ tree predates the mirror. Two containers, one roll:
    // `strategy: Recreate` means each extra patch would cost a full cycle.
    expect(
      cmdCalls[setImageIdx].some((s) =>
        s.startsWith('cluster-autoscaler=ghcr.io/hyperformant/cluster-autoscaler:'),
      ),
    ).toBe(true);
    expect(cmdCalls[setImageIdx].some((s) => namesHost(s, 'registry.k8s.io'))).toBe(false);
    // One `set image` invocation, not two. (`caCalls` matches the
    // `deploy/cluster-autoscaler` short form; `set image` addresses the same
    // Deployment as `deployment/cluster-autoscaler`, so count directly.)
    expect(
      cmdCalls.filter(
        (a) =>
          a[0] === 'kubectl' &&
          a.includes('set') &&
          a.includes('image') &&
          a.includes('deployment/cluster-autoscaler'),
      ).length,
    ).toBe(1);

    // The retired --nodes placeholder patch + HCLOUD_* env upsert must be
    // gone entirely — no argv anywhere matches either shape.
    expect(cmdCalls.some((a) => a.some((s) => /--nodes=/.test(s)))).toBe(false);
    expect(cmdCalls.some((a) => a.some((s) => /HCLOUD_(NETWORK|FIREWALL|SSH_KEY)/.test(s)))).toBe(
      false,
    );
    // No standalone `set env` roll and no `rollout restart` roll (retired
    // along with the old combined args+env patch).
    expect(caCalls((a) => a.includes('set') && a.includes('env')).length).toBe(0);
    expect(caCalls((a) => a.includes('rollout') && a.includes('restart')).length).toBe(0);
    // Still exactly one CA rollout STATUS wait (the clean failure-mode gate).
    expect(caCalls((a) => a.includes('rollout') && a.includes('status')).length).toBe(1);
  });
});

/**
 * Pilot-light standby: role === 'standby' means nothing app-tier runs on
 * the 2-node standby cluster (no app pods, no CA-spawned workers) until a
 * failover promotes it. applyK3sManifests declaratively zeroes the app +
 * cluster-autoscaler Deployments (same patch-at-deploy pattern as the
 * certificate/configmap placeholder patches below the k8s/base apply — TYPE
 * and NAME as separate argv tokens, not slash-joined) and skips every
 * app-tier step that would exec against pods that don't exist yet.
 * Registry wait + image delivery, cert-manager, traefik, and the cert/config patches
 * all stay — failover needs the registry (CA-spawned workers pull from it)
 * and the serving master.
 */
describe('applyK3sManifests pilot-standby role', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    getNodesOut = '';
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  it('reaps stale -worker- Node objects on the pilot standby (run 32620564611)', async () => {
    // Post-failover reconverge: minWorkers:0 makes Pulumi delete the demoted
    // primary's worker VMs, but nothing deleted their k8s Node OBJECTS — the
    // first rerun night caught `...-primary-worker-1` still registered while
    // the account held zero servers. On a pilot standby ANY '-worker-' node
    // is stale by definition; reap declaratively, don't race the CCM.
    const { applyK3sManifests } = await k3sPromise;
    getNodesOut = 'node/citest-k8s-ha-x-primary-worker-1\nnode/citest-k8s-ha-x-standby-master\n';
    const projectDir = makeProjectDir();
    await applyK3sManifests({ ...baseArgs(projectDir), role: 'standby' });
    const dels = cmdCalls.filter(
      (c) => c[0] === 'kubectl' && c.includes('delete') && c.includes('node'),
    );
    // ALL delete-node calls, not just the first: a reap whose filter widens
    // deletes the master as a SECOND call, which a .find()-based assertion
    // sails past (mutation-verified: filter(() => true) passed that shape).
    expect(dels, 'exactly one stale worker must be deleted').toHaveLength(1);
    expect(dels[0]).toContain('citest-k8s-ha-x-primary-worker-1');
    expect(dels[0]).toContain('--ignore-not-found');
    expect(JSON.stringify(dels)).not.toContain('standby-master');
  });

  it('does NOT reap worker nodes on the primary role', async () => {
    const { applyK3sManifests } = await k3sPromise;
    getNodesOut = 'node/citest-k8s-ha-x-primary-worker-1\n';
    const projectDir = makeProjectDir();
    await applyK3sManifests({ ...baseArgs(projectDir) });
    const del = cmdCalls.find(
      (c) => c[0] === 'kubectl' && c.includes('delete') && c.includes('node'),
    );
    expect(del, 'primary must never reap its live workers').toBeUndefined();
  });

  const zeroPatchArgv = (ns: string, name: string) => [
    'kubectl',
    '-n',
    ns,
    'patch',
    'deployment',
    name,
    '--type=merge',
    '-p',
    JSON.stringify({ spec: { replicas: 0 } }),
  ];

  it('standby role zeroes app + CA and skips app-tier steps', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir({ withObservability: true });

    await applyK3sManifests({ ...baseArgs(projectDir), role: 'standby' });

    // App + CA Deployments patched to replicas:0 (declarative pilot-light zero).
    expect(cmdCalls).toContainEqual(zeroPatchArgv('vibecarbon', 'app'));
    expect(cmdCalls).toContainEqual(zeroPatchArgv('kube-system', 'cluster-autoscaler'));

    // The CA zero-patch is still the LAST CA-related op: the
    // carbon-autoscaler-config Secret render + apply -k + set image all
    // land BEFORE it, so the config/image are fully in place before the
    // Deployment gets scaled to 0 (a future failover only has to flip
    // replicas 0→1, never re-render anything).
    const caZeroIdx = cmdCalls.findIndex(
      (a) =>
        JSON.stringify(a) === JSON.stringify(zeroPatchArgv('kube-system', 'cluster-autoscaler')),
    );
    const caRelatedIdxs = cmdCalls
      .map((a, i) => ({ a, i }))
      .filter(
        ({ a }) =>
          a[0] === 'kubectl' &&
          a.some((s) => typeof s === 'string' && s.includes('cluster-autoscaler')) &&
          !(
            JSON.stringify(a) === JSON.stringify(zeroPatchArgv('kube-system', 'cluster-autoscaler'))
          ),
      )
      .map(({ i }) => i);
    expect(caZeroIdx).toBeGreaterThan(-1);
    for (const idx of caRelatedIdxs) expect(caZeroIdx).toBeGreaterThan(idx);

    // CA rollout wait skipped — nothing rolls out on a zeroed Deployment.
    expect(caCalls((a) => a.includes('rollout') && a.includes('status')).length).toBe(0);
    // App rollout wait skipped — app pods don't exist on a standby.
    expect(
      cmdCalls.some(
        (a) => a.includes('rollout') && a.includes('status') && a.includes('deployment/app'),
      ),
    ).toBe(false);
    // No RLS audit either: no app tier has migrated anything on a standby.
    expect(cmdCalls.some((a) => a.includes('-tAc'))).toBe(false);
    // The db itself still comes up (a streaming replica) and is waited on.
    expect(cmdCalls.some(isDbRolloutWait)).toBe(true);

    // The registry wait stays (the primary's image is copied into it); the
    // standby delivers nothing of its own — see the image-delivery cases below.
    expect(
      cmdCalls.some(
        (a) =>
          a[0] === 'kubectl' &&
          a.includes('rollout') &&
          a.includes('status') &&
          a.includes('deployment/local-registry'),
      ),
    ).toBe(true);
    expect(deliverImage).not.toHaveBeenCalled();

    // Observability follows the app tier — zeroed on the standby (I6). Even
    // though the observability dir exists, the role gate skips its apply.
    expect(cmdCalls.some(isObservabilityApply)).toBe(false);

    // cert-manager control-plane pin applies on EVERY role (see the primary
    // test for the ordering assertion).
    for (const d of ['cert-manager', 'cert-manager-cainjector', 'cert-manager-webhook']) {
      expect(
        cmdCalls.some((a) => a.includes('patch') && a.includes(d) && a.includes('cert-manager')),
      ).toBe(true);
    }
  });

  // Reverse of the post-failover reconverge: the old primary is redeployed as
  // the pilot standby and still runs the observability stack it got as
  // primary. A fresh standby has none, so the demoted one must end up with
  // its pods at zero and grafana-tls off the ACME issuer.
  it('a standby demoted from primary scales its leftover observability to zero', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir({ withObservability: true });
    leftoverObservability = true;
    try {
      await applyK3sManifests({ ...baseArgs(projectDir), role: 'standby' });
    } finally {
      leftoverObservability = false;
    }
    expect(cmdCalls.some(isObservabilityApply)).toBe(false);
    // Each Deployment the observability manifest declares, by kubectl scale.
    for (const name of ['grafana', 'prometheus', 'loki']) {
      expect(cmdCalls).toContainEqual([
        'kubectl',
        '-n',
        'vibecarbon-observability',
        'scale',
        'deployment',
        name,
        '--replicas=0',
      ]);
    }
    expect(cmdCalls.some((a) => a.includes('scale') && a.includes('--all'))).toBe(false);
    const grafanaPatch =
      cmdCalls.find(
        (a) => a.includes('patch') && a.includes('grafana-tls') && a.includes('certificate'),
      ) ?? [];
    expect(grafanaPatch.length, 'grafana-tls must leave the ACME issuer').toBeGreaterThan(0);
    const body = JSON.parse(grafanaPatch[grafanaPatch.indexOf('-p') + 1]);
    expect(body.spec.issuerRef.name).toBe('vibecarbon-standby-selfsigned');
    expect(Object.values(body.metadata.annotations)[0]).toMatch(/^letsencrypt/);
  });

  it('a leftover observability stack whose add-on left the project tree is zeroed too', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();
    leftoverObservability = true;
    try {
      await applyK3sManifests({ ...baseArgs(projectDir), role: 'standby' });
    } finally {
      leftoverObservability = false;
    }
    for (const name of ['grafana', 'prometheus', 'loki']) {
      expect(cmdCalls).toContainEqual([
        'kubectl',
        '-n',
        'vibecarbon-observability',
        'scale',
        'deployment',
        name,
        '--replicas=0',
      ]);
    }
  });

  it('a fresh standby (no leftover namespace) scales and patches nothing in observability', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir({ withObservability: true });
    await applyK3sManifests({ ...baseArgs(projectDir), role: 'standby' });
    expect(
      cmdCalls.some(
        (a) =>
          a.includes('vibecarbon-observability') && (a.includes('scale') || a.includes('patch')),
      ),
    ).toBe(false);
  });

  it('primary role call list is unchanged (patches/waits/app-tier steps all still run)', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir({ withObservability: true });

    await applyK3sManifests({ ...baseArgs(projectDir), role: 'primary' });

    expect(cmdCalls).not.toContainEqual(zeroPatchArgv('vibecarbon', 'app'));
    expect(cmdCalls).not.toContainEqual(zeroPatchArgv('kube-system', 'cluster-autoscaler'));
    // Same CA-rollout shape as the ordering test above: exactly one status wait.
    expect(caCalls((a) => a.includes('rollout') && a.includes('status')).length).toBe(1);
    expect(
      cmdCalls.some(
        (a) => a.includes('rollout') && a.includes('status') && a.includes('deployment/app'),
      ),
    ).toBe(true);
    // The deploy applies no SQL itself (the app migrates at startup), and
    // audits RLS on the live catalog after the app reports migrations applied.
    expect(cmdCalls.some((a) => a.includes('ON_ERROR_STOP=1'))).toBe(false);
    const adminProbe = cmdCalls.findIndex(
      (a) =>
        a.includes('exec') && a.some((s) => typeof s === 'string' && s.includes('/api/health')),
    );
    const rlsAudit = cmdCalls.findIndex((a) => a.includes('-tAc'));
    expect(adminProbe).toBeGreaterThan(-1);
    expect(rlsAudit).toBeGreaterThan(-1);
    expect(rlsAudit).toBeGreaterThan(adminProbe);
    // No schema-cache reload after migrations: nothing in the cluster caches
    // the schema now that the chart runs only the db.
    expect(cmdCalls.some((a) => a.some((s) => s.includes('reload schema')))).toBe(false);
    // Control for the standby skip above: with the same observability dir a
    // PRIMARY still applies the isolated stack.
    expect(cmdCalls.some(isObservabilityApply)).toBe(true);
  });

  it('gives grafana-tls a DIFFERENT identifier set than vibecarbon-tls on a DNS-01 issuer', async () => {
    // Both Certificates target the same ClusterIssuer, hence the same ACME
    // account. Boulder returns ONE shared order to two new-order requests
    // with an identical identifier set, both Order controllers finalize it,
    // and the loser is marked terminally Errored with
    //   403 orderNotReady :: Order was already processing
    // (cert-manager#8960, unfixed in the v1.20.2 we pin). That is the
    // 2026-08-11 e2e hetzner/k8s restore failure. This asserts the WIRING,
    // not just the helper: the bug was the grafana patch reusing the app
    // cert's `dnsNames` variable, which no helper-level test can catch.
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir({ withObservability: true });

    await applyK3sManifests({
      ...baseArgs(projectDir),
      dnsProvider: 'hetzner',
      dnsToken: 'hetzner-dns-token',
      role: 'primary',
    });

    const patchedDnsNames = (certName: string) => {
      const argv = cmdCalls.find(
        (a) => a.includes('patch') && a.includes('certificate') && a.includes(certName),
      );
      if (!argv) throw new Error(`no patch found for certificate/${certName}`);
      return JSON.parse(argv[argv.length - 1]).spec.dnsNames;
    };
    // vibecarbon-tls is rendered into the base before the apply, not patched.
    const appDnsNames = certificateAtBaseApply?.spec?.dnsNames;

    expect(appDnsNames).toEqual(['app.example.test', '*.app.example.test']);
    expect(patchedDnsNames('grafana-tls')).toEqual(['app.example.test']);
    expect(patchedDnsNames('grafana-tls')).not.toEqual(appDnsNames);
  });

  it('single-ACME-issuer policy: a pilot-standby cert references the self-signed issuer, the promote annotation carries the real one', async () => {
    // d4 runs 3/5 RCA (2026-08-28): two clusters solving DNS-01 for the same
    // names live-lock on cert-manager's name-keyed DO solver. The standby
    // must not be an active ACME issuer; the annotation is what the failover
    // promote (and every reconverge under the swapped role) re-points from.
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();

    await applyK3sManifests({
      ...baseArgs(projectDir),
      dnsProvider: 'hetzner',
      dnsToken: 'hetzner-dns-token',
      role: 'standby',
    });

    const body = certificateAtBaseApply;
    if (!body) throw new Error('no rendered certificate/vibecarbon-tls at the base apply');
    expect(body.spec.issuerRef).toEqual({
      name: 'vibecarbon-standby-selfsigned',
      kind: 'ClusterIssuer',
    });
    expect(body.metadata.annotations['vibecarbon.dev/promote-issuer']).toBe(
      'letsencrypt-prod-hetzner',
    );
  });

  it('single-ACME-issuer policy: a primary cert keeps the ACME issuerRef AND carries the annotation', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();

    await applyK3sManifests({
      ...baseArgs(projectDir),
      dnsProvider: 'hetzner',
      dnsToken: 'hetzner-dns-token',
      role: 'primary',
    });

    const body = certificateAtBaseApply;
    if (!body) throw new Error('no rendered certificate/vibecarbon-tls at the base apply');
    expect(body.spec.issuerRef).toEqual({
      name: 'letsencrypt-prod-hetzner',
      kind: 'ClusterIssuer',
    });
    expect(body.metadata.annotations['vibecarbon.dev/promote-issuer']).toBe(
      'letsencrypt-prod-hetzner',
    );
  });

  it('renders or patches exactly the Certificates the ACME watchdog is allowed to repair', async () => {
    // Cross-file pin. DEPLOY_OWNED_CERTIFICATES is a hand-written allowlist of
    // `<namespace>/<name>` keys, and the watchdog silently degrades to
    // read-only for anything absent from it. So a rename or a third
    // Certificate here would not fail any test the watchdog owns — it would
    // just quietly stop being repairable, which is the failure the allowlist
    // exists to prevent. Deriving the keys from the REAL applyK3sManifests
    // argv makes that drift loud.
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir({ withObservability: true });

    await applyK3sManifests({
      ...baseArgs(projectDir),
      dnsProvider: 'hetzner',
      dnsToken: 'hetzner-dns-token',
      role: 'primary',
    });

    const patchedKeys = cmdCalls
      .filter((a) => a[0] === 'kubectl' && a.includes('patch') && a.includes('certificate'))
      .map((a) => `${a[a.indexOf('-n') + 1]}/${a[a.indexOf('certificate') + 1]}`);
    const renderedKeys = certificateAtBaseApply
      ? [`${certificateAtBaseApply.metadata.namespace}/${certificateAtBaseApply.metadata.name}`]
      : [];
    const deployKeys = [...renderedKeys, ...patchedKeys];

    expect(new Set(deployKeys)).toEqual(new Set(DEPLOY_OWNED_CERTIFICATES));
    // No duplicates either — one render or patch per Certificate per deploy
    // (the rendered vibecarbon-tls is no longer patched as well).
    expect(deployKeys).toHaveLength(DEPLOY_OWNED_CERTIFICATES.length);
  });

  it('pins all three cert-manager deployments to the control-plane BEFORE the readiness wait', async () => {
    // RCA 2026-07-17 e4 rig: the in-cluster apiserver endpoint advertises the
    // master's PUBLIC IP and the firewall admits public :6443 from operator
    // CIDRs only — cert-manager pods scheduled onto a worker are locked out
    // of the apiserver (cainjector CrashLoop, webhook readiness 500). The pin
    // removes the scheduling coin-flip; same idiom as the CA manifest.
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir({});

    await applyK3sManifests({ ...baseArgs(projectDir), role: 'primary' });

    const pinIdx = (name: string) =>
      cmdCalls.findIndex(
        (a) =>
          a[0] === 'kubectl' &&
          a.includes('patch') &&
          a.includes(name) &&
          a.some((s) => s.includes('node-role.kubernetes.io/control-plane')),
      );
    const applyIdx = cmdCalls.findIndex(
      (a) => a.includes('apply') && a.some((s) => String(s).includes('cert-manager.yaml')),
    );
    const waitIdx = cmdCalls.findIndex(
      (a) => a.includes('wait') && a.includes('deploy/cert-manager-webhook'),
    );
    for (const d of ['cert-manager', 'cert-manager-cainjector', 'cert-manager-webhook']) {
      const idx = pinIdx(d);
      expect(idx).toBeGreaterThan(applyIdx);
      if (waitIdx !== -1) expect(idx).toBeLessThan(waitIdx);
      // toleration must ride along or the master's control-plane taint (when
      // present on other distros) would strand the pinned pods
      expect(cmdCalls[idx].some((s) => s.includes('NoSchedule'))).toBe(true);
    }
  });
});

/**
 * The TLS Secret restore runs after the namespace exists and before
 * `apply -k base` creates the Certificate, on the cluster that issues (single
 * cluster or the k8s-ha primary). A pilot standby never restores: it serves
 * its local self-signed certificate until a failover promotes it.
 */
describe('applyK3sManifests restores the TLS Secret before applying the base', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  const withBackups = (projectDir: string) => ({
    ...baseArgs(projectDir),
    s3Config: {
      endpoint: 'https://s3.example.test',
      region: 'eu',
      bucket: 'proj-storage',
      accessKey: 'AK',
      secretKey: 'SK',
      walgPrefix: 'backups/proj/e2e/walg',
    },
    backupBucketName: 'proj-backups',
    operatorEnv: 'e2e',
  });
  const isLiveTlsRead = (a: string[]) =>
    a[0] === 'kubectl' && a.includes('get') && a.includes('secret') && a.includes('vibecarbon-tls');
  const isBaseApply = (a: string[]) =>
    a[0] === 'kubectl' &&
    a.includes('apply') &&
    a.includes('-k') &&
    a.some((x) => /k8s-base/.test(String(x)));

  for (const role of [undefined, 'primary'] as const) {
    it(`${role ?? 'single cluster'}: reads the live Secret after the namespace and before apply -k base`, async () => {
      const { applyK3sManifests } = await k3sPromise;
      await applyK3sManifests({ ...withBackups(makeProjectDir()), ...(role && { role }) });
      const read = cmdCalls.findIndex(isLiveTlsRead);
      const base = cmdCalls.findIndex(isBaseApply);
      const namespace = cmdCalls.findIndex(
        (a) => a.includes('create') && a.includes('namespace') && a.includes('vibecarbon'),
      );
      expect(read).toBeGreaterThan(-1);
      expect(base).toBeGreaterThan(read);
      expect(read).toBeGreaterThan(namespace);
      expect(namespace).toBeGreaterThan(-1);
    });
  }

  it('standby: never restores', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests({ ...withBackups(makeProjectDir()), role: 'standby' });
    expect(cmdCalls.some(isLiveTlsRead)).toBe(false);
    expect(cmdCalls.some(isBaseApply)).toBe(true);
  });

  it('no longer patches certificate/vibecarbon-tls after the apply', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(withBackups(makeProjectDir()));
    expect(
      cmdCalls.some(
        (a) => a.includes('patch') && a.includes('certificate') && a.includes('vibecarbon-tls'),
      ),
    ).toBe(false);
  });
});

describe('applyK3sManifests image delivery by role', () => {
  // A k8s-ha standby receives the primary's image by copy into its registry,
  // so it delivers nothing; the primary delivers once, into its own registry.
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  const sshTunnels = () => cmdCalls.filter((a) => a[0] === 'ssh' && a.includes('-L'));

  it('standby: no delivery, no ssh -L tunnel, registry still waited, app patched to imageTag', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const args = { ...baseArgs(makeProjectDir()), role: 'standby' };
    await applyK3sManifests(args);
    expect(deliverImage).not.toHaveBeenCalled();
    expect(sshTunnels()).toEqual([]);
    expect(
      cmdCalls.some(
        (a) =>
          a[0] === 'kubectl' &&
          a.includes('rollout') &&
          a.includes('status') &&
          a.includes('deployment/local-registry') &&
          a.includes('--timeout=120s'),
      ),
    ).toBe(true);
    const patch = cmdCalls.find(
      (a) => a[0] === 'kubectl' && a.includes('patch') && a.includes('deployment/app'),
    );
    expect(patch).toBeDefined();
    const body = JSON.parse(String(patch?.[(patch?.indexOf('-p') ?? -2) + 1]));
    expect(body.spec.template.spec.containers[0].image).toBe(args.imageTag);
    expect(body.spec.template.spec.initContainers[0].image).toBe(args.imageTag);
  });

  it('primary: one delivery, no docker push, no ssh -L tunnel', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const args = { ...baseArgs(makeProjectDir()), role: 'primary' };
    await applyK3sManifests(args);
    expect(deliverImage).toHaveBeenCalledTimes(1);
    expect(cmdCalls.some((a) => a[0] === 'docker' && a.includes('push'))).toBe(false);
    expect(sshTunnels()).toEqual([]);
  });
});

describe('cert-manager DNS-01 webhook install fails loud', () => {
  // 2026-07-16 runCommandAsync audit: both webhook install steps discarded
  // their result — runCommandAsync resolves `false` (does NOT reject) for
  // non-silent callers, so a failed webhook chart install or readiness wait
  // let the deploy march on and ACME DNS-01 issuance died minutes later with
  // no pointer back. Same class as the db rollout wait's check.
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  async function runWithHetznerDns() {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();
    return applyK3sManifests({
      ...baseArgs(projectDir),
      dnsProvider: 'hetzner',
      dnsToken: 'hetzner-dns-token',
    });
  }

  it('throws when the webhook helm install exits non-zero', async () => {
    webhookHelmExit = 1;
    await expect(runWithHetznerDns()).rejects.toThrow(/cert-manager webhook.*helm/i);
  });

  it('throws when the webhook deploy never becomes Available', async () => {
    webhookWaitExit = 1;
    await expect(runWithHetznerDns()).rejects.toThrow(/never became Available/);
  });

  it('proceeds past the webhook block when both steps succeed', async () => {
    await expect(runWithHetznerDns()).resolves.not.toThrow();
    // Sanity: the webhook install actually ran in this configuration.
    expect(
      cmdCalls.some(
        ([cmd, ...a]) =>
          cmd === 'helm' && a[0] === 'upgrade' && a.includes('cert-manager-webhook-hetzner'),
      ),
    ).toBe(true);
  });
});

/**
 * DigitalOcean DNS-01: cert-manager core carries the solver
 * (dns01.digitalocean.tokenSecretRef), so unlike Hetzner there is no webhook
 * chart — the only prerequisite is that Secret/digitalocean-dns exists in the
 * cert-manager namespace BEFORE the kustomization creates the ClusterIssuers
 * that reference it. An issuer whose tokenSecretRef dangles leaves every
 * Order Pending with no error at apply time, which is exactly the failure
 * mode this ordering exists to prevent.
 */
describe('DNS-01 Secret precedes the ClusterIssuers that reference it (digitalocean)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  const issuerApplyIndex = () =>
    cmdCalls.findIndex(
      (a) =>
        a[0] === 'kubectl' &&
        a.includes('apply') &&
        a.includes('-k') &&
        a.some((s) => String(s).includes('cert-manager-resources')),
    );

  it('pipes Secret/digitalocean-dns (key access-token) before applying cert-manager-resources', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();
    await applyK3sManifests({
      ...baseArgs(projectDir),
      dnsProvider: 'digitalocean',
      dnsToken: 'dop_v1_test',
    });

    const secretWrite = stdinCalls.find((c) => c.data.includes('name: digitalocean-dns'));
    expect(secretWrite).toBeTruthy();
    expect(secretWrite?.data).toContain('namespace: cert-manager');
    expect(secretWrite?.data).toContain('access-token: "dop_v1_test"');
    // Token travels over stdin, never argv.
    expect(secretWrite?.argv.join(' ')).not.toContain('dop_v1_test');

    const issuerIdx = issuerApplyIndex();
    expect(issuerIdx).toBeGreaterThan(-1);
    expect(secretWrite?.seq).toBeLessThan(issuerIdx);
  });

  it('installs no webhook chart for digitalocean (solver ships in cert-manager core)', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();
    await applyK3sManifests({
      ...baseArgs(projectDir),
      dnsProvider: 'digitalocean',
      dnsToken: 'dop_v1_test',
    });

    expect(
      cmdCalls.some(([cmd, ...a]) => cmd === 'helm' && a.some((s) => /webhook/.test(String(s)))),
    ).toBe(false);
  });

  it('a missing DNS token aborts before any kubectl apply reaches the cluster', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();

    await expect(
      applyK3sManifests({ ...baseArgs(projectDir), dnsProvider: 'digitalocean' }),
    ).rejects.toThrow(/DIGITALOCEAN_TOKEN/);
    expect(cmdCalls.some((a) => a[0] === 'kubectl' && a.includes('apply'))).toBe(false);
  });
});

describe('readiness probes are wired in (mitigation-audit clusters 1+4 root fix)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  // These pin the WIRING, not the probe mechanics (k8s-readiness.test.ts owns
  // those). A probe that exists but is never called would leave the old
  // timer-vs-condition inversion fully in place — that is the vacuous-guard
  // failure mode, and it is exactly what unwiring either call reproduces.

  it('proves the control plane serves (readyz + server dry-run) before any real kubectl work', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));

    const readyzIdx = cmdCalls.findIndex((a) => a[0] === 'kubectl' && a.includes('/readyz'));
    const controlPlaneDryRunIdx = stdinCalls.findIndex((c) =>
      c.data.includes('vibecarbon-readiness-probe'),
    );
    expect(readyzIdx, 'the /readyz probe must run').toBeGreaterThan(-1);
    expect(controlPlaneDryRunIdx, 'the admission dry-run must run').toBeGreaterThan(-1);

    // Strictly before the first cluster-mutating kubectl apply.
    const firstRealApply = cmdCalls.findIndex(
      (a, i) =>
        a[0] === 'kubectl' && a.includes('apply') && !a.includes('--dry-run=server') && i > -1,
    );
    expect(firstRealApply).toBeGreaterThan(readyzIdx);
  });

  it('proves cert-manager admission round-trips AFTER the Available wait and BEFORE the issuers', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));

    const admissionProbe = stdinCalls.find((c) => c.data.includes('vibecarbon-admission-probe'));
    expect(admissionProbe, 'the cert-manager admission probe must run').toBeDefined();
    // The probe manifest traverses the real pipeline: a cert-manager.io
    // resource, applied server-side dry-run only.
    expect(admissionProbe?.data).toContain('cert-manager.io');
    const probeArgv = cmdCalls[admissionProbe?.seq ?? -1];
    expect(probeArgv).toContain('--dry-run=server');

    // After the last cert-manager Available wait…
    const lastAvailableWaitIdx = cmdCalls.reduce(
      (last, a, i) =>
        a[0] === 'kubectl' && a.includes('wait') && a.some((x) => x.includes('cert-manager'))
          ? i
          : last,
      -1,
    );
    // …and before the ClusterIssuer kustomization.
    const issuersIdx = cmdCalls.findIndex(
      (a) =>
        a[0] === 'kubectl' &&
        a.includes('apply') &&
        a.includes('-k') &&
        a.some((x) => String(x).includes('cert-manager-resources')),
    );
    expect(admissionProbe?.seq).toBeGreaterThan(lastAvailableWaitIdx);
    expect(issuersIdx).toBeGreaterThan(admissionProbe?.seq ?? Number.POSITIVE_INFINITY);
  });
});

describe('postgres accepting-gate precedes the first psql (cluster 5 root fix)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  it('waits for the db rollout, then runs pg_isready against db-0 BEFORE the first psql', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));

    const rolloutIdx = cmdCalls.findIndex(isDbRolloutWait);
    const isReadyIdx = cmdCalls.findIndex(
      (a) => a[0] === 'kubectl' && a.includes('pg_isready') && a.includes('db-0'),
    );
    const psqlIdx = cmdCalls.findIndex((a) => a[0] === 'kubectl' && a.includes('psql'));
    expect(rolloutIdx, 'the db rollout wait must run').toBeGreaterThan(-1);
    expect(isReadyIdx, 'the accepting-gate must run').toBeGreaterThan(rolloutIdx);
    expect(psqlIdx, 'the psql the gate protects (the RLS audit) must still run').toBeGreaterThan(
      -1,
    );
    expect(psqlIdx).toBeGreaterThan(isReadyIdx);
    // WAL archiving is a startup flag on the StatefulSet: no ALTER SYSTEM, no
    // db restart.
    expect(
      cmdCalls.some((a) => a.some((x) => String(x).includes('ALTER SYSTEM'))),
      'no ALTER SYSTEM step',
    ).toBe(false);
    expect(
      cmdCalls.some(
        (a) => a.includes('restart') && a.some((x) => String(x).includes('statefulset')),
      ),
      'no db restart',
    ).toBe(false);
  });
});

describe('applyK3sManifests — waits for the app to report its super admin', () => {
  // The app creates the super admin itself at startup from ADMIN_EMAIL /
  // ADMIN_PASSWORD (delivered via vibecarbon-app-secrets). The deploy's job is
  // to ship those keys and then not report success until the app says the
  // admin is ready, so the operator can always sign in to what was deployed.
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  const isAdminProbe = (a: string[]) =>
    a[0] === 'kubectl' &&
    a.includes('exec') &&
    a.includes('deploy/app') &&
    a.some((x) => String(x).includes('adminReady'));

  it('probes the app pod for adminReady after the app rollout, with no port-forward', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));

    const probeIdx = cmdCalls.findIndex(isAdminProbe);
    const rolloutIdx = cmdCalls.findIndex(
      (a) => a[0] === 'kubectl' && a.includes('rollout') && a.includes('deployment/app'),
    );
    expect(probeIdx, 'admin-ready probe must run').toBeGreaterThan(-1);
    expect(rolloutIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(rolloutIdx);
    expect(cmdCalls.some((a) => a.includes('port-forward'))).toBe(false);
  });

  // The app migrates at startup and readiness stays 503 until it has, so a
  // FAILED migration never lets `rollout status` finish. The deploy must say
  // so at once (probe exit 9, with the app log tail), not after the
  // rollout's 600 s timeout.
  it('fails at once on a failed migration while the rollout still waits', async () => {
    const { applyK3sManifests } = await k3sPromise;
    appProbeExit = 9; // ADMIN_PROBE_EXIT.MIGRATIONS_FAILED
    rolloutHangs = true;
    try {
      const err = await applyK3sManifests(baseArgs(makeProjectDir())).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/database migration failed/);
      expect(err.message).toMatch(/app log tail/);
      // The rollout's own pod, not whichever pod deploy/app picks.
      expect(err.message).toContain(`kubectl -n vibecarbon logs pod/${APP_POD} -c app`);
    } finally {
      appProbeExit = 0;
      rolloutHangs = false;
    }
    expect(
      cmdCalls.some(
        (a) => a[0] === 'kubectl' && a.includes('logs') && a.includes(`pod/${APP_POD}`),
      ),
    ).toBe(true);
    // Nothing after the rollout ran: no RLS audit on a schema that failed.
    expect(cmdCalls.some((a) => a.includes('-tAc'))).toBe(false);
  }, 15_000);

  it('ships the session secret and the admin credentials in vibecarbon-app-secrets', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));

    const secret = stdinCalls.find((c) => c.data.includes('name: vibecarbon-app-secrets'));
    expect(secret, 'vibecarbon-app-secrets apply missing').toBeDefined();
    const infra = stdinCalls.find((c) => c.data.includes('name: vibecarbon-infra-secrets'));
    expect(infra, 'vibecarbon-infra-secrets apply missing').toBeDefined();
    expect(infra?.data).not.toMatch(/\bBETTER_AUTH_SECRET:/);
    for (const key of ['BETTER_AUTH_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) {
      expect(secret?.data, key).toMatch(new RegExp(`\\b${key}:`));
    }
  });

  it('deletes the pre-split vibecarbon-secrets Secret only after the app rollout', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));

    const rolloutIdx = cmdCalls.findIndex(
      (a) => a[0] === 'kubectl' && a.includes('rollout') && a.includes('deployment/app'),
    );
    const deleteIdx = cmdCalls.findIndex(
      (a) =>
        a[0] === 'kubectl' &&
        a.includes('delete') &&
        a.includes('secret') &&
        a.includes('vibecarbon-secrets'),
    );
    expect(rolloutIdx, 'app rollout status missing').toBeGreaterThan(-1);
    expect(deleteIdx, 'old Secret delete missing').toBeGreaterThan(rolloutIdx);
    const del = cmdCalls[deleteIdx];
    expect(del).toContain('--ignore-not-found');
    expect(del.slice(del.indexOf('-n'), del.indexOf('-n') + 2)).toEqual(['-n', 'vibecarbon']);
  });
});

/**
 * M3 Task 9c: provider-conditional S3-egress VPC CIDR allowance
 * (carbon/k8s/base/s3-egress-vpc/s3-egress-vpc.yaml, applied via `kubectl
 * apply -f -` when `ProviderClass.getS3EgressExtraCidrs(vpcCidr)` returns a
 * non-empty list). Reuses this file's existing mock harness (spawn mock,
 * baseArgs, makeProjectDir, FakeHetznerProvider) rather than forking a
 * parallel one — same reasoning as the webhook describe block above.
 *
 * The real DigitalOceanProvider.getS3EgressExtraCidrs / DEFAULT_VPC_CIDR
 * statics are unit-tested directly in
 * tests/unit/providers/s3-egress-vpc.test.ts; this suite proves the
 * end-to-end wiring through applyK3sManifests (the render + conditional
 * apply step, and that Hetzner's real render path gains nothing).
 */
describe('applyK3sManifests — S3-egress VPC allowance (M3 Task 9c)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  const TEST_VPC_CIDR = '10.20.0.0/16';
  // Stands in for DigitalOceanProvider's real getS3EgressExtraCidrs override
  // — same FakeHetznerProvider fixture the rest of this file uses for every
  // other ProviderClass-driven behavior, plus the one static this suite
  // exercises.
  const FakeDigitalOceanProvider = {
    ...FakeHetznerProvider,
    getS3EgressExtraCidrs: (vpcCidr?: string) => (vpcCidr ? [vpcCidr] : []),
  };

  function findS3EgressVpcApply() {
    return stdinCalls.find(
      (c) =>
        c.argv[0] === 'kubectl' &&
        c.argv.includes('apply') &&
        c.argv.includes('-f') &&
        c.data.includes('name: app-s3-vpc-egress'),
    );
  }

  it('DO-like ProviderClass + vpcCidr: applies EXACTLY the 3 S3-purposed additive policies, pinned to the SAME vpcCidr value the deploy used', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();

    await applyK3sManifests({
      ...baseArgs(projectDir),
      ProviderClass: FakeDigitalOceanProvider,
      vpcCidr: TEST_VPC_CIDR,
    });

    const hit = findS3EgressVpcApply();
    if (!hit) throw new Error('expected an S3-egress-VPC apply -f - call');
    const yaml = hit.data;

    expect(yaml).toContain('name: app-s3-vpc-egress');
    expect(yaml).toContain('name: db-s3-vpc-egress');
    expect(yaml).not.toContain('__VPC_CIDR__');

    // Pinned against the SAME variable the deploy call used (TEST_VPC_CIDR),
    // not a hand-copied literal — one occurrence per policy.
    const cidrMatches = yaml.match(/cidr: 10\.20\.0\.0\/16/g);
    // 2: the registry's arm left 2026-08-30 with its S3 backend (filesystem
    // now) and the storage service's arm left with the service. app + db.
    expect(cidrMatches?.length).toBe(2);

    // Near-miss rejection — scoped to exactly the 2 S3-purposed policies;
    // the audited-and-left-alone policies (Task 9c report) must gain no
    // NetworkPolicy object of their own here. Matches actual `name:` fields
    // (not a bare substring check) so the file's own header comment, which
    // legitimately cross-references repl-gateway.yaml for documentation,
    // can't false-positive this assertion.
    expect(yaml).not.toMatch(/name: backup-policy\b/);
    expect(yaml).not.toMatch(/name: traefik-policy\b/);
    expect(yaml).not.toMatch(/name: (allow-db-)?repl-gateway\S*/);
    const policyNames = [...yaml.matchAll(/^\s*name:\s*(\S+)/gm)].map((m) => m[1]);
    expect(policyNames.sort()).toEqual(['app-s3-vpc-egress', 'db-s3-vpc-egress'].sort());
  });

  it('Hetzner-shaped ProviderClass (no getS3EgressExtraCidrs, no vpcCidr): no S3-egress-VPC apply at all — real render path byte-identical', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();

    await applyK3sManifests(baseArgs(projectDir));

    expect(findS3EgressVpcApply()).toBeUndefined();
    expect(stdinCalls.some((c) => c.data.includes('s3-vpc-egress'))).toBe(false);
    expect(
      cmdCalls.some((a) => a.some((s) => typeof s === 'string' && s.includes('s3-egress-vpc'))),
    ).toBe(false);
  });

  it('DO-like ProviderClass but getS3EgressExtraCidrs resolves empty (vpcCidr omitted): no apply either', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();

    await applyK3sManifests({
      ...baseArgs(projectDir),
      ProviderClass: FakeDigitalOceanProvider,
      // vpcCidr intentionally omitted — getS3EgressExtraCidrs(undefined) -> [].
    });

    expect(findS3EgressVpcApply()).toBeUndefined();
  });
});

describe('a changed app Secret rolls deployment/app', () => {
  // `set image` to the same tag is a no-op, and envFrom is read at container
  // start, so a re-minted storage key or a rotated APP_DB_PASSWORD never
  // reached the running pods (and the old key was then revoked under them).
  // The pod template carries the resourceVersions of the Secrets the pod
  // reads, read back after they are applied: any change rolls the pods and
  // reruns migrate, an unchanged apply leaves the versions alone, and no
  // secret value is ever hashed.
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    deliverGate = null;
    deliverError = null;
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    secretVersionOut = {
      'vibecarbon-app-secrets': '4101',
      'vibecarbon-infra-secrets': '4102',
    };
    installSpawnMock();
  });
  afterEach(() => {
    secretVersionOut = {};
  });

  const appPatches = () =>
    cmdCalls.filter(
      (a) => a[0] === 'kubectl' && a.includes('patch') && a.includes('deployment/app'),
    );
  const rvReads = () =>
    cmdCalls.filter(
      (a) =>
        a[0] === 'kubectl' &&
        a.includes('secret') &&
        a.includes('jsonpath={.metadata.resourceVersion}'),
    );

  it('points both containers at the image and stamps the Secret versions in one patch', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const args = baseArgs(makeProjectDir());
    await applyK3sManifests(args);
    expect(
      cmdCalls.some(
        (a) => a.includes('set') && a.includes('image') && a.includes('deployment/app'),
      ),
    ).toBe(false);
    const patches = appPatches();
    expect(patches).toHaveLength(1);
    const body = JSON.parse(String(patches[0][patches[0].indexOf('-p') + 1]));
    expect(body.spec.template.metadata.annotations['vibecarbon.dev/app-secrets-sha']).toBe(
      'app:4101,infra:4102',
    );
    expect(body.spec.template.spec.containers).toEqual([{ name: 'app', image: args.imageTag }]);
    expect(body.spec.template.spec.initContainers).toEqual([
      { name: 'migrate', image: args.imageTag },
    ]);
    // A version, never a value, on argv.
    expect(patches[0].join(' ')).not.toContain(args.envLocal.BETTER_AUTH_SECRET);
  });

  it('reads the versions after both Secrets are applied, before the patch', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));
    const secretApplySeqs = stdinCalls
      .filter((c) => /kind: Secret/.test(c.data) || /"kind":\s*"Secret"/.test(c.data))
      .map((c) => c.seq);
    expect(secretApplySeqs.length).toBeGreaterThanOrEqual(2);
    const reads = rvReads();
    expect(reads.map((a) => a[a.indexOf('secret') + 1])).toEqual([
      'vibecarbon-app-secrets',
      'vibecarbon-infra-secrets',
    ]);
    const firstRead = cmdCalls.indexOf(reads[0]);
    expect(firstRead).toBeGreaterThan(Math.max(...secretApplySeqs));
    expect(firstRead).toBeLessThan(cmdCalls.indexOf(appPatches()[0]));
  });

  it('a bumped Secret version changes the annotation', async () => {
    const { applyK3sManifests } = await k3sPromise;
    secretVersionOut['vibecarbon-infra-secrets'] = '9999';
    await applyK3sManifests(baseArgs(makeProjectDir()));
    const p = appPatches()[0];
    const body = JSON.parse(String(p[p.indexOf('-p') + 1]));
    expect(body.spec.template.metadata.annotations['vibecarbon.dev/app-secrets-sha']).toBe(
      'app:4101,infra:9999',
    );
  });

  it('an unreadable resourceVersion fails the deploy and never patches', async () => {
    const { applyK3sManifests } = await k3sPromise;
    secretVersionOut['vibecarbon-app-secrets'] = '';
    await expect(applyK3sManifests(baseArgs(makeProjectDir()))).rejects.toThrow(
      /resourceVersion of Secret\/vibecarbon-app-secrets/,
    );
    expect(appPatches()).toHaveLength(0);
  });
});
