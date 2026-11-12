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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const upStackMock = vi.fn(async () => {
  throw new Error('STOP_AFTER_UPSTACK_CALL');
});

// The SSH wait and the host-key seed, recorded: a test that gets past the up
// reaches them.
const { waitForSSHMock, seedKnownHostsMock } = vi.hoisted(() => ({
  waitForSSHMock: vi.fn(async () => {}),
  seedKnownHostsMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  waitForSSH: waitForSSHMock,
}));
vi.mock('../../../src/lib/host-keys.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  seedKnownHosts: seedKnownHostsMock,
}));

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

const { EFFECTS, composeServerRecord } = await import('../../../src/lib/deploy/effects/index.js');
// @ts-expect-error: JS module without types
const { StateTracker } = await import('../../../src/lib/deploy/state.js');
const { recordStateSeal, stateSealRecorded } = await import('../../../src/lib/iac/state-seal.js');
const { knownHostsPathForKey } = await import('../../../src/lib/host-keys.js');

/** A ledger that holds nothing: these tests stop at or before the up. */
const noLedger = () => ({ invalidateStep: () => {} });

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
    state: noLedger(),
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
      state: noLedger(),
    };
    await expect(EFFECTS.provisionServer(ctx)).rejects.toThrow(/no serverIp output/);
  });
});

describe('provisionServer and the seal marker (lib/iac/state-seal.js)', () => {
  const IP = '203.0.113.10';
  const KEY = '/tmp/never-created';
  let cwd: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => {
    cwd?.mockRestore();
    cwd = undefined;
    waitForSSHMock.mockReset();
    seedKnownHostsMock.mockReset();
  });

  /** A real ledger in a temp project dir, as the deploy's own. */
  function ledger() {
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(createTempDir('provision-ledger-'));
    return new StateTracker('testapp', 'production');
  }

  /** The context of a warm deploy whose stack isn't sealed yet: the env records server 4242 at IP. */
  const warmCtx = (state: unknown): Record<string, unknown> => ({
    projectConfig: { projectName: 'testapp', operatorCidrs: [{ cidr: '1.2.3.4/32' }] },
    environment: 'production',
    region: 'nbg1',
    serverType: undefined,
    apiToken: 'test-token',
    s3Config: { bucket: 'b', region: 'nbg1' },
    sshKeyPath: KEY,
    envConfig: { provider: 'hetzner' },
    state,
    serverIp: IP,
    providerServerId: '4242',
    providerFirewallId: 'fw-1',
    stateSealed: false,
  });

  it("hands upStack the deploy's ledger, where the seal records its marker", async () => {
    const ctx = warmCtx(noLedger());
    upStackMock.mockRejectedValueOnce(new Error('STOP_AFTER_UPSTACK_CALL'));
    await expect(EFFECTS.provisionServer(ctx)).rejects.toThrow('STOP_AFTER_UPSTACK_CALL');
    const [, , options] = upStackMock.mock.calls.at(-1) as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(options.ledger).toBe(ctx.state);
  });

  it('the deploy after the upgrade, its up putting a new server at the same IP: SSH wait, a fresh pin, the new id recorded, setup run again', async () => {
    const state = ledger();
    // What the last deploy left: the server set up at this IP.
    for (const step of ['compose-setup-server', 'compose-setup-files']) {
      state.startStep(step, { serverIp: IP });
      state.completeStep(step, { serverIp: IP });
    }
    upStackMock.mockResolvedValueOnce({
      outputs: { serverIp: IP, serverId: '9999', firewallId: 'fw-2' },
    } as never);
    const ctx = warmCtx(state);

    await EFFECTS.provisionServer(ctx);

    expect(waitForSSHMock).toHaveBeenCalledWith(IP, KEY, 30);
    // The pin is re-seeded from the server that answers now, not kept.
    expect(seedKnownHostsMock).toHaveBeenCalledWith(knownHostsPathForKey(KEY), IP);
    expect(ctx.serverProvisioned).toBe(true);
    expect(ctx.providerServerId).toBe('9999');
    expect(ctx.providerFirewallId).toBe('fw-2');
    // persist-provisioned-server (when: serverProvisioned) writes this record.
    expect(composeServerRecord({ ...ctx, region: 'nbg1', serverType: 'cpx22' })).toMatchObject({
      id: '9999',
      firewallId: 'fw-2',
      ip: IP,
    });
    // The new server is set up as any new one is: cloud-init wait, files.
    expect(state.shouldSkip('compose-setup-server', { serverIp: IP })).toBe(false);
    expect(state.shouldSkip('compose-setup-files', { serverIp: IP })).toBe(false);
  });

  it('a run that fails after its up forgets the marker that up recorded, so the next deploy provisions again', async () => {
    const state = ledger();
    upStackMock.mockImplementationOnce((async () => {
      // The seal inside the up recorded the marker.
      recordStateSeal(state, 'production');
      return { outputs: { serverIp: IP, serverId: '9999', firewallId: 'fw-2' } };
    }) as never);
    waitForSSHMock.mockRejectedValueOnce(new Error('SSH never came up'));

    await expect(EFFECTS.provisionServer(warmCtx(state))).rejects.toThrow('SSH never came up');

    expect(stateSealRecorded(state, 'production')).toBe(false);
  });
});
