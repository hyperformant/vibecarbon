/**
 * The k8s-ha db StatefulSet is created ONCE with its replication hostPort and
 * is never restarted by the replication setup on a cold deploy.
 *
 * WHY (DO e2e 2026-11-01, d4, main a159ff7): configurePrimaryForReplication
 * used to `kubectl patch` the hostPort into the primary's already-running db
 * StatefulSet about a minute after its first volume attach. The patch
 * recreated db-0: the volume detached and re-attached on the same node within
 * seconds, the DigitalOcean CSI recorded an attach that never held at the
 * provider (docs/mitigations.yml `do-csi-stale-volumeattachment`), and kubelet
 * looped `mkfs.ext4 ... does not exist and no size was specified` until the
 * 600s rollout wait expired. The hostPort is now rendered into the StatefulSet
 * before its first apply, on both HA clusters (so a failover's promoted
 * standby already has it), and the replication setup only reads it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = join(__dirname, '../../..');
const BASE = join(ROOT, 'carbon/k8s/base');

const TEST_TLS = {
  dnsNames: ['app.example.test'],
  issuerName: 'letsencrypt-prod-manual',
  effectiveIssuer: 'letsencrypt-prod-manual',
};

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

// --- exec seams for configurePrimaryForReplication (offline) ---
const calls: string[] = [];
let liveHostPort: number | null = 5433;
const stsJson = () =>
  JSON.stringify({
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'db',
              ports: [
                {
                  name: 'postgres',
                  containerPort: 5432,
                  ...(liveHostPort ? { hostPort: liveHostPort, hostIP: '127.0.0.1' } : {}),
                },
              ],
            },
          ],
        },
      },
    },
  });
vi.mock('../../../src/lib/command.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../src/lib/command.js');
  return {
    ...actual,
    runCommandAsync: vi.fn(async (argv: string[]) => {
      const cmd = argv.join(' ');
      calls.push(cmd);
      if (cmd.includes('get statefulset db')) return stsJson();
      return '';
    }),
  };
});
vi.mock('../../../src/lib/ssh.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../src/lib/ssh.js');
  return {
    ...actual,
    scpWithRetry: vi.fn(async (argv: string[]) => {
      calls.push(`scp ${argv.join(' ')}`);
    }),
  };
});
vi.mock('../../../src/lib/host-keys.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../src/lib/host-keys.js');
  return { ...actual, seedKnownHosts: vi.fn(async () => {}) };
});
vi.mock('../../../src/lib/deploy/utils.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../src/lib/deploy/utils.js');
  return { ...actual, readReplPassword: () => 'test-repl-password' };
});

const { buildDbManifestValues, renderK8sBase, rendersReplicationHostPort } = await import(
  '../../../src/lib/deploy/k8s/k3s.js'
);
const { configurePrimaryForReplication } = await import('../../../src/lib/deploy/k8s/ha/index.js');

function kustomize(path: string): Doc[] {
  const res = spawnSync('kubectl', ['kustomize', path], { cwd: ROOT, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`kustomize build failed:\n${res.stderr}`);
  return (loadAll(res.stdout) as Doc[]).filter(Boolean);
}

const values = () => ({
  ...buildDbManifestValues({
    dbImageTag: 'ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r1',
    s3Config: {
      bucket: 'proj-storage',
      walgPrefix: 'backups/proj/prod/walg',
      endpoint: 'https://sfo3.example',
      region: 'sfo3',
    },
    backupBucketName: 'proj-backups',
    walgRole: 'primary',
    storageClass: 'do-block-storage',
    walArchiveSha: '0123456789abcdef',
  }),
  MASTER_PRIVATE_IP: '10.10.0.2',
});

function renderedDbPorts(opts?: { replicationHostPort?: boolean }) {
  const rendered = renderK8sBase(BASE, values(), undefined, TEST_TLS, opts);
  try {
    const sts = kustomize(rendered).find(
      (d) => d.kind === 'StatefulSet' && d.metadata?.name === 'db',
    );
    const db = sts.spec.template.spec.containers.find((c: Doc) => c.name === 'db');
    return db.ports as Doc[];
  } finally {
    rmSync(rendered, { recursive: true, force: true });
  }
}

describe('the HA db StatefulSet carries its replication hostPort from its first apply', () => {
  it('renders 127.0.0.1:5433 -> 5432 into the one postgres port entry', () => {
    expect(renderedDbPorts({ replicationHostPort: true })).toEqual([
      {
        name: 'postgres',
        containerPort: 5432,
        protocol: 'TCP',
        hostPort: 5433,
        hostIP: '127.0.0.1',
      },
    ]);
  }, 60_000);

  it('a single cluster keeps its db cluster-internal (no hostPort at all)', () => {
    const ports = renderedDbPorts();
    expect(ports).toHaveLength(1);
    expect(ports[0]).not.toHaveProperty('hostPort');
    expect(ports[0]).not.toHaveProperty('hostIP');
  }, 60_000);

  it('the source tree is untouched by the HA render', () => {
    renderedDbPorts({ replicationHostPort: true });
    expect(readFileSync(join(BASE, 'db', 'kustomization.yaml'), 'utf-8')).not.toMatch(/patches/);
  }, 60_000);

  it('both HA roles render it (a promoted standby needs no restart); a single cluster does not', () => {
    expect(rendersReplicationHostPort('primary')).toBe(true);
    expect(rendersReplicationHostPort('standby')).toBe(true);
    expect(rendersReplicationHostPort(undefined)).toBe(false);
  });

  it('applyK3sManifests hands the role decision to the base render', () => {
    const src = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const fn = src.slice(src.indexOf('export async function applyK3sManifests'));
    expect(fn.slice(0, fn.indexOf('renderK8sBase(') + 1200)).toMatch(
      /replicationHostPort:\s*rendersReplicationHostPort\(role\)/,
    );
  });
});

describe('configurePrimaryForReplication never restarts the primary db', () => {
  beforeEach(() => {
    calls.length = 0;
    liveHostPort = 5433;
  });

  const run = () =>
    configurePrimaryForReplication({
      primaryIp: '203.0.113.10',
      sshKeyPath: '/tmp/vibecarbon-test-key',
    });

  it('reads the hostPort and issues no StatefulSet or pod mutation', async () => {
    await run();
    const remote = calls.filter((c) => c.startsWith('ssh'));
    expect(remote.some((c) => c.includes('get statefulset db'))).toBe(true);
    for (const c of remote) {
      expect(c).not.toMatch(
        /patch statefulset|rollout (status|restart)|delete pod|scale statefulset/,
      );
    }
    // The replication SQL and pg_hba still land, by exec into the running pod.
    expect(remote.some((c) => c.includes('psql -U postgres'))).toBe(true);
  });

  it('refuses, naming the fix, when the live db has no replication hostPort', async () => {
    liveHostPort = null;
    const err = (await run().catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/hostPort/);
    expect(err.message).toMatch(/vibecarbon deploy/);
    // Read-only: it did not try to patch it in.
    expect(calls.some((c) => c.includes('patch statefulset'))).toBe(false);
  });
});
