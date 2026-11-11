/**
 * The k8s manifest renders (src/lib/deploy/k8s/k3s.js) are temp copies of the
 * project's kustomize trees with the deploy's values filled in. Each is
 * removed once applied, and also when the render or anything between the
 * render and its apply throws: the rendered k8s/base used to stay behind when
 * the cert-manager leader wait that sits between them failed. A base render
 * that refuses its own result (a placeholder left over) removes the copy too.
 *
 * applyK3sManifests runs for real with node's `spawn` mocked (every kubectl
 * succeeds) and the leader wait made to fail.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';
import { certManagerLeaderStdout } from '../helpers/cert-manager-leader-fixture.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../../../src/lib/deploy/layer-delta.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  deliverImage: vi.fn(async () => ({ bytes: 0, layersSent: 0, layersReused: 0 })),
}));
// The leader wait fails, after recording which renders existed when it ran.
const leader = vi.hoisted(() => ({ rendersAtWait: [] as string[] }));
vi.mock('../../../src/lib/deploy/k8s/readiness.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  awaitCertManagerLeader: vi.fn(async () => {
    leader.rendersAtWait = renders();
    throw new Error('LEADER_NEVER_SETTLED');
  }),
}));

const { applyK3sManifests, buildDbManifestValues, renderK8sBase, renderTraefikCrds } = await import(
  '../../../src/lib/deploy/k8s/k3s.js'
);

function child(stdout = '') {
  const c: Record<string, unknown> = {
    stdout: {
      on(ev: string, cb: (b: Buffer) => void) {
        if (ev === 'data' && stdout) Promise.resolve().then(() => cb(Buffer.from(stdout)));
      },
    },
    stderr: { on() {} },
    stdin: { write() {}, end() {} },
    kill() {},
    unref() {},
    on(ev: string, cb: (code: number) => void) {
      if (ev === 'exit' || ev === 'close') Promise.resolve().then(() => cb(0));
      return c;
    },
  };
  return c as unknown as ReturnType<typeof spawn>;
}

const REPO = join(__dirname, '../../..');

function projectDir() {
  const dir = createTempDir('vc-k8s-render-project-');
  mkdirSync(join(dir, 'k8s', 'base', 'db'), { recursive: true });
  writeFileSync(join(dir, 'k8s', 'base', 'kustomization.yaml'), 'resources:\n  - db/\n');
  writeFileSync(
    join(dir, 'k8s', 'base', 'db', 'statefulset.yaml'),
    readFileSync(join(REPO, 'carbon/k8s/base/db/statefulset.yaml'), 'utf-8'),
  );
  mkdirSync(join(dir, 'k8s', 'infra', 'traefik-crds'), { recursive: true });
  writeFileSync(
    join(dir, 'k8s', 'infra', 'traefik-crds', 'kustomization.yaml'),
    readFileSync(join(REPO, 'carbon/k8s/infra/traefik-crds/kustomization.yaml'), 'utf-8'),
  );
  return dir;
}

function args() {
  const dir = projectDir();
  return {
    kubeconfig: join(dir, 'kubeconfig'),
    projectDir: dir,
    projectName: 'proj',
    imageTag: '10.0.1.1:5000/proj:abc-20260101000000',
    dbImageTag: 'ghcr.io/org/postgres:17-walg',
    envLocal: {
      ADMIN_EMAIL: 'a@example.test',
      ADMIN_PASSWORD: 'pw',
      BETTER_AUTH_SECRET: 'x'.repeat(40),
    },
    domain: 'app.example.test',
    restore: null,
    apiToken: 'token',
    providerId: 'hetzner',
    ProviderClass: {
      PROVIDER_ID_PREFIX: 'hcloud://',
      K8S_IMAGE: 'ubuntu-26.04',
      K8S_STORAGE_CLASS: 'hcloud-volumes',
      async getK8sWorkerUserData() {
        return '#cloud-config\n';
      },
    },
    region: 'nbg1',
    environment: 'prod',
    minWorkers: 1,
    maxWorkers: 3,
    workerServerType: 'cx23',
    dbPrivateIp: '10.0.1.2',
    k3sToken: 'k3s-token',
    masterIp: '1.2.3.4',
    sshKeyPath: '/tmp/key',
    khPath: join(dir, 'known_hosts'),
    perfPrefix: 'k3s',
  };
}

/** The k8s renders this file's code under test left in the OS temp dir. */
const renders = () =>
  readdirSync(tmpdir()).filter((n) => /^vibecarbon-(k8s|cert-manager)-/.test(n));

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

beforeEach(() => {
  leader.rendersAtWait = [];
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(((cmd: string, a: string[] = []) =>
    child(certManagerLeaderStdout(cmd, a) ?? '')) as unknown as typeof spawn);
});

describe('the k8s manifest renders', () => {
  it('the rendered k8s/base is removed when the leader wait after it fails', async () => {
    await expect(applyK3sManifests(args() as never)).rejects.toThrow('LEADER_NEVER_SETTLED');
    // The base was rendered before the wait, and nothing of it is left.
    expect(leader.rendersAtWait).toEqual([expect.stringMatching(/^vibecarbon-k8s-base-base-/)]);
    expect(renders()).toEqual([]);
  });

  it('a base render it refuses to apply removes its copy', () => {
    const src = createTempDir('vc-k8s-render-src-');
    mkdirSync(join(src, 'db'));
    writeFileSync(
      join(src, 'db', 'statefulset.yaml'),
      `# {{NEVER_FILLED}}\n${readFileSync(join(REPO, 'carbon/k8s/base/db/statefulset.yaml'), 'utf-8')}`,
    );
    const values = {
      ...buildDbManifestValues({
        dbImageTag: 'ghcr.io/org/postgres:17-walg1',
        storageClass: 'provider-csi',
        walArchiveSha: 'abc',
      }),
      MASTER_PRIVATE_IP: '10.0.1.1',
    };
    const tls = {
      dnsNames: ['app.example.test'],
      issuerName: 'letsencrypt-prod',
      effectiveIssuer: 'letsencrypt-prod',
    };
    expect(() => renderK8sBase(src, values, undefined, tls)).toThrow(
      /db\/statefulset\.yaml still carries \{\{NEVER_FILLED\}\}/,
    );
    expect(renders()).toEqual([]);
  });

  it.skipIf(isRoot)('a render that fails partway removes its copy', () => {
    const src = createTempDir('vc-k8s-render-src-');
    writeFileSync(join(src, 'kustomization.yaml'), 'resources: []\n');
    const unreadable = join(src, 'z-unreadable.yaml');
    writeFileSync(unreadable, 'x');
    chmodSync(unreadable, 0o000);
    try {
      expect(() => renderTraefikCrds(src)).toThrow(/EACCES/);
      expect(renders()).toEqual([]);
    } finally {
      chmodSync(unreadable, 0o600);
    }
  });
});
