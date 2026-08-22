import { describe, expect, it, vi } from 'vitest';

// d1 regression: the compose scale/replacement path's createServer() call
// omitted `image` entirely and reused a raw loadCloudInitScript() userData
// unconditionally, counting on HetznerProvider.createServer's own
// `image || 'docker-ce'` fallback. DigitalOceanProvider.createServer has no
// such fallback, so a DO scale sent NO image field at all and DO rejected
// the droplet create with "invalid image for Droplet creation". Fix: image
// + user-data are resolved from the Provider class's own COMPOSE_IMAGE /
// getComposeUserData() statics (see base.js's "Compose-tier
// replacement-server identity" doc block) via buildReplacementServerArgs.

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: { info() {}, warn() {}, error() {}, step() {}, success() {} },
    note() {},
    outro() {},
  };
});

vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));

vi.mock('../../../src/lib/command.js', () => ({
  runCommand: vi.fn(() => ''),
}));

vi.mock('../../../src/lib/config.js', () => ({
  saveProjectConfig: vi.fn(),
}));

// Stubs `fetchWithRetry`, which transparently intercepts calls made through
// `apiRequest` too, since apiRequest dynamically imports fetch-retry.js and
// vi.mock intercepts by resolved specifier, not import site (see
// digitalocean-methods.test.ts's file-level doc for the same precedent).
const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

const { buildReplacementServerArgs } = await import('../../../src/scale.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');
const { loadCloudInitScript } = await import('../../../src/lib/deploy/compose/index.js');
const { loadDoComposeUserData } = await import(
  '../../../src/lib/iac/programs/digitalocean-compose.js'
);

const baseArgs = {
  name: 'proj-prod-new',
  serverType: 'cpx31',
  region: 'fsn1',
  sshKeyId: 42,
  firewallId: 'fw-1',
  projectName: 'proj',
  environment: 'prod',
};

describe('buildReplacementServerArgs — image + user-data are provider-owned', () => {
  it('resolves HetznerProvider.COMPOSE_IMAGE and getComposeUserData() for a Hetzner replacement server', async () => {
    const args = await buildReplacementServerArgs(HetznerProvider, baseArgs);
    expect(args.image).toBe('docker-ce');
    expect(args.image).toBe(HetznerProvider.COMPOSE_IMAGE);
    expect(args.userData).toBe(loadCloudInitScript());
  });

  it('resolves DigitalOceanProvider.COMPOSE_IMAGE and getComposeUserData() for a DO replacement server — never the Hetzner image/user-data', async () => {
    const args = await buildReplacementServerArgs(DigitalOceanProvider, baseArgs);
    expect(args.image).toBe('ubuntu-24-04-x64');
    expect(args.image).toBe(DigitalOceanProvider.COMPOSE_IMAGE);
    expect(args.image).not.toBe('docker-ce');
    expect(args.userData).toBe(loadDoComposeUserData());
    expect(args.userData).not.toBe(loadCloudInitScript());
  });

  it('passes through serverType/region/sshKeys/firewalls/labels unchanged regardless of provider', async () => {
    const args = await buildReplacementServerArgs(HetznerProvider, baseArgs);
    expect(args.name).toBe('proj-prod-new');
    expect(args.serverType).toBe('cpx31');
    expect(args.region).toBe('fsn1');
    expect(args.sshKeys).toEqual([42]);
    expect(args.firewalls).toEqual(['fw-1']);
    expect(args.labels).toEqual({
      'managed-by': 'vibecarbon',
      project: 'proj',
      environment: 'prod',
    });
  });

  it('omits firewalls entirely when no firewallId is given', async () => {
    const args = await buildReplacementServerArgs(HetznerProvider, {
      ...baseArgs,
      firewallId: undefined,
    });
    expect(args.firewalls).toEqual([]);
  });
});

describe('createServer wire-level ssh-key contract — canonical arg name pinned across providers', () => {
  // scale.js is the ONLY caller of provider.createServer() in this repo
  // (Pulumi programs build Droplet/Server resources directly, they don't go
  // through this method), and per the 'passes through' test above it sends
  // `sshKeys: [id]` (array), NOT the singular `sshKeyId` base.js's abstract
  // doc names. HetznerProvider already handled both shapes; DO only handled
  // a THIRD, unused name (`sshKeyIds`) — d1 regression: nothing ever sent
  // that key, so DO silently POSTed a keyless droplet and live scale failed
  // with "SSH did not become available on new server". These four tests
  // drive both providers with both accepted shapes through the same
  // fetch-retry stub so a future name drift on either provider fails loudly
  // instead of silently keyless-provisioning again.

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  const okResponse = (body: unknown) => ({ ok: true, status: 201, json: async () => body });

  it('Hetzner: the real scale.js shape (sshKeys array) populates ssh_keys', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(okResponse({ server: { id: 1 } }));
    const provider = new HetznerProvider('tok');

    await provider.createServer({ name: 'n', serverType: 'cpx31', region: 'fsn1', sshKeys: [42] });

    const body = JSON.parse((fetchWithRetryMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.ssh_keys).toEqual([42]);
  });

  it('Hetzner: the sshKeyId singular fallback populates ssh_keys', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(okResponse({ server: { id: 1 } }));
    const provider = new HetznerProvider('tok');

    await provider.createServer({ name: 'n', serverType: 'cpx31', region: 'fsn1', sshKeyId: 42 });

    const body = JSON.parse((fetchWithRetryMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.ssh_keys).toEqual([42]);
  });

  it('DigitalOcean: the real scale.js shape (sshKeys array) populates ssh_keys', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(okResponse({ droplets: [], links: {} }))
      .mockResolvedValueOnce(okResponse({ droplet: { id: 1 } }));
    const provider = new DigitalOceanProvider('tok');

    await provider.createServer({
      name: 'n',
      region: 'nyc3',
      serverType: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      sshKeys: [42],
      labels: {},
    });

    const body = JSON.parse((fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.ssh_keys).toEqual([42]);
  });

  it('DigitalOcean: the sshKeyId singular fallback populates ssh_keys', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(okResponse({ droplets: [], links: {} }))
      .mockResolvedValueOnce(okResponse({ droplet: { id: 1 } }));
    const provider = new DigitalOceanProvider('tok');

    await provider.createServer({
      name: 'n',
      region: 'nyc3',
      serverType: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      sshKeyId: 42,
      labels: {},
    });

    const body = JSON.parse((fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.ssh_keys).toEqual([42]);
  });
});

describe('createServer firewall-attach contract — a replacement server is never unfirewalled', () => {
  // `vibecarbon scale` blue-green-replaces a compose server by calling
  // provider.createServer() directly, OUTSIDE Pulumi, then deletes the old
  // (firewalled) one. It passed `firewallId: envConfig.firewallId` — a key no
  // writer has ever set — so `firewalls` was always [] and every replacement
  // server came up with no cloud firewall: SSH world-reachable, and the
  // pooler's 5432/6543 (operator-CIDR-scoped since #251) world-open.
  //
  // The fix persists firewallId per SERVER (compose-ha gives each node its own
  // firewall, one per stack) and both providers now honor `firewalls`.
  //
  // Hetzner attaches at create. DO has no create-time field, and its COMPOSE
  // firewall scopes by `dropletIds` — NOT by tag like its k8s one, which is
  // what the old "accepted but ignored" comment assumed — so DO needs an
  // explicit second call. Both are pinned here so neither surface can drift
  // back on its own.

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  const okResponse = (body: unknown) => ({ ok: true, status: 201, json: async () => body });

  it('Hetzner: attaches at create via the firewalls body field', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(okResponse({ server: { id: 1 } }));
    const provider = new HetznerProvider('tok');

    await provider.createServer({
      name: 'n',
      serverType: 'cpx31',
      region: 'fsn1',
      sshKeys: [42],
      firewalls: ['fw-1'],
    });

    const body = JSON.parse((fetchWithRetryMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.firewalls).toEqual([{ firewall: 'fw-1' }]);
  });

  it('DigitalOcean: POSTs the new droplet onto the firewall after create', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(okResponse({ droplets: [], links: {} })) // findServersByName
      .mockResolvedValueOnce(okResponse({ droplet: { id: 77 } })) // create
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) }); // attach
    const provider = new DigitalOceanProvider('tok');

    await provider.createServer({
      name: 'n',
      region: 'nyc3',
      serverType: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      sshKeys: [42],
      labels: {},
      firewalls: ['fw-1'],
    });

    const [url, init] = fetchWithRetryMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('/firewalls/fw-1/droplets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ droplet_ids: [77] });
  });

  it('DigitalOcean: deletes the droplet and throws when the attach fails (never leaves it unfirewalled)', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(okResponse({ droplets: [], links: {} }))
      .mockResolvedValueOnce(okResponse({ droplet: { id: 77 } }))
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ message: 'nope' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) }); // the cleanup DELETE
    const provider = new DigitalOceanProvider('tok');

    await expect(
      provider.createServer({
        name: 'n',
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        sshKeys: [42],
        labels: {},
        firewalls: ['fw-1'],
      }),
    ).rejects.toThrow(/could not be attached to firewall/);

    const deleteCall = fetchWithRetryMock.mock.calls.find(
      (call) => (call[1] as RequestInit)?.method === 'DELETE',
    );
    expect(deleteCall, 'the orphaned droplet must be deleted, not left running').toBeDefined();
    expect(deleteCall?.[0]).toContain('/droplets/77');
  });

  it('DigitalOcean: makes no attach call when no firewalls are given', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(okResponse({ droplets: [], links: {} }))
      .mockResolvedValueOnce(okResponse({ droplet: { id: 77 } }));
    const provider = new DigitalOceanProvider('tok');

    await provider.createServer({
      name: 'n',
      region: 'nyc3',
      serverType: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      sshKeys: [42],
      labels: {},
    });

    expect(fetchWithRetryMock.mock.calls).toHaveLength(2);
  });
});
