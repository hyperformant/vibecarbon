/**
 * The operator's kubeconfig turns off API response compression for every
 * cluster entry (`disable-compression: true`, src/lib/kubeconfig.js).
 *
 * Why: on DO k8s-ha the tor1 standby's kubectl round trips were slow while the
 * servers were not. `kubectl get --raw /openapi/v2` took 2.25 s compressed
 * against 0.75 s with `--disable-compression` (12-17 s against 1.9 s in an
 * evening window), and kubectl downloads about 4.7 MB of OpenAPI documents per
 * cluster on a cold deploy. kubectl and helm honor the field since client-go
 * 1.26 (the deploy preflight already refuses kubectl older than 1.27).
 *
 * Covered here: the pure text transform (k3s.yaml shape, idempotence, an
 * explicit `false`, a kubeconfig with more than one cluster), the upgrade of a
 * kubeconfig an older CLI wrote (in place, 0600, no write when nothing
 * changes), and fetchKubeconfig writing the field into a fresh copy.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const { localKubeconfigPath, operatorKubeconfigText, upgradeKubeconfig, withCompressionDisabled } =
  await import('../../../src/lib/kubeconfig.js');
const { fetchKubeconfig } = await import('../../../src/lib/deploy/k8s/k3s.js');

/** The file k3s writes at /etc/rancher/k3s/k3s.yaml (credentials shortened). */
const K3S_YAML = `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==
    server: https://127.0.0.1:6443
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
kind: Config
preferences: {}
users:
- name: default
  user:
    client-certificate-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==
    client-key-data: LS0tLS1CRUdJTiBFQyBQUklWQVRFIEtFWS0tLS0tCg==
`;

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
const parse = (text: string) => load(text) as any;

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-kubeconfig-'));
  mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
  return dir;
}

describe('withCompressionDisabled', () => {
  it('adds disable-compression: true to the k3s.yaml cluster and changes nothing else', () => {
    const out = withCompressionDisabled(K3S_YAML);
    const before = parse(K3S_YAML);
    const after = parse(out);
    expect(after.clusters[0].cluster['disable-compression']).toBe(true);
    delete after.clusters[0].cluster['disable-compression'];
    expect(after).toEqual(before);
    // Same indentation as its sibling fields.
    expect(out).toMatch(/\n {4}disable-compression: true\n/);
  });

  it('is idempotent', () => {
    const once = withCompressionDisabled(K3S_YAML);
    expect(withCompressionDisabled(once)).toBe(once);
  });

  it('turns an explicit false into true', () => {
    const off = K3S_YAML.replace(
      '    server: https://127.0.0.1:6443\n',
      '    disable-compression: false\n    server: https://127.0.0.1:6443\n',
    );
    const out = withCompressionDisabled(off);
    expect(parse(out).clusters[0].cluster['disable-compression']).toBe(true);
    expect(out.match(/disable-compression/g)).toHaveLength(1);
  });

  it('covers every cluster entry, in either key order', () => {
    const two = `apiVersion: v1
kind: Config
clusters:
  - cluster:
      server: https://203.0.113.1:6443
    name: one
  - name: two
    cluster:
      certificate-authority-data: AAAA
      server: https://203.0.113.2:6443
contexts:
  - context:
      cluster: one
      user: u
    name: one
users:
  - name: u
    user:
      token: x
`;
    const after = parse(withCompressionDisabled(two));
    expect(after.clusters.map((c: { cluster: object }) => c.cluster)).toEqual([
      { server: 'https://203.0.113.1:6443', 'disable-compression': true },
      {
        'certificate-authority-data': 'AAAA',
        server: 'https://203.0.113.2:6443',
        'disable-compression': true,
      },
    ]);
    // A context's `cluster: one` reference is not a cluster entry.
    expect(after.contexts[0].context).toEqual({ cluster: 'one', user: 'u' });
  });
});

describe('operatorKubeconfigText', () => {
  it('points the cluster at the master and turns compression off', () => {
    const cfg = parse(operatorKubeconfigText(K3S_YAML, '203.0.113.7'));
    expect(cfg.clusters[0].cluster.server).toBe('https://203.0.113.7:6443');
    expect(cfg.clusters[0].cluster['disable-compression']).toBe(true);
  });
});

describe('upgradeKubeconfig / localKubeconfigPath (a kubeconfig an older CLI wrote)', () => {
  it('adds the field in place and keeps the file 0600', () => {
    const dir = tempProject();
    const path = join(dir, '.vibecarbon', 'kubeconfig-prod');
    writeFileSync(path, K3S_YAML, { mode: 0o644 });
    chmodSync(path, 0o644);

    expect(localKubeconfigPath(dir, 'prod')).toBe(path);
    const cfg = parse(readFileSync(path, 'utf-8'));
    expect(cfg.clusters[0].cluster['disable-compression']).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('does not rewrite a kubeconfig that already carries the field', () => {
    const dir = tempProject();
    const path = join(dir, '.vibecarbon', 'kubeconfig-prod');
    writeFileSync(path, withCompressionDisabled(K3S_YAML), { mode: 0o600 });
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(path, old, old);
    upgradeKubeconfig(path);
    expect(statSync(path).mtimeMs).toBe(old.getTime());
  });

  it('a missing kubeconfig is left missing: the path still resolves', () => {
    const dir = tempProject();
    expect(localKubeconfigPath(dir, 'staging-standby')).toBe(
      join(dir, '.vibecarbon', 'kubeconfig-staging-standby'),
    );
    expect(() => statSync(join(dir, '.vibecarbon', 'kubeconfig-staging-standby'))).toThrow();
  });
});

describe('fetchKubeconfig', () => {
  it('writes the copied k3s.yaml with the master address and the field, 0600', async () => {
    const dir = tempProject();
    const path = join(dir, '.vibecarbon', 'kubeconfig-prod-standby');
    // The scp lands the master's k3s.yaml at the destination path.
    vi.mocked(spawn).mockImplementationOnce(((_cmd: string, args: string[]) => {
      writeFileSync(args[args.length - 1], K3S_YAML, { mode: 0o644 });
      const child = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on(event: string, cb: (code: number) => void) {
          if (event === 'close') Promise.resolve().then(() => cb(0));
          return child;
        },
      };
      return child;
    }) as unknown as typeof spawn);

    const out = await fetchKubeconfig(
      '203.0.113.9',
      '/tmp/key',
      join(dir, '.vibecarbon', 'known_hosts_prod-standby'),
      dir,
      'prod-standby',
    );

    expect(out).toBe(path);
    const cfg = parse(readFileSync(path, 'utf-8'));
    expect(cfg.clusters[0].cluster.server).toBe('https://203.0.113.9:6443');
    expect(cfg.clusters[0].cluster['disable-compression']).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
