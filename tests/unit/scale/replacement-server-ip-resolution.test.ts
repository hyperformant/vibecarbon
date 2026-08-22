import { beforeEach, describe, expect, it, vi } from 'vitest';

// d1 rig-loop regression (scale iteration 2, live DO evidence): the
// replacement-server flow read the new server's IP straight off
// `createServer`'s return value via `Provider.getPublicIP(newServer)`,
// BEFORE `waitForServer` resolved. That raced two Hetzner-shaped
// assumptions:
//   1. Field shape — Hetzner's server object nests the IP at
//      `public_net.ipv4.ip`; DigitalOcean's droplet nests it at
//      `networks.v4[].ip_address`. Using the wrong extractor on a DO
//      response silently returns null (getPublicIP is null-safe).
//   2. Timing — Hetzner assigns the IP synchronously at create time; DO
//      assigns it asynchronously (202 + an empty `networks` list), so even
//      calling the CORRECT extractor immediately after createServer can
//      still return null on DO.
// Net effect on live DO: "New server created: null" then "SSH did not
// become available on new server null".
//
// Fix: resolve the IP from the object `waitForServer` returns (both
// providers' waitForServer only resolves once the server is active AND has
// a public IP), not from createServer's immediate return.

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

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    backupCompose: async () => {},
    waitForSSH: vi.fn(async () => true),
    setupServer: async () => {},
    setupServerFiles: async () => {},
    pullComposeImages: async () => {},
    startComposeStack: async () => {},
    restoreCompose: async () => {},
    dockerLoginOnServer: async () => {},
    isLocalOnlyImageTag: () => false,
    setupComposeBackupCron: async () => {},
  };
});

vi.mock('../../../src/lib/build.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getGHCRCredentials: async () => ({}) };
});

vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, sshRun: async () => '', sshRunScript: async () => '' };
});

const { SCALE_EFFECTS } = await import('../../../src/scale.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');
const composeDeploy = await import('../../../src/lib/deploy/compose/index.js');

function makeCtx(
  Provider: typeof HetznerProvider | typeof DigitalOceanProvider,
  provider: Record<string, unknown>,
) {
  return {
    tier: 'compose',
    provider,
    Provider,
    newType: 'x',
    region: 'r1',
    sshKeyId: 42,
    envConfig: {},
    projectName: 'myapp',
    environment: 'prod',
    sshKeyPath: '/key',
    domain: null,
    services: {},
    dnsChallenge: true,
    dnsProvider: null,
    apiToken: 'tok',
    targetServers: [{ ip: '1.1.1.1', id: 'old-id' }],
  };
}

describe('scaleServers — replacement-server IP resolved via waitForServer, not createServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DigitalOcean: createServer returns an IP-less droplet (async assignment); IP must come from waitForServer', async () => {
    const waitForServerCalls: unknown[] = [];
    const provider = {
      createServer: vi.fn(async () => ({
        id: 'do-new-id',
        // DO's real create response: 202 + empty networks — no public IP yet.
        server: { id: 'do-new-id', status: 'new', networks: { v4: [] } },
      })),
      waitForServer: vi.fn(async (id: string) => {
        waitForServerCalls.push(id);
        // Resolved droplet, now active WITH its public IP populated.
        return {
          id,
          status: 'active',
          networks: { v4: [{ type: 'public', ip_address: '203.0.113.9' }] },
        };
      }),
      deleteServer: vi.fn(async () => {}),
    };

    await SCALE_EFFECTS.scaleServers(makeCtx(DigitalOceanProvider, provider));

    expect(waitForServerCalls).toEqual(['do-new-id']);
    const waitForSSHMock = composeDeploy.waitForSSH as unknown as ReturnType<typeof vi.fn>;
    expect(waitForSSHMock).toHaveBeenCalledWith('203.0.113.9', '/key', 40);
  });

  it('Hetzner: IP still resolves correctly through the same waitForServer-first path (no regression)', async () => {
    const provider = {
      createServer: vi.fn(async () => ({
        id: 42,
        server: { id: 42, public_net: { ipv4: { ip: '198.51.100.5' } } },
      })),
      waitForServer: vi.fn(async (id: number) => ({
        id,
        status: 'running',
        public_net: { ipv4: { ip: '198.51.100.5' } },
      })),
      deleteServer: vi.fn(async () => {}),
    };

    await SCALE_EFFECTS.scaleServers(makeCtx(HetznerProvider, provider));

    const waitForSSHMock = composeDeploy.waitForSSH as unknown as ReturnType<typeof vi.fn>;
    expect(waitForSSHMock).toHaveBeenCalledWith('198.51.100.5', '/key', 40);
  });
});
