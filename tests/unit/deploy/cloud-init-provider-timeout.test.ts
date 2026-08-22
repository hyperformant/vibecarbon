/**
 * The cloud-init readiness budget (setupServer's polling deadline) is
 * provider-owned (see BaseProvider.CLOUD_INIT_READY_TIMEOUT_MS / hetzner.js /
 * digitalocean.js). Hetzner's `docker-ce` image has Docker preinstalled, so
 * 180s is generous; DigitalOcean's `ubuntu-24-04-x64` image installs
 * docker-ce from Docker's apt repo INSIDE cloud-init (see
 * digitalocean-compose.js renderDoUserData) — realistically 3-5 minutes on
 * small droplets — so it needs 600s.
 *
 * This asserts the `setupServer` deploy effect (lib/deploy/effects/index.js)
 * actually resolves the provider from ctx.envConfig and forwards its budget
 * into the compose/index.js wait, instead of using a single hardcoded value
 * for every provider. Mocking pattern mirrors effect-concurrency.test.ts:
 * mock only `setupServer` on compose/index.js, keep everything else actual.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  calls: [] as Array<{ ip: string; sshKeyPath: string; timeoutMs: number | undefined }>,
}));

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    setupServer: vi.fn(async (ip: string, sshKeyPath: string, timeoutMs?: number) => {
      H.calls.push({ ip, sshKeyPath, timeoutMs });
    }),
    waitForDockerReady: vi.fn(async () => {}),
  };
});

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');

function fakeState() {
  return {
    shouldSkip: () => false,
    startStep: () => {},
    completeStep: () => {},
  };
}

beforeEach(() => {
  H.calls = [];
});

describe('setupServer effect — provider-owned cloud-init readiness budget', () => {
  it('passes HetznerProvider.CLOUD_INIT_READY_TIMEOUT_MS (180s) for a Hetzner envConfig', async () => {
    const ctx: Record<string, unknown> = {
      state: fakeState(),
      serverIp: '5.78.41.67',
      sshKeyPath: '/k',
      isDirectDeploy: false,
      isComposeLocal: false,
      envConfig: { provider: 'hetzner' },
    };

    await EFFECTS.setupServer(ctx);

    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].timeoutMs).toBe(180_000);
  });

  it('passes DigitalOceanProvider.CLOUD_INIT_READY_TIMEOUT_MS (600s) for a DigitalOcean envConfig', async () => {
    const ctx: Record<string, unknown> = {
      state: fakeState(),
      serverIp: '203.0.113.9',
      sshKeyPath: '/k',
      isDirectDeploy: false,
      isComposeLocal: false,
      envConfig: { provider: 'digitalocean' },
    };

    await EFFECTS.setupServer(ctx);

    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].timeoutMs).toBe(600_000);
  });

  it("defaults to hetzner (180s) when envConfig.provider is absent, matching providerFor's ?? 'hetzner' fallback", async () => {
    const ctx: Record<string, unknown> = {
      state: fakeState(),
      serverIp: '5.78.41.67',
      sshKeyPath: '/k',
      isDirectDeploy: false,
      isComposeLocal: false,
      envConfig: {},
    };

    await EFFECTS.setupServer(ctx);

    expect(H.calls[0].timeoutMs).toBe(180_000);
  });
});
