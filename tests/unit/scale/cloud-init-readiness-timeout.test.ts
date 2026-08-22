import { describe, expect, it, vi } from 'vitest';

// scale.js's scaleServers replacement-server path was calling
// `setupServer(newIp, sshKeyPath)` with NO timeout argument, so it always
// fell back to setupServer's Hetzner-calibrated 180s default (see
// lib/deploy/compose/index.js) even for a provider (DigitalOcean) whose
// base image installs Docker INSIDE cloud-init and needs materially longer
// (600s — see DigitalOceanProvider.CLOUD_INIT_READY_TIMEOUT_MS). The deploy
// path (lib/deploy/effects/index.js's setupServer effect — see
// cloud-init-provider-timeout.test.ts) already resolves this from
// Provider.CLOUD_INIT_READY_TIMEOUT_MS; scale.js's replacement path must do
// the same.

const H = vi.hoisted(() => ({
  setupServerCalls: [] as Array<{ ip: string; sshKeyPath: string; timeoutMs: number | undefined }>,
}));

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
    waitForSSH: async () => true,
    setupServer: vi.fn(async (ip: string, sshKeyPath: string, timeoutMs?: number) => {
      H.setupServerCalls.push({ ip, sshKeyPath, timeoutMs });
    }),
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

function makeCtx(Provider: typeof HetznerProvider | typeof DigitalOceanProvider) {
  const provider = {
    createServer: vi.fn(async () => ({
      id: 'new-id',
      server: { public_net: { ipv4: { ip: '9.9.9.9' } }, networks: { v4: [] } },
    })),
    waitForServer: vi.fn(async () => ({})),
    deleteServer: vi.fn(async () => {}),
  };
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

describe('scaleServers — provider-owned cloud-init readiness budget', () => {
  it('passes HetznerProvider.CLOUD_INIT_READY_TIMEOUT_MS (180s) for a Hetzner ctx', async () => {
    H.setupServerCalls.length = 0;
    // getPublicIP dispatches off the server shape; stub it out for this class
    // rather than relying on the real Hetzner-shaped extractor.
    const spy = vi.spyOn(HetznerProvider, 'getPublicIP').mockReturnValue('9.9.9.9');
    try {
      await SCALE_EFFECTS.scaleServers(makeCtx(HetznerProvider));
    } finally {
      spy.mockRestore();
    }
    expect(H.setupServerCalls).toHaveLength(1);
    expect(H.setupServerCalls[0].timeoutMs).toBe(180_000);
    expect(H.setupServerCalls[0].timeoutMs).toBe(HetznerProvider.CLOUD_INIT_READY_TIMEOUT_MS);
  });

  it('passes DigitalOceanProvider.CLOUD_INIT_READY_TIMEOUT_MS (600s) for a DigitalOcean ctx — never the Hetzner-calibrated 180s default', async () => {
    H.setupServerCalls.length = 0;
    const spy = vi.spyOn(DigitalOceanProvider, 'getPublicIP').mockReturnValue('9.9.9.9');
    try {
      await SCALE_EFFECTS.scaleServers(makeCtx(DigitalOceanProvider));
    } finally {
      spy.mockRestore();
    }
    expect(H.setupServerCalls).toHaveLength(1);
    expect(H.setupServerCalls[0].timeoutMs).toBe(600_000);
    expect(H.setupServerCalls[0].timeoutMs).toBe(DigitalOceanProvider.CLOUD_INIT_READY_TIMEOUT_MS);
  });
});
