/**
 * final-review Critical #3: the plain-compose `provisionServer` effect
 * (effects/index.js) called `upStack(environment, program, { providerToken,
 * s3Config })` with no `provider` field, so `buildEnv` (iac/index.js)
 * defaulted to 'hetzner' regardless of the environment's actual provider —
 * on a DigitalOcean deploy this put a DO token in HCLOUD_TOKEN. Fixed by
 * threading `provider: providerIdFor(envConfig)` through, mirroring the
 * compose-ha effect's `haProvisionServers` (effects/compose-ha.js).
 *
 * This test drives the real effect up to (and including) the upStack call —
 * mocking upStack itself (via a throwing sentinel) to both capture the call
 * args and stop the test before any real provisioning/SSH work.
 */
import { describe, expect, it, vi } from 'vitest';

const upStackMock = vi.fn(async () => {
  throw new Error('STOP_AFTER_UPSTACK_CALL');
});

vi.mock('../../../src/lib/iac/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, upStack: upStackMock };
});

vi.mock('../../../src/lib/deploy/utils.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateSSHKeyPair: () => {} };
});

// Only fake out the reads of the (never-created) SSH public key — every
// other readFileSync call (e.g. DigitalOcean's cloud-init template) must
// still hit the real filesystem, so this can't be a blanket stub.
vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as typeof import('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (typeof path === 'string' && path.endsWith('.pub')) {
        return 'ssh-ed25519 FAKEKEY test@host';
      }
      // @ts-expect-error - forwarding varargs to the real implementation
      return actual.readFileSync(path, ...rest);
    }),
  };
});

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');

async function upStackOptionsFor(envConfig: Record<string, unknown> | undefined) {
  const ctx: Record<string, unknown> = {
    projectConfig: { projectName: 'testapp', operatorCidrs: [{ cidr: '1.2.3.4/32' }] },
    environment: 'production',
    region: 'nbg1',
    serverType: undefined,
    apiToken: 'test-token',
    s3Config: { bucket: 'b', region: 'nbg1' },
    sshKeyPath: '/tmp/never-created',
    envConfig,
  };
  await expect(EFFECTS.provisionServer(ctx)).rejects.toThrow('STOP_AFTER_UPSTACK_CALL');
  const [, , options] = upStackMock.mock.calls.at(-1) as [
    unknown,
    unknown,
    Record<string, unknown>,
  ];
  return options;
}

describe('provisionServer (plain compose) threads provider into upStack', () => {
  it('passes options.provider matching envConfig.provider for a non-Hetzner provider', async () => {
    const envConfig = { provider: 'digitalocean' };
    const options = await upStackOptionsFor(envConfig);
    expect(options.provider).toBe(envConfig.provider);
    expect(options.provider).toBe('digitalocean');
  });

  it('passes options.provider matching envConfig.provider for Hetzner', async () => {
    const envConfig = { provider: 'hetzner' };
    const options = await upStackOptionsFor(envConfig);
    expect(options.provider).toBe(envConfig.provider);
    expect(options.provider).toBe('hetzner');
  });

  it('defaults to hetzner when envConfig carries no provider field', async () => {
    const options = await upStackOptionsFor({});
    expect(options.provider).toBe('hetzner');
  });
});

describe('provisionServer output gate', () => {
  it('fails loudly when Pulumi up returns no serverIp (stale S3 state read)', async () => {
    // A throttled stack-create followed by a stale S3 backend read can yield
    // a "successful" up with EMPTY outputs. Without the gate this cascaded
    // into "Waiting for SSH on undefined" and a misleading argv-validation
    // crash from ssh-keyscan (compose e2e restore re-deploy, 2026-08-06).
    upStackMock.mockResolvedValueOnce({ outputs: {} } as never);
    const ctx: Record<string, unknown> = {
      projectConfig: { projectName: 'testapp', operatorCidrs: [{ cidr: '1.2.3.4/32' }] },
      environment: 'production',
      region: 'nbg1',
      serverType: undefined,
      apiToken: 'test-token',
      s3Config: { bucket: 'b', region: 'nbg1' },
      sshKeyPath: '/tmp/never-created',
      envConfig: { provider: 'hetzner' },
    };
    await expect(EFFECTS.provisionServer(ctx)).rejects.toThrow(/no serverIp output/);
  });
});
