import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEPLOY_OWNED_CERTIFICATES } from '../../../src/lib/deploy/k8s/acme-order-recovery.js';

/**
 * Integration-style unit tests for applyK3sManifests deploy-time behavior:
 *
 *   #1 — the in-cluster registry push runs CONCURRENTLY with the CA rollout +
 *        db rollout + app rollout (nothing between reads the registry —
 *        app pods use the sideloaded image via IfNotPresent), yet it is still
 *        AWAITED before the function returns so a failed push fails the deploy.
 *
 *   #2 — the carbon-autoscaler config Secret is applied via stdin as PLAIN
 *        JSON (Task 8: retired the old base64-encoded legacy CA config
 *        Secret + the `--nodes`/HCLOUD_* argv-and-env patch entirely), the
 *        sidecar image placeholder is patched via `set image` AFTER
 *        `apply -k cluster-autoscaler`, and exactly one rollout status wait
 *        gates the roll (no `--nodes=` patch, no HCLOUD_* env upsert).
 *
 * Every shell-out in applyK3sManifests ultimately reaches node's `spawn` —
 * either directly (cert-manager wait, docker push, ssh tunnel, rollout status,
 * kubectl exec, port-forward) or via command.js `runCommandAsync`
 * (kubectl/helm/docker-tag/pkill). So mocking ONLY `spawn` drives the whole
 * function: the fake child succeeds everywhere and captures every stdin
 * write (so tests can inspect the Secret YAML piped via `apply -f -`).
 * retry.js / perf.js / command.js / fs stay real; the temp projectDir carries
 * the real db StatefulSet that renderK8sBase reads.
 *
 * Admin: applyK3sManifests no longer provisions an account. It waits for
 * the app to report its super admin ready (`kubectl exec deploy/app … node
 * -e`, see awaitAppAdminReady), which the spawn mock answers with exit 0.
 */

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const k3sPromise = import('../../../src/lib/deploy/k8s/k3s.js');

// Ordered log of every spawn argv ([executable, ...args]).
let cmdCalls: string[][] = [];
// Ordered log of every stdin write, paired with the argv of the call it
// belongs to — lets tests inspect Secret YAML piped via `apply -f -`
// (kubectl argv never carries the secret payload itself). `seq` is the
// cmdCalls index of the owning spawn, so a piped call can be ordered against
// argv-only calls; runCommandAsync writes stdin synchronously after spawn
// returns, so no other spawn can slip in between.
let stdinCalls: { argv: string[]; data: string; seq: number }[] = [];
// A manual gate the `docker push` child's exit waits on (concurrency test).
let pushGate: { promise: Promise<void>; release: () => void } | null = null;
// Exit code/stderr the `docker push` child settles with.
let pushExit = { code: 0, stderr: '' };
// Exit codes for the cert-manager DNS-01 webhook install pair (helm install /
// kubectl wait) — drives the fail-loud tests below.
let webhookHelmExit = 0;
let webhookWaitExit = 0;
// Exit code of the in-container /api/health probe (`kubectl exec deploy/app
// … node -e`), and whether `kubectl rollout status deployment/app` hangs
// (never exits, as when readiness stays 503) — drive the migration-failure
// short-circuit test.
let appProbeExit = 0;
let rolloutHangs = false;

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
 * for the gate first (used to hold the docker push open).
 */
function fakeChild({
  exitCode = 0,
  stdout = '',
  stderr = '',
  gate = null,
  argv = [],
}: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  gate?: Promise<void> | null;
  argv?: string[];
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

function installSpawnMock() {
  vi.mocked(spawn).mockImplementation(((cmd: string, args: string[] = []) => {
    cmdCalls.push([cmd, ...(args ?? [])]);
    const argv = args ?? [];
    const full = [cmd, ...argv];
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
    if (cmd === 'docker' && argv[0] === 'push') {
      return fakeChild({
        exitCode: pushExit.code,
        stderr: pushExit.stderr,
        gate: pushGate?.promise ?? null,
        argv: full,
      }) as unknown as ReturnType<typeof spawn>;
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
    if (
      cmd === 'kubectl' &&
      argv.includes('exec') &&
      argv.includes('deploy/app') &&
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

function makeProjectDir({ withObservability = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-k3s-apply-'));
  // renderK8sBase refuses a base without the db StatefulSet, so the project
  // carries the real one, as `create` lays it down.
  mkdirSync(join(dir, 'k8s', 'base', 'db'), { recursive: true });
  writeFileSync(join(dir, 'k8s', 'base', 'kustomization.yaml'), 'resources:\n  - db/\n');
  writeFileSync(
    join(dir, 'k8s', 'base', 'db', 'statefulset.yaml'),
    readFileSync(join(__dirname, '../../../carbon/k8s/base/db/statefulset.yaml'), 'utf-8'),
  );
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
    // Required since the d4 lift — buildDbManifestValues refuses to assume the
    // Hetzner-static relay host. See db-private-ip-required.test.ts.
    dbPrivateIp: '10.0.1.2',
    k3sToken: 'k3s-token',
    masterIp: '1.2.3.4',
    sshKeyPath: '/tmp/key',
    khPath: join(projectDir, 'known_hosts'),
    localTunnelPort: 5000,
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

// Happy registry v2 fake for the round-trip probe that now gates every push
// attempt (probe coverage lives in registry-push.test.ts) — this file pins
// manifest/push ORDERING around it. File-level so every describe gets it.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      const headers = {
        get: (h: string) =>
          method === 'POST' && h.toLowerCase() === 'location'
            ? `${String(url)}probe-upload-1`
            : null,
      };
      if (method === 'POST') return { status: 202, headers };
      if (method === 'PUT') return { status: 201, headers };
      if (method === 'HEAD') return { status: 200, headers };
      return { status: 202, headers };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applyK3sManifests deploy-time optimizations', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    pushGate = null;
    pushExit = { code: 0, stderr: '' };
    webhookHelmExit = 0;
    webhookWaitExit = 0;
    installSpawnMock();
  });

  it('#1 registry push runs concurrently with the db rollout wait, yet stays awaited', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();
    // Hold the docker push open: a SERIAL (awaited-inline) push would block the
    // whole function here and the db wait would never be reached; a
    // BACKGROUNDED push lets the function proceed while the push is pending.
    pushGate = makeGate();

    const done = applyK3sManifests(baseArgs(projectDir));
    done.catch(() => {}); // avoid unhandled-rejection noise during the poll window

    const dbWaitRanWhilePushPending = await waitFor(() => cmdCalls.some(isDbRolloutWait), 2000);

    // Release the push so the function can complete its end-of-run await.
    pushGate.release();
    await done;

    expect(dbWaitRanWhilePushPending).toBe(true);
  });

  it('#1 a failed registry push still fails the deploy (push stays awaited)', async () => {
    const { applyK3sManifests } = await k3sPromise;
    const projectDir = makeProjectDir();
    // Permanent push failure → fails fast (one attempt) → must reject the deploy.
    pushExit = { code: 1, stderr: 'denied: requested access to the resource is denied' };

    await expect(applyK3sManifests(baseArgs(projectDir))).rejects.toThrow(/docker push|denied/i);
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
    expect(cmdCalls[setImageIdx].some((s) => s.includes('registry.k8s.io'))).toBe(false);
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
 * Registry wait+push, cert-manager, traefik, and the cert/config patches
 * all stay — failover needs the registry (CA-spawned workers pull from it)
 * and the serving master.
 */
describe('applyK3sManifests pilot-standby role', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    getNodesOut = '';
    cmdCalls = [];
    stdinCalls = [];
    pushGate = null;
    pushExit = { code: 0, stderr: '' };
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

    // Registry wait + push stay: failover pulls the app image from it.
    expect(
      cmdCalls.some(
        (a) => a[0] === 'kubectl' && a.includes('wait') && a.includes('app=local-registry'),
      ),
    ).toBe(true);
    expect(cmdCalls.some((a) => a[0] === 'docker' && a.includes('push'))).toBe(true);

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

    expect(patchedDnsNames('vibecarbon-tls')).toEqual(['app.example.test', '*.app.example.test']);
    expect(patchedDnsNames('grafana-tls')).toEqual(['app.example.test']);
    expect(patchedDnsNames('grafana-tls')).not.toEqual(patchedDnsNames('vibecarbon-tls'));
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

    const argv = cmdCalls.find(
      (a) => a.includes('patch') && a.includes('certificate') && a.includes('vibecarbon-tls'),
    );
    if (!argv) throw new Error('no patch found for certificate/vibecarbon-tls');
    const body = JSON.parse(argv[argv.length - 1]);
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

    const argv = cmdCalls.find(
      (a) => a.includes('patch') && a.includes('certificate') && a.includes('vibecarbon-tls'),
    );
    if (!argv) throw new Error('no patch found for certificate/vibecarbon-tls');
    const body = JSON.parse(argv[argv.length - 1]);
    expect(body.spec.issuerRef).toEqual({
      name: 'letsencrypt-prod-hetzner',
      kind: 'ClusterIssuer',
    });
    expect(body.metadata.annotations['vibecarbon.dev/promote-issuer']).toBe(
      'letsencrypt-prod-hetzner',
    );
  });

  it('patches exactly the Certificates the ACME watchdog is allowed to repair', async () => {
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

    expect(new Set(patchedKeys)).toEqual(new Set(DEPLOY_OWNED_CERTIFICATES));
    // No duplicates either — one patch per Certificate per deploy.
    expect(patchedKeys).toHaveLength(DEPLOY_OWNED_CERTIFICATES.length);
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
    pushGate = null;
    pushExit = { code: 0, stderr: '' };
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
    pushGate = null;
    pushExit = { code: 0, stderr: '' };
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
    pushGate = null;
    pushExit = { code: 0, stderr: '' };
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
    pushGate = null;
    pushExit = { code: 0, stderr: '' };
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
  // ADMIN_PASSWORD (delivered via vibecarbon-secrets). The deploy's job is
  // to ship those keys and then not report success until the app says the
  // admin is ready, so the operator can always sign in to what was deployed.
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    cmdCalls = [];
    stdinCalls = [];
    pushGate = null;
    pushExit = { code: 0, stderr: '' };
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
      expect(err.message).toMatch(/kubectl -n vibecarbon logs deploy\/app -c app/);
    } finally {
      appProbeExit = 0;
      rolloutHangs = false;
    }
    expect(
      cmdCalls.some((a) => a[0] === 'kubectl' && a.includes('logs') && a.includes('deploy/app')),
    ).toBe(true);
    // Nothing after the rollout ran: no RLS audit on a schema that failed.
    expect(cmdCalls.some((a) => a.includes('-tAc'))).toBe(false);
  }, 15_000);

  it('ships the session secret and the admin credentials in vibecarbon-secrets', async () => {
    const { applyK3sManifests } = await k3sPromise;
    await applyK3sManifests(baseArgs(makeProjectDir()));

    const secret = stdinCalls.find((c) => c.data.includes('name: vibecarbon-secrets'));
    expect(secret, 'vibecarbon-secrets apply missing').toBeDefined();
    for (const key of ['BETTER_AUTH_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) {
      expect(secret?.data, key).toMatch(new RegExp(`\\b${key}:`));
    }
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
    pushGate = null;
    pushExit = { code: 0, stderr: '' };
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
