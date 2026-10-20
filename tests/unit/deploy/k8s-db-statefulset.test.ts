/**
 * Postgres on Kubernetes is our own StatefulSet (carbon/k8s/base/db/), not a
 * Helm chart.
 *
 * What this file pins:
 *   - `kubectl kustomize k8s/base` renders the StatefulSet with its image
 *     placeholder, both init containers (walg-restore, seed-standby), the
 *     `data` volumeClaimTemplate with the StorageClass placeholder, and the
 *     dedicated database-node placement, under the names the CLI's kubectl
 *     calls use (src/lib/deploy/db-workload.js);
 *   - the container starts with exactly compose's flags, so WAL archiving is
 *     on from the first boot on every tier;
 *   - the deploy-time render (buildDbManifestValues + renderK8sBase) leaves no
 *     placeholder behind and pins the provider's StorageClass;
 *   - the wrong-StorageClass guard and the truthful rollout-failure message,
 *     both carried over from the chart era.
 *
 * Every shell-out of the functions under test reaches node's `spawn`, which is
 * mocked; `spawnSync` stays real for the kustomize builds.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, loadAll } from 'js-yaml';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const {
  assertDbStorageClass,
  assertNoRetiredChartDb,
  awaitDbRollout,
  RETIRED_CHART_DB_STATEFULSET,
  RETIRED_CHART_KUSTOMIZATION,
  RETIRED_CHART_RELEASE,
  buildDbManifestValues,
  dbPodListArgs,
  renderK8sBase,
  summarizeDbPods,
  summarizeNotReadyNodes,
} = await import('../../../src/lib/deploy/k8s/k3s.js');
const workload = await import('../../../src/lib/deploy/db-workload.js');

const ROOT = join(__dirname, '../../..');
const BASE = join(ROOT, 'carbon/k8s/base');

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

function kustomize(path: string): Doc[] {
  const res = spawnSync('kubectl', ['kustomize', path], { cwd: ROOT, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`kustomize build failed:\n${res.stderr}`);
  return (loadAll(res.stdout) as Doc[]).filter(Boolean);
}

const values = (overrides: Record<string, unknown> = {}) =>
  buildDbManifestValues({
    dbImageTag: 'ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r1',
    projectName: 'proj',
    s3Config: {
      bucket: 'proj-storage',
      walgPrefix: 'backups/proj/prod/walg',
      endpoint: 'https://nbg1.example',
      region: 'nbg1',
    },
    backupBucketName: 'proj-backups',
    walgRole: 'primary',
    dbPrivateIp: '10.0.1.2',
    storageClass: 'hcloud-volumes',
    walArchiveSha: '0123456789abcdef',
    ...overrides,
  });

describe('k8s/base renders the db StatefulSet', () => {
  let docs: Doc[] = [];
  let sts: Doc;
  let pod: Doc;
  let container: Doc;
  beforeAll(() => {
    docs = kustomize(BASE);
    sts = docs.find((d) => d.kind === 'StatefulSet' && d.metadata.name === 'db');
    pod = sts?.spec.template.spec;
    container = pod?.containers.find((c: Doc) => c.name === 'db');
  }, 60_000);

  it('uses the names every kubectl call relies on', () => {
    expect(sts, 'statefulset/db is in k8s/base').toBeTruthy();
    expect(sts.metadata.name).toBe(workload.DB_STATEFULSET);
    expect(sts.metadata.namespace).toBe('vibecarbon');
    expect(container, 'container db').toBeTruthy();
    expect(container.name).toBe(workload.DB_CONTAINER);
    expect(sts.spec.volumeClaimTemplates[0].metadata.name).toBe(workload.DB_VOLUME_CLAIM_TEMPLATE);
    expect(workload.DB_PVC).toBe('data-db-0');
    expect(workload.DB_POD).toBe('db-0');
  });

  it('labels its pod app=vibecarbon-db (Services, NetworkPolicies, the admin Infrastructure page)', () => {
    expect(sts.spec.selector.matchLabels).toEqual({ app: workload.DB_APP_LABEL });
    expect(sts.spec.template.metadata.labels.app).toBe('vibecarbon-db');
    expect(workload.DB_POD_SELECTOR).toBe('app=vibecarbon-db');
    const statusRoute = readFileSync(
      join(ROOT, 'carbon/src/server/routes/_internal/services-status.ts'),
      'utf-8',
    );
    expect(statusRoute).toContain("'vibecarbon-db': 'PostgreSQL'");
  });

  it('runs the db image placeholder in the container and both inits', () => {
    expect(container.image).toBe('{{DB_IMAGE}}:{{DB_IMAGE_TAG}}');
    expect(pod.initContainers.map((c: Doc) => c.name)).toEqual(['walg-restore', 'seed-standby']);
    for (const init of pod.initContainers) expect(init.image).toBe('{{DB_IMAGE}}:{{DB_IMAGE_TAG}}');
  });

  it('keeps PGDATA one level below the volume root, and the seed init on the raw volume', () => {
    const pgdata = container.volumeMounts.find(
      (m: Doc) => m.mountPath === '/var/lib/postgresql/data',
    );
    expect(pgdata).toEqual({
      name: 'data',
      mountPath: '/var/lib/postgresql/data',
      subPath: 'postgres-data',
    });
    const restore = pod.initContainers.find((c: Doc) => c.name === 'walg-restore');
    expect(restore.volumeMounts).toContainEqual(pgdata);
    const seed = pod.initContainers.find((c: Doc) => c.name === 'seed-standby');
    expect(seed.volumeMounts).toContainEqual({ name: 'data', mountPath: '/seed-volume' });
  });

  it('claims the provider StorageClass through a placeholder, never the cluster default', () => {
    const [claim] = sts.spec.volumeClaimTemplates;
    expect(claim.spec.storageClassName).toBe('{{K8S_STORAGE_CLASS}}');
    expect(claim.spec.accessModes).toEqual(['ReadWriteOnce']);
    expect(claim.spec.resources.requests.storage).toBe('10Gi');
  });

  it('is pinned to the dedicated database node (selector + toleration of its taint)', () => {
    expect(pod.nodeSelector).toEqual({ dedicated: 'db' });
    expect(pod.tolerations).toContainEqual({
      key: 'dedicated',
      operator: 'Equal',
      value: 'db',
      effect: 'NoSchedule',
    });
    // The cloud-init that labels and taints that node.
    const dbInit = readFileSync(join(ROOT, 'carbon/cloud-init/k3s/db-init.sh'), 'utf-8');
    expect(dbInit).toContain('--node-label="dedicated=db"');
    expect(dbInit).toContain('--node-taint="dedicated=db:NoSchedule"');
  });

  it('starts postgres with exactly compose’s flags (WAL archiving on from the first boot)', () => {
    const compose = load(readFileSync(join(ROOT, 'carbon/docker-compose.yml'), 'utf-8')) as Doc;
    expect(container.args).toEqual(compose.services.db.command);
    expect(container.args).toContain('config_file=/etc/postgresql/postgresql.conf');
    expect(container.args).toContain('archive_mode=on');
    expect(container.args).toContain('archive_command=bash /etc/postgresql/wal-archive.sh %p');
  });

  it('reads its superuser password from vibecarbon-infra-secrets and needs no other chart-era key', () => {
    const env = Object.fromEntries(container.env.map((e: Doc) => [e.name, e]));
    expect(env.POSTGRES_PASSWORD.valueFrom.secretKeyRef).toEqual({
      name: 'vibecarbon-infra-secrets',
      key: 'DB_PASSWORD',
    });
    expect(env.POSTGRES_USER.value).toBe('postgres');
    const secretKeys = JSON.stringify(pod).match(/"key":"[A-Z_]+"/g) ?? [];
    for (const k of secretKeys) {
      expect([
        '"key":"DB_PASSWORD"',
        '"key":"RESTORE_TARGET"',
        '"key":"REPL_PASSWORD"',
        '"key":"S3_CREDENTIALS_INI"',
      ]).toContain(k);
    }
    expect(JSON.stringify(pod)).not.toContain('JWT_SECRET');
  });

  it('goes Ready on a TCP pg_isready (the real server, never the init-time temp one)', () => {
    expect(container.readinessProbe.exec.command).toEqual([
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
      '-U',
      'postgres',
    ]);
    // No liveness probe: a long WAL replay after a restore must not be killed.
    expect(container.livenessProbe).toBeUndefined();
  });

  it('records the wal-archive ConfigMap sha in the pod template', () => {
    expect(sts.spec.template.metadata.annotations['vibecarbon.dev/wal-archive-sha']).toBe(
      '{{WAL_ARCHIVE_SHA}}',
    );
    expect(sts.spec.template.metadata.annotations['kubectl.kubernetes.io/default-container']).toBe(
      'db',
    );
  });

  it('ships the `db` Service the app connects to and the governing headless Service', () => {
    const svc = docs.find((d) => d.kind === 'Service' && d.metadata.name === 'db');
    const headless = docs.find((d) => d.kind === 'Service' && d.metadata.name === 'db-headless');
    expect(svc.spec.selector).toEqual({ app: 'vibecarbon-db' });
    expect(svc.spec.ports[0].port).toBe(5432);
    expect(headless.spec.clusterIP).toBe('None');
    expect(sts.spec.serviceName).toBe('db-headless');
  });

  it('lets the db pod reach S3 for wal-g (and only on 443)', () => {
    const policy = docs.find(
      (d) => d.kind === 'NetworkPolicy' && d.metadata.name === 'db-s3-egress',
    );
    expect(policy.spec.podSelector.matchLabels).toEqual({ app: 'vibecarbon-db' });
    expect(policy.spec.egress).toHaveLength(1);
    expect(policy.spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: 443 }]);
  });

  it('every selector that means "the db pod" selects it', () => {
    const repl = readFileSync(join(BASE, 'repl-gateway/repl-gateway.yaml'), 'utf-8');
    const vpc = readFileSync(join(BASE, 's3-egress-vpc/s3-egress-vpc.yaml'), 'utf-8');
    for (const text of [repl, vpc]) {
      expect(text).toMatch(/podSelector:\s+matchLabels:\s+app: vibecarbon-db/);
      expect(text).not.toContain('app.kubernetes.io/instance');
    }
    for (const addon of ['n8n', 'metabase']) {
      const np = readFileSync(join(ROOT, `services/${addon}/k8s/network-policy.yaml`), 'utf-8');
      expect(np).toContain('app: vibecarbon-db');
    }
  });
});

describe('buildDbManifestValues', () => {
  it('splits the image ref on its LAST colon (registry host and port stay in the repo)', () => {
    const v = values({ dbImageTag: 'registry.local:5000/postgres:17-walg' });
    expect(v.DB_IMAGE).toBe('registry.local:5000/postgres');
    expect(v.DB_IMAGE_TAG).toBe('17-walg');
  });

  it('uses ONE canonical wal-g prefix: backup bucket first, then the storage bucket', () => {
    expect(values().WALG_S3_PREFIX).toBe('s3://proj-backups/backups/proj/prod/walg');
    expect(values({ backupBucketName: null }).WALG_S3_PREFIX).toBe(
      's3://proj-storage/backups/proj/prod/walg',
    );
    expect(values({ backupBucketName: null, s3Config: undefined }).WALG_S3_PREFIX).toBe('');
    // Another environment of the same project archives under its own prefix.
    expect(
      values({
        s3Config: { bucket: 'proj-storage', walgPrefix: 'backups/proj/staging/walg' },
      }).WALG_S3_PREFIX,
    ).toBe('s3://proj-backups/backups/proj/staging/walg');
    // A bucket with no resolved prefix would write into a shared path: refuse.
    expect(() => values({ s3Config: { bucket: 'proj-storage' } })).toThrow(/walgPrefix/);
    // The role is a write-guard, never a path segment.
    expect(values({ walgRole: 'standby' }).WALG_S3_PREFIX).not.toMatch(/standby/);
    expect(values({ walgRole: 'standby' }).WALG_ROLE).toBe('standby');
  });

  it('renders the relay the standby seed init dials: the cluster’s own db node + gateway port', () => {
    const v = values({ dbPrivateIp: '10.10.0.7' });
    expect(v.REPL_RELAY_HOST).toBe('10.10.0.7');
    expect(v.REPL_RELAY_PORT).toBe('15433');
  });

  it('refuses to render without an image, a db node IP or a StorageClass', () => {
    expect(() => values({ dbImageTag: '' })).toThrow(/dbImageTag is required/);
    expect(() => values({ dbPrivateIp: undefined })).toThrow(/dbPrivateIp is required/);
    expect(() => values({ storageClass: '' })).toThrow(/storageClass/);
  });
});

describe('renderK8sBase on the shipped base', () => {
  it('leaves no placeholder in the StatefulSet and pins the provider class', () => {
    const rendered = renderK8sBase(BASE, values());
    try {
      const raw = readFileSync(join(rendered, 'db', 'statefulset.yaml'), 'utf-8');
      expect(raw).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
      const sts = kustomize(rendered).find((d) => d.kind === 'StatefulSet');
      const container = sts.spec.template.spec.containers[0];
      expect(container.image).toBe('ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r1');
      expect(sts.spec.volumeClaimTemplates[0].spec.storageClassName).toBe('hcloud-volumes');
      const env = Object.fromEntries(container.env.map((e: Doc) => [e.name, e.value]));
      expect(env.WALG_S3_PREFIX).toBe('s3://proj-backups/backups/proj/prod/walg');
      expect(env.WALG_ROLE).toBe('primary');
      expect(env.AWS_ENDPOINT).toBe('https://nbg1.example');
      // The source tree is untouched.
      expect(readFileSync(join(BASE, 'db', 'statefulset.yaml'), 'utf-8')).toContain(
        '{{K8S_STORAGE_CLASS}}',
      );
    } finally {
      rmSync(rendered, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Shell-out behavior (spawn mocked)
// ---------------------------------------------------------------------------

let cmdCalls: string[][] = [];
let scripted: { match: string; stdout?: string; stderr?: string; exitCode?: number }[] = [];

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

beforeEach(() => {
  cmdCalls = [];
  scripted = [];
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(((cmd: string, args: string[] = []) => {
    const argv = [cmd, ...(args ?? [])];
    cmdCalls.push(argv);
    const hit = scripted.find((s) => argv.join(' ').includes(s.match));
    return fakeChild({
      stdout: hit?.stdout ?? '',
      stderr: hit?.stderr ?? '',
      exitCode: hit?.exitCode ?? 0,
    }) as unknown as ReturnType<typeof spawn>;
  }) as typeof spawn);
});

const env = { KUBECONFIG: '/tmp/fake-kubeconfig' } as NodeJS.ProcessEnv;

describe('assertDbStorageClass — the wrong-StorageClass guard', () => {
  it('refuses when the PGDATA claim already exists on another class, with the remediation', async () => {
    scripted = [
      { match: 'get storageclass', stdout: 'local-path\nhcloud-volumes\n' },
      { match: 'get pvc', stdout: 'data-db-0=local-path\n' },
    ];
    const err = await assertDbStorageClass({ storageClass: 'hcloud-volumes', env }).catch(
      (e: Error) => e,
    );
    const msg = String((err as Error).message);
    expect(msg).toContain('data-db-0: local-path');
    expect(msg).toContain('hcloud-volumes');
    expect(msg).toContain('scale statefulset db --replicas=0');
    expect(msg).toMatch(/delete pvc data-db-0/);
    // Deleting a node-local db PVC destroys the only copy of that data.
    expect(msg).toMatch(/restore/i);
  });

  it('flags a PGDATA claim with no class at all', async () => {
    scripted = [
      { match: 'get storageclass', stdout: 'local-path\nhcloud-volumes\n' },
      { match: 'get pvc', stdout: 'data-db-0=\n' },
    ];
    await expect(assertDbStorageClass({ storageClass: 'hcloud-volumes', env })).rejects.toThrow(
      /\(no class\)/,
    );
  });

  it('ignores other PVCs on another class (bounded blast radius)', async () => {
    scripted = [
      { match: 'get storageclass', stdout: 'local-path\nhcloud-volumes\n' },
      { match: 'get pvc', stdout: 'data-db-0=hcloud-volumes\nscratch=local-path\n' },
    ];
    await expect(
      assertDbStorageClass({ storageClass: 'hcloud-volumes', env }),
    ).resolves.toBeUndefined();
  });

  it('fails loud when the provider StorageClass is absent from the cluster', async () => {
    scripted = [
      { match: 'get storageclass', stdout: 'local-path\n' },
      { match: 'get pvc', stdout: '' },
    ];
    const err = await assertDbStorageClass({ storageClass: 'hcloud-volumes', env }).catch(
      (e: Error) => e,
    );
    expect(String((err as Error).message)).toMatch(/hcloud-volumes/);
    expect(String((err as Error).message)).toMatch(/CSI/);
  });

  it('does not block the deploy when the probe itself cannot answer', async () => {
    scripted = [
      { match: 'get storageclass', exitCode: 1 },
      { match: 'get pvc', exitCode: 1 },
    ];
    await expect(
      assertDbStorageClass({ storageClass: 'hcloud-volumes', env }),
    ).resolves.toBeUndefined();
  });

  it('refuses an empty class rather than letting the cluster default decide', async () => {
    await expect(assertDbStorageClass({ storageClass: '', env })).rejects.toThrow(/empty/);
    expect(cmdCalls).toHaveLength(0);
  });
});

describe('awaitDbRollout — the failure says what is actually there', () => {
  it('waits on statefulset/db and resolves when it rolls out', async () => {
    await expect(awaitDbRollout({ env })).resolves.toBeUndefined();
    const wait = cmdCalls.find((a) => a.includes('rollout'));
    expect(wait).toEqual([
      'kubectl',
      '-n',
      'vibecarbon',
      'rollout',
      'status',
      'statefulset/db',
      '--timeout=900s',
    ]);
  });

  it('names the not-ready db pod and its phase, plus any NotReady node', async () => {
    scripted = [
      {
        match: 'rollout status',
        exitCode: 1,
        stderr: 'error: timed out waiting for the condition',
      },
      { match: 'get pods', stdout: 'db-0   Pending   <none>\n' },
      { match: 'get nodes', stdout: 'master True\nproj-db Unknown\n' },
    ];
    const err = await awaitDbRollout({ env, timeoutS: 5 }).catch((e: Error) => e);
    const msg = String((err as Error).message);
    expect(msg).toContain('did not become Ready within 5s');
    expect(msg).toContain('never became Ready: db-0 (Pending)');
    expect(msg).toContain('Node(s) NotReady: proj-db (Ready=Unknown)');
    // The pod listing is scoped to the db pod's own label.
    const podGet = cmdCalls.find((a) => a.includes('pods'));
    expect(podGet).toEqual(dbPodListArgs());
    expect(podGet).toContain('app=vibecarbon-db');
  });

  it('survives kubectl failing to list pods without inventing a pod state', async () => {
    scripted = [
      { match: 'rollout status', exitCode: 1 },
      { match: 'get pods', exitCode: 1 },
    ];
    const msg = String(((await awaitDbRollout({ env }).catch((e) => e)) as Error).message);
    expect(msg).toMatch(/could not list the db pod/i);
    expect(msg).not.toMatch(/No db pod exists/);
  });
});

describe('summarizeDbPods / summarizeNotReadyNodes', () => {
  it('says so when the StatefulSet created no pod at all', () => {
    expect(summarizeDbPods('')).toMatch(/No db pod exists/);
    expect(summarizeDbPods('  \n ')).toMatch(/No db pod exists/);
  });

  it('treats any READY value other than True as not ready (the wait gates on Ready)', () => {
    expect(summarizeDbPods('db-0 Running False')).toBe(
      'The db pod never became Ready: db-0 (Running).',
    );
    expect(summarizeDbPods('db-0 Running True')).toMatch(/is Ready/);
  });

  it('is silent about nodes on a healthy cluster, names the dead ones otherwise', () => {
    expect(summarizeNotReadyNodes('master True\nworker True')).toBe('');
    expect(summarizeNotReadyNodes('n1 <none>')).toMatch(/n1 \(Ready=<none>\)/);
  });
});

describe('the chart is gone for good', () => {
  it('k3s.js installs no chart for the database and patches no db config at runtime', () => {
    const k3s = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    // The retired chart is named in exactly one place: the probe that refuses
    // to deploy beside it (assertNoRetiredChartDb).
    const start = k3s.indexOf('/**\n * The workloads the retired Postgres Helm chart');
    const end = k3s.indexOf('\n}\n', k3s.indexOf('export async function assertNoRetiredChartDb('));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const outside = k3s.slice(0, start) + k3s.slice(end);
    expect(outside.toLowerCase()).not.toContain(RETIRED_CHART_RELEASE);
    expect(k3s).not.toContain('ALTER SYSTEM');
  });

  it('the scaffold carries no values/ or chart GitOps bundle', () => {
    for (const gone of ['carbon/k8s/values', `carbon/k8s/gitops/${RETIRED_CHART_RELEASE}`]) {
      expect(existsSync(join(ROOT, gone)), gone).toBe(false);
    }
  });
});

describe('assertNoRetiredChartDb — a chart-era cluster is refused, not silently forked', () => {
  // A read of the live cluster: [statefulset get, helm release secret get].
  const execWith = (stsOut: string, releaseOut: string) => {
    const calls: string[][] = [];
    const exec = vi.fn(async (argv: string[]) => {
      calls.push(argv);
      return argv.includes('statefulset') ? stsOut : releaseOut;
    });
    return { exec, calls };
  };

  it('proceeds on a cluster with no trace of the chart (two reads, no retry)', async () => {
    const { exec, calls } = execWith('', '');
    await expect(assertNoRetiredChartDb({ env, exec })).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      'kubectl',
      '-n',
      'vibecarbon',
      'get',
      'statefulset',
      RETIRED_CHART_DB_STATEFULSET,
      '--ignore-not-found',
      '-o',
      'name',
    ]);
    expect(calls[1]).toContain(`owner=helm,name=${RETIRED_CHART_RELEASE}`);
  });

  it('refuses when the chart StatefulSet still runs, and says what to do', async () => {
    const { exec } = execWith(
      `statefulset.apps/${RETIRED_CHART_DB_STATEFULSET}\n`,
      `secret/sh.helm.release.v1.${RETIRED_CHART_RELEASE}.v3\n`,
    );
    const msg = String(
      ((await assertNoRetiredChartDb({ env, exec }).catch((e) => e)) as Error).message,
    );
    expect(msg).toContain(`statefulset.apps/${RETIRED_CHART_DB_STATEFULSET}`);
    expect(msg).toContain('existing data does not carry over automatically');
    expect(msg).toContain('`vibecarbon destroy <env>`');
    expect(msg).toContain(`\`helm uninstall ${RETIRED_CHART_RELEASE} -n vibecarbon\``);
    expect(msg).toContain('`vibecarbon deploy <env> -restore latest`');
    expect(msg).toMatch(/same wal-g prefix/);
    // GitOps: deleting the old Flux Kustomization with prune on would delete
    // the volume before the operator chose to.
    expect(msg).toContain('`prune: false`');
    expect(msg).toContain(`\`${RETIRED_CHART_KUSTOMIZATION}\``);
  });

  it('refuses on the Helm release record alone (the StatefulSet already gone)', async () => {
    const { exec } = execWith('', `secret/sh.helm.release.v1.${RETIRED_CHART_RELEASE}.v1\n`);
    await expect(assertNoRetiredChartDb({ env, exec })).rejects.toThrow(/retired Helm chart/);
  });

  it('refuses rather than guesses when the cluster cannot be read', async () => {
    const exec = vi.fn(async () => {
      throw new Error('Unable to connect to the server');
    });
    await expect(assertNoRetiredChartDb({ env, exec })).rejects.toThrow(
      /could not read the cluster/,
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('applyK3sManifests runs it before anything creates the db StatefulSet', () => {
    const k3s = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const body = k3s.slice(k3s.indexOf('export async function applyK3sManifests('));
    const probe = body.indexOf('await assertNoRetiredChartDb({ env })');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(body.indexOf('renderK8sBase('));
    expect(probe).toBeLessThan(body.indexOf("runKubectlWithRetry(['apply', '-k', baseDir]"));
  });
});

describe('Flux never applies the unrendered db StatefulSet', () => {
  // Without the delete patch Flux would apply `{{DB_IMAGE}}:{{DB_IMAGE_TAG}}`
  // and a literal StorageClass: an InvalidImageName outage on the next roll.
  for (const cluster of ['primary', 'standby']) {
    const file = join(ROOT, `carbon/k8s/flux/clusters/${cluster}/vibecarbon.yaml`);
    const base = () =>
      (loadAll(readFileSync(file, 'utf-8')) as Doc[]).find(
        (d) => d?.kind === 'Kustomization' && d.metadata.name === 'vibecarbon-base',
      );

    it(`${cluster}: vibecarbon-base deletes StatefulSet/db from its build`, () => {
      const patches = base().spec.patches ?? [];
      const del = patches.filter(
        (p: Doc) =>
          p.target?.kind === 'StatefulSet' &&
          p.target?.name === 'db' &&
          /\$patch: delete/.test(p.patch) &&
          /kind: StatefulSet/.test(p.patch) &&
          /name: db\b/.test(p.patch),
      );
      expect(del).toHaveLength(1);
    });

    it(`${cluster}: health-checks the live db explicitly (no wait: true, which ignores healthChecks)`, () => {
      const spec = base().spec;
      expect(spec.wait).toBeUndefined();
      expect(spec.healthChecks).toContainEqual({
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        name: 'db',
        namespace: 'vibecarbon',
      });
    });

    it(`${cluster}: a kustomize build with that patch drops StatefulSet/db and keeps Service/db`, () => {
      const dir = mkdtempSync(join(tmpdir(), `vc-flux-${cluster}-`));
      try {
        cpSync(BASE, join(dir, 'base'), { recursive: true });
        const { patch, target } = base().spec.patches[0];
        writeFileSync(join(dir, 'patch.yaml'), patch);
        writeFileSync(
          join(dir, 'kustomization.yaml'),
          [
            'apiVersion: kustomize.config.k8s.io/v1beta1',
            'kind: Kustomization',
            'resources:',
            '  - base',
            'patches:',
            '  - path: patch.yaml',
            '    target:',
            `      kind: ${target.kind}`,
            `      name: ${target.name}`,
            '',
          ].join('\n'),
        );
        const docs = kustomize(dir);
        expect(docs.some((d) => d.kind === 'StatefulSet')).toBe(false);
        expect(docs.some((d) => d.kind === 'Service' && d.metadata.name === 'db')).toBe(true);
        expect(docs.some((d) => d.kind === 'Deployment' && d.metadata.name === 'app')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }

  it('primary: also health-checks the CLI-applied cluster-autoscaler', () => {
    const file = join(ROOT, 'carbon/k8s/flux/clusters/primary/vibecarbon.yaml');
    const base = (loadAll(readFileSync(file, 'utf-8')) as Doc[]).find(
      (d) => d?.kind === 'Kustomization' && d.metadata.name === 'vibecarbon-base',
    );
    expect(base?.spec.healthChecks).toContainEqual({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      name: 'cluster-autoscaler',
      namespace: 'kube-system',
    });
  });

  // Final review M1: overlays/production includes ../../base, so a Flux
  // Kustomization pointed at an overlay built on it would apply the raw
  // StatefulSet (and be rejected: volumeClaimTemplates are immutable).
  it('overlays/production drops StatefulSet/db and keeps Service/db and the app', () => {
    const docs = kustomize('carbon/k8s/overlays/production');
    expect(docs.some((d) => d.kind === 'StatefulSet')).toBe(false);
    expect(docs.some((d) => d.kind === 'Service' && d.metadata.name === 'db')).toBe(true);
    expect(docs.some((d) => d.kind === 'Deployment' && d.metadata.name === 'app')).toBe(true);
  }, 60_000);
});
