/**
 * Flux reads the project's repo with a read-only deploy key of its own, one
 * per cluster (flux-deploy-key.js): made fresh on every `configure cicd`,
 * added at GitHub with `gh`, written whole into the cluster's flux-system
 * Secret with GitHub's published host keys, and the key it replaces removed.
 * The private half goes to kubectl on stdin and nowhere else. gh and kubectl
 * are fakes here; the order of what they were asked is the contract.
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../_shared/source-files.js';

type Call = { tool: 'gh' | 'kubectl'; argv: string[]; input?: string; env?: NodeJS.ProcessEnv };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  gh: (_argv: string[]): string => '',
  kubectl: (_args: string[]): string => '',
}));

vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runCommandAsync: async (argv: string[], { input }: { input?: string } = {}) => {
    h.calls.push({ tool: 'gh', argv, input });
    return h.gh(argv);
  },
}));
vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runKubectlWithRetry: async (
    args: string[],
    { env, input }: { env?: NodeJS.ProcessEnv; input?: string } = {},
  ) => {
    h.calls.push({ tool: 'kubectl', argv: args, input, env });
    return h.kubectl(args);
  },
}));

const {
  addDeployKey,
  deployKeyTitle,
  fluxSystemSecretManifest,
  generateDeployKeyPair,
  githubKnownHosts,
  listDeployKeys,
  rotateFluxDeployKey,
} = await import('../../../src/lib/deploy/k8s/flux-deploy-key.js');
const { handOverCluster } = await import('../../../src/lib/deploy/k8s/flux-handover.js');

const MODULE = join(REPO_ROOT, 'src/lib/deploy/k8s/flux-deploy-key.js');
const kubeconfigPath = '/project/.vibecarbon/kubeconfig-prod';
const env = { KUBECONFIG: kubeconfigPath } as NodeJS.ProcessEnv;

/**
 * GitHub's three host keys, as `gh api meta --jq '.ssh_keys[]'` prints them
 * (the rsa one shortened).
 */
const HOST_KEYS = [
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr',
];
const KNOWN_HOSTS = HOST_KEYS.map((key) => `github.com ${key}\n`).join('');

/** What runCommandAsync throws for a gh that exited 1 with this stderr. */
const ghFailed = (argv: string[], stderr: string) =>
  Object.assign(new Error(`Command failed: ${argv.join(' ')}\n${stderr}`), { status: 1, stderr });

/**
 * A GitHub that answers the host keys, adds a key as `added`, and lists
 * `keys` with the added one among them, as it would after the add.
 */
const github =
  ({
    keys = [] as Array<{ id: number; title: string }>,
    added = 42,
    title = 'vibecarbon flux prod',
  } = {}) =>
  (argv: string[]) => {
    if (argv[2] === 'meta') return `${HOST_KEYS.join('\n')}\n`;
    if (argv.includes('POST')) return `${added}\n`;
    if (argv.includes('--paginate')) {
      return [...keys, { id: added, title }].map((k) => `${JSON.stringify(k)}\n`).join('');
    }
    if (argv.includes('DELETE')) return '';
    throw new Error(`unexpected gh ${argv.join(' ')}`);
  };

/** A cluster whose flux-system Secret exists (or not) and takes every write. */
const cluster =
  ({ secret = true } = {}) =>
  (args: string[]) =>
    args[0] === 'get' && args[1] === 'secret' && secret ? 'secret/flux-system\n' : '';

/** The objects a kubectl call can name, the first of which labels it. */
const OBJECTS = [
  'secret',
  'source-controller',
  'gitrepository/vibecarbon',
  'kustomization/vibecarbon-base',
];

/** One line per call: the tool, then what it did. */
const steps = () =>
  h.calls.map(({ tool, argv }) => {
    if (tool === 'kubectl') {
      const verb = argv[0] === '-n' ? argv[2] : argv[0];
      const object = argv.find((a) => OBJECTS.includes(a));
      return object ? `kubectl ${verb} ${object}` : `kubectl ${verb}`;
    }
    if (argv[2] === 'meta') return 'gh meta';
    if (argv.includes('POST')) return 'gh POST';
    if (argv.includes('--paginate')) return 'gh list';
    if (argv.includes('DELETE')) return `gh DELETE ${argv.at(-1)?.split('/').at(-1)}`;
    return `gh ${argv.slice(1).join(' ')}`;
  });

/** The SSH wire fields of a public key blob: each a uint32 length, then its bytes. */
function wireFields(blob: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let at = 0;
  while (at < blob.length) {
    const n = blob.readUInt32BE(at);
    fields.push(blob.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  expect(at).toBe(blob.length);
  return fields;
}

beforeEach(() => {
  h.calls.length = 0;
  h.gh = () => '';
  h.kubectl = () => '';
});

describe('generateDeployKeyPair', () => {
  it('makes an ed25519 pair whose public half is the private one', () => {
    const { privateKeyPem, publicKey } = generateDeployKeyPair();
    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
    // PKCS8 PEM, which Go's ssh.ParseRawPrivateKey (what Flux reads it with) takes.
    expect(privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
    const fields = wireFields(Buffer.from(publicKey.split(' ')[1], 'base64'));
    expect(fields).toHaveLength(2);
    const [type, key] = fields;
    expect(type.toString()).toBe('ssh-ed25519');
    const x = createPublicKey(privateKeyPem).export({ format: 'jwk' }).x as string;
    expect(key).toEqual(Buffer.from(x, 'base64url'));
    expect(key.length).toBe(32);
    // Fresh every call: a rerun never puts the same key back.
    const again = generateDeployKeyPair();
    expect(again.publicKey).not.toBe(publicKey);
    expect(again.privateKeyPem).not.toBe(privateKeyPem);
  });
});

describe('githubKnownHosts', () => {
  it("turns GitHub's published host keys into known_hosts lines", async () => {
    h.gh = github();
    await expect(githubKnownHosts()).resolves.toBe(KNOWN_HOSTS);
    expect(h.calls.map((c) => c.argv)).toEqual([['gh', 'api', 'meta', '--jq', '.ssh_keys[]']]);
  });

  it('refuses an empty or odd host key answer instead of trusting it', async () => {
    for (const answer of ['', '\n', 'ssh-ed25519 AAAA extra\n', '<html>rate limited</html>\n']) {
      h.gh = () => answer;
      await expect(githubKnownHosts(), JSON.stringify(answer)).rejects.toThrow(
        /github's published ssh host keys/,
      );
    }
  });
});

describe('addDeployKey', () => {
  it('adds a read-only key named for the cluster', async () => {
    const { publicKey } = generateDeployKeyPair();
    h.gh = () => '42\n';
    expect(deployKeyTitle('prod-standby')).toBe('vibecarbon flux prod-standby');
    await expect(
      addDeployKey({
        owner: 'acme',
        repo: 'shop',
        title: deployKeyTitle('prod-standby'),
        publicKey,
      }),
    ).resolves.toBe(42);
    expect(h.calls.map((c) => c.argv)).toEqual([
      [
        'gh',
        'api',
        '-X',
        'POST',
        'repos/acme/shop/keys',
        '-f',
        'title=vibecarbon flux prod-standby',
        '-f',
        `key=${publicKey}`,
        '-F',
        'read_only=true',
        '--jq',
        '.id',
      ],
    ]);
  });

  it('no admin rights: says who can fix it, and touches no cluster', async () => {
    h.gh = (argv) => {
      if (argv.includes('POST')) throw ghFailed(argv, 'gh: Not Found (HTTP 404)\n');
      return github()(argv);
    };
    const err = await rotateFluxDeployKey({
      env,
      owner: 'acme',
      repo: 'shop',
      envName: 'prod-standby',
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(
      'adding a deploy key to acme/shop needs admin rights on the repo. ' +
        'ask an admin to give you admin, or to run vibecarbon configure cicd prod',
    );
    expect(h.calls.filter((c) => c.tool === 'kubectl')).toEqual([]);
  });
});

describe('a refused add', () => {
  it('any other refusal reaches the operator as gh said it, and touches no cluster', async () => {
    // A 422: GitHub already has this key (a key is unique across GitHub).
    let refused: Error | undefined;
    h.gh = (argv) => {
      if (argv.includes('POST')) {
        refused = ghFailed(
          argv,
          'gh: Validation Failed (HTTP 422)\n{"message":"Validation Failed","errors":[{"resource":"PublicKey","code":"custom","field":"key","message":"key is already in use"}]}\n',
        );
        throw refused;
      }
      return github()(argv);
    };
    const err = await rotateFluxDeployKey({
      env,
      owner: 'acme',
      repo: 'shop',
      envName: 'prod',
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(refused).toBeDefined();
    expect(err).toBe(refused);
    expect(err?.message).toContain('key is already in use');
    expect(h.calls.filter((c) => c.tool === 'kubectl')).toEqual([]);
  });
});

describe('listDeployKeys', () => {
  it("a title with a tab and a newline in it stays that one key's title", async () => {
    // Read as `id<TAB>title` lines, this title would forge a second line
    // naming key 9 as this cluster's, and key 9 would be removed.
    const keys = [
      { id: 9, title: 'deploy bot' },
      { id: 10, title: 'notes\n9\tvibecarbon flux prod' },
    ];
    h.gh = () => keys.map((k) => `${JSON.stringify(k)}\n`).join('');
    await expect(listDeployKeys({ owner: 'acme', repo: 'shop' })).resolves.toEqual(keys);

    h.calls.length = 0;
    h.gh = github({ keys });
    h.kubectl = cluster();
    await expect(
      rotateFluxDeployKey({ env, owner: 'acme', repo: 'shop', envName: 'prod' }),
    ).resolves.toEqual({ keyId: 42, removed: [] });
    expect(steps().filter((s) => s.startsWith('gh DELETE'))).toEqual([]);
  });

  it('an answer that is not one key per line is refused, not guessed at', async () => {
    for (const answer of ['9\tdeploy bot\n', '{"id":"9","title":"deploy bot"}\n', '{"id":9}\n']) {
      h.gh = () => answer;
      await expect(
        listDeployKeys({ owner: 'acme', repo: 'shop' }),
        JSON.stringify(answer),
      ).rejects.toThrow(/did not answer with its deploy keys/);
    }
  });
});

describe('fluxSystemSecretManifest', () => {
  it('the Secret holds exactly identity, identity.pub and known_hosts', () => {
    const { privateKeyPem, publicKey } = generateDeployKeyPair();
    expect(
      load(fluxSystemSecretManifest({ privateKeyPem, publicKey, knownHosts: KNOWN_HOSTS })),
    ).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'flux-system', namespace: 'flux-system' },
      type: 'Opaque',
      stringData: {
        identity: privateKeyPem,
        'identity.pub': publicKey,
        known_hosts: KNOWN_HOSTS,
      },
    });
  });
});

describe('rotateFluxDeployKey', () => {
  const rotate = (envName = 'prod') =>
    rotateFluxDeployKey({ env, owner: 'acme', repo: 'shop', envName });

  it('rotates: new key, the Secret written whole, then the old key with the same title removed', async () => {
    h.gh = github({
      keys: [
        { id: 7, title: 'vibecarbon flux prod' },
        { id: 8, title: 'vibecarbon flux prod-standby' },
        { id: 9, title: 'deploy bot' },
      ],
    });
    h.kubectl = cluster();
    await expect(rotate()).resolves.toEqual({ keyId: 42, removed: [7] });
    // The old key goes only once the cluster holds the new one, so Flux is
    // never left with a key GitHub no longer has. The standby's key and the
    // repo's other keys stay.
    expect(steps()).toEqual([
      'gh meta',
      'gh POST',
      'kubectl get secret',
      'kubectl replace',
      'gh list',
      'gh DELETE 7',
    ]);
    expect(h.calls.find((c) => c.argv.includes('DELETE'))?.argv).toEqual([
      'gh',
      'api',
      '-X',
      'DELETE',
      'repos/acme/shop/keys/7',
    ]);
    expect(h.calls.find((c) => c.argv.includes('--paginate'))?.argv).toEqual([
      'gh',
      'api',
      'repos/acme/shop/keys',
      '--paginate',
      '--jq',
      '.[] | {id, title} | @json',
    ]);
    // The cluster's own kubeconfig, for every kubectl.
    expect(h.calls.filter((c) => c.tool === 'kubectl').every((c) => c.env === env)).toBe(true);
    // What went in is the Secret, whole, with the key GitHub just took.
    const write = h.calls.find((c) => c.argv[0] === 'replace');
    const secret = load(write?.input ?? '') as { stringData: Record<string, string> };
    expect(Object.keys(secret.stringData).sort()).toEqual([
      'identity',
      'identity.pub',
      'known_hosts',
    ]);
    expect(secret.stringData.known_hosts).toBe(KNOWN_HOSTS);
    const posted = h.calls.find((c) => c.argv.includes('POST'))?.argv ?? [];
    expect(posted).toContain(`key=${secret.stringData['identity.pub']}`);
  });

  it("a title that only starts like this cluster's is never removed", async () => {
    h.gh = github({
      keys: [
        { id: 5, title: 'vibecarbon flux prod-standby' },
        { id: 6, title: 'vibecarbon flux prod ' },
        { id: 7, title: 'Vibecarbon flux prod' },
      ],
    });
    h.kubectl = cluster();
    await expect(rotate()).resolves.toEqual({ keyId: 42, removed: [] });
    expect(steps().filter((s) => s.startsWith('gh DELETE'))).toEqual([]);
  });

  it('a first handover creates the Secret', async () => {
    h.gh = github();
    h.kubectl = cluster({ secret: false });
    await expect(rotate()).resolves.toEqual({ keyId: 42, removed: [] });
    expect(steps()).toEqual([
      'gh meta',
      'gh POST',
      'kubectl get secret',
      'kubectl create',
      'gh list',
    ]);
  });

  it('host keys it cannot read stop it before any key is added', async () => {
    h.gh = (argv) => (argv[2] === 'meta' ? '' : github()(argv));
    await expect(rotate()).rejects.toThrow(/github's published ssh host keys/);
    expect(steps()).toEqual(['gh meta']);
  });

  it('a Secret write that fails removes no key, and says why it failed', async () => {
    // kubectl can report a failure for a write the API server committed (a
    // lost response), so the cluster may hold either key: both stay at
    // GitHub, and the next run removes the one it does not write.
    h.gh = github({ keys: [{ id: 7, title: 'vibecarbon flux prod' }] });
    const refused = new Error(
      'flux: replace Secret/flux-system failed with exit 1: http2: client connection lost',
    );
    h.kubectl = (args) => {
      if (args[0] === 'replace') throw refused;
      return cluster()(args);
    };
    await expect(rotate()).rejects.toBe(refused);
    expect(steps()).toEqual(['gh meta', 'gh POST', 'kubectl get secret', 'kubectl replace']);
  });

  it('the next run removes a key a failed write left behind, by its title', async () => {
    // Key 41 is the one the failed run added; 7 the one before it.
    h.gh = github({
      keys: [
        { id: 7, title: 'vibecarbon flux prod' },
        { id: 41, title: 'vibecarbon flux prod' },
      ],
    });
    h.kubectl = cluster();
    await expect(rotate()).resolves.toEqual({ keyId: 42, removed: [7, 41] });
  });

  it('the private key rides stdin only and never touches disk', async () => {
    for (const secret of [true, false]) {
      h.calls.length = 0;
      h.gh = github({ keys: [{ id: 7, title: 'vibecarbon flux prod' }] });
      h.kubectl = cluster({ secret });
      const result = await rotate();
      expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
      for (const { argv } of h.calls) {
        expect(argv.join(' ')).not.toContain('PRIVATE KEY');
      }
      const withKey = h.calls.filter((c) => c.input?.includes('-----BEGIN PRIVATE KEY-----'));
      expect(withKey.map((c) => `${c.tool} ${c.argv.join(' ')}`)).toEqual([
        `kubectl ${secret ? 'replace' : 'create'} -f -`,
      ]);
    }
    const source = readFileSync(MODULE, 'utf-8');
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|mkdtemp|node:fs/);
  });
});

describe('handOverCluster with the deploy key', () => {
  it('a rerun with a key GitHub refuses fails at the GitRepository with what Flux says', async () => {
    // Flux installed and synced by an earlier run: the Secret is there and
    // both objects were Ready. The rotation puts the new key in; Flux, asked
    // to fetch with it, says GitHub refused it, and that is what fails.
    const refusal =
      "failed to checkout and determine revision: unable to clone 'ssh://git@github.com/acme/shop': " +
      'ssh: handshake failed: ssh: unable to authenticate, attempted methods [none publickey], no supported methods remain';
    h.gh = github({ keys: [{ id: 7, title: 'vibecarbon flux prod' }] });
    h.kubectl = (args) => {
      if (args.includes('source-controller')) return 'deployment.apps/source-controller\n';
      if (args[2] === 'get' && args[3] === 'gitrepository/vibecarbon') return `False\n${refusal}`;
      if (args[2] === 'get' && args[3] === 'kustomization/vibecarbon-base') return 'True\nApplied';
      return cluster()(args);
    };
    const err = await handOverCluster({
      projectDir: '/project',
      envName: 'prod',
      kubeconfigPath,
      owner: 'acme',
      repo: 'shop',
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain('flux tried to sync prod and could not. here is what it says:');
    expect(err?.message).toContain(`GitRepository: ${refusal}`);
    // The key was rotated first, then the source asked to fetch with it; the
    // base is never asked to apply what an old key fetched.
    expect(steps()).toEqual([
      'kubectl get source-controller',
      'gh meta',
      'gh POST',
      'kubectl get secret',
      'kubectl replace',
      'gh list',
      'gh DELETE 7',
      'kubectl apply',
      'kubectl annotate gitrepository/vibecarbon',
      'kubectl wait gitrepository/vibecarbon',
      'kubectl get gitrepository/vibecarbon',
    ]);
  });
});
