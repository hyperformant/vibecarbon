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
 * explicit `false`, a kubeconfig with more than one cluster); readers leave
 * the file exactly as it is; and the two writers, both owned by the deploy,
 * replace the file atomically: fetchKubeconfig (scp into a 0600 temp beside
 * it, the field, then a rename) and upgradeKubeconfig (a resumed deploy's
 * stored copy). A failed write leaves the old file and no temp behind.
 *
 * Why readers never write: a reader that rewrites the file races the deploy
 * writing it. It can read the old copy, lose the race to the deploy's rename,
 * then rename its stale copy over the new one (the old cluster's CA and
 * address after a re-provision), or save a partial scp for good.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';

// The copy off the master: each test says what lands at the destination.
let scpImpl: (args: string[]) => Promise<unknown> = async () => {};
vi.mock('../../../src/lib/ssh.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  scpWithRetry: vi.fn((args: string[]) => scpImpl(args)),
}));

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

const OLD = new Date('2026-01-01T00:00:00Z');

/** A kubeconfig an older CLI wrote: no field, 0644, an old mtime. */
function oldKubeconfig(dir: string, stack: string) {
  const path = join(dir, '.vibecarbon', `kubeconfig-${stack}`);
  writeFileSync(path, K3S_YAML, { mode: 0o644 });
  chmodSync(path, 0o644);
  utimesSync(path, OLD, OLD);
  return path;
}

/** Nothing but the kubeconfig itself in .vibecarbon: no temp file left behind. */
const leftovers = (dir: string) =>
  readdirSync(join(dir, '.vibecarbon')).filter((f) => !/^kubeconfig-[\w-]+$/.test(f));

describe('localKubeconfigPath (every reader)', () => {
  it('resolves the path and leaves an old kubeconfig exactly as it is', () => {
    const dir = tempProject();
    const path = oldKubeconfig(dir, 'prod');
    expect(localKubeconfigPath(dir, 'prod')).toBe(path);
    expect(readFileSync(path, 'utf-8')).toBe(K3S_YAML);
    expect(statSync(path).mtimeMs).toBe(OLD.getTime());
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('a missing kubeconfig stays missing', () => {
    const dir = tempProject();
    expect(localKubeconfigPath(dir, 'staging-standby')).toBe(
      join(dir, '.vibecarbon', 'kubeconfig-staging-standby'),
    );
    expect(() => statSync(join(dir, '.vibecarbon', 'kubeconfig-staging-standby'))).toThrow();
  });
});

describe('upgradeKubeconfig (a resumed deploy, the writer, on its own stored copy)', () => {
  it('replaces an old kubeconfig with one carrying the field, 0600, no temp left', async () => {
    const dir = tempProject();
    const path = oldKubeconfig(dir, 'prod');
    expect(await upgradeKubeconfig(path)).toBe(path);
    expect(parse(readFileSync(path, 'utf-8')).clusters[0].cluster['disable-compression']).toBe(
      true,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(leftovers(dir)).toEqual([]);
  });

  it('does not rewrite a kubeconfig that already carries the field', async () => {
    const dir = tempProject();
    const path = join(dir, '.vibecarbon', 'kubeconfig-prod');
    writeFileSync(path, withCompressionDisabled(K3S_YAML), { mode: 0o600 });
    utimesSync(path, OLD, OLD);
    await upgradeKubeconfig(path);
    expect(statSync(path).mtimeMs).toBe(OLD.getTime());
  });
});

const fetchInto = (dir: string, stack: string) =>
  fetchKubeconfig(
    '203.0.113.9',
    '/tmp/key',
    join(dir, '.vibecarbon', `known_hosts_${stack}`),
    dir,
    stack,
  );

describe('fetchKubeconfig (the deploy, the writer)', () => {
  it('copies into a 0600 temp beside the kubeconfig, then renames it in with the field', async () => {
    const dir = tempProject();
    const path = oldKubeconfig(dir, 'prod-standby');
    let dest = '';
    let modeAtCopy = 0;
    scpImpl = async (args) => {
      dest = args[args.length - 1];
      modeAtCopy = statSync(dest).mode & 0o777;
      // Mid-copy, a reader still sees the old kubeconfig, whole.
      expect(readFileSync(path, 'utf-8')).toBe(K3S_YAML);
      writeFileSync(dest, K3S_YAML);
    };

    expect(await fetchInto(dir, 'prod-standby')).toBe(path);

    expect(dest).not.toBe(path);
    expect(dest.startsWith(join(dir, '.vibecarbon'))).toBe(true);
    // The admin key never sits in a file anyone else can read.
    expect(modeAtCopy).toBe(0o600);
    const cfg = parse(readFileSync(path, 'utf-8'));
    expect(cfg.clusters[0].cluster.server).toBe('https://203.0.113.9:6443');
    expect(cfg.clusters[0].cluster['disable-compression']).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(leftovers(dir)).toEqual([]);
  });

  it('a failed copy leaves the old kubeconfig untouched and no temp behind', async () => {
    const dir = tempProject();
    const path = oldKubeconfig(dir, 'prod');
    // A partial copy, then the transfer dies.
    scpImpl = async (args) => {
      writeFileSync(args[args.length - 1], K3S_YAML.slice(0, 40));
      throw new Error('scp: lost connection');
    };

    await expect(fetchInto(dir, 'prod')).rejects.toThrow('scp: lost connection');

    expect(readFileSync(path, 'utf-8')).toBe(K3S_YAML);
    expect(statSync(path).mtimeMs).toBe(OLD.getTime());
    expect(leftovers(dir)).toEqual([]);
  });
});
