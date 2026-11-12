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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const upStackMock = vi.fn(async () => {
  throw new Error('STOP_AFTER_UPSTACK_CALL');
});

// The SSH wait and the host-key seed, recorded: a test that gets past the up
// reaches them. Each answers as the real one does: true when the server
// answered or the scan landed, false when it ran out (neither throws).
const { waitForSSHMock, seedKnownHostsMock } = vi.hoisted(() => ({
  waitForSSHMock: vi.fn(async (_ip: string, _key: string, _attempts: number) => true),
  seedKnownHostsMock: vi.fn(async (_khPath: string, _ip: string) => true),
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

// provisionServer runs only when the env records no server (the plan's
// `when: !ctx.serverIp`), so every run makes a new machine.
describe('provisionServer: a fresh provision is a new machine', () => {
  const IP = '203.0.113.10';
  // The deploy key in a project's own .vibecarbon/, so its known_hosts_production
  // beside it is this test's to read.
  let KEY = '';
  let cwd: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => {
    cwd?.mockRestore();
    cwd = undefined;
    waitForSSHMock.mockReset();
    seedKnownHostsMock.mockReset();
  });

  /** A real ledger in a temp project dir, as the deploy's own. */
  function ledger() {
    const dir = createTempDir('provision-ledger-');
    KEY = join(dir, 'deploy_key_production');
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    return new StateTracker('testapp', 'production');
  }

  /** A first deploy's context: the env records no server. */
  const freshCtx = (state: unknown): Record<string, unknown> => ({
    projectConfig: { projectName: 'testapp', operatorCidrs: [{ cidr: '1.2.3.4/32' }] },
    environment: 'production',
    region: 'nbg1',
    serverType: undefined,
    apiToken: 'test-token',
    s3Config: { bucket: 'b', region: 'nbg1' },
    sshKeyPath: KEY,
    envConfig: { provider: 'hetzner' },
    state,
    serverIp: null,
  });
  /** The up makes server `serverId` at IP. */
  const upMakes = (serverId: string) =>
    upStackMock.mockResolvedValueOnce({
      outputs: { serverIp: IP, serverId, firewallId: 'fw-2' },
    } as never);

  /** known_hosts as a destroyed server at IP left it, beside another host's key. */
  const STALE = `${IP} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLDKEY4242`;
  const OTHER = '198.51.100.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHERHOST';
  const knownHosts = () => readFileSync(knownHostsPathForKey(KEY), 'utf8');

  it('a recycled IP a stale known_hosts line still pins: the line goes before the SSH wait, the other hosts stay, and the new key is pinned after', async () => {
    const state = ledger();
    // The file outlived the record: a teammate destroyed the env from their
    // machine, or a destroy stopped before its local cleanup.
    writeFileSync(knownHostsPathForKey(KEY), `${OTHER}\n${STALE}\n`, { mode: 0o600 });
    upMakes('9999');
    let pinnedAtWait: string | undefined;
    waitForSSHMock.mockImplementationOnce(async () => {
      pinnedAtWait = knownHosts();
      return true;
    });

    await EFFECTS.provisionServer(freshCtx(state));

    // accept-new trusts the new machine on its first connect, instead of
    // refusing it on the old machine's key.
    expect(pinnedAtWait).not.toContain(STALE);
    expect(pinnedAtWait).toContain(OTHER);
    expect(seedKnownHostsMock).toHaveBeenCalledWith(knownHostsPathForKey(KEY), IP);
  });

  it('nothing pinned for the IP: the SSH wait, then the first pin', async () => {
    const state = ledger();
    upMakes('9999');

    await EFFECTS.provisionServer(freshCtx(state));

    expect(waitForSSHMock).toHaveBeenCalledWith(IP, KEY, 30);
    expect(seedKnownHostsMock).toHaveBeenCalledWith(knownHostsPathForKey(KEY), IP);
  });

  it('the setup steps a ledger kept for the same IP run again, and the new server goes on the record', async () => {
    const state = ledger();
    // A ledger that outlived its record, its server set up at the IP the new
    // one gets.
    for (const step of ['compose-setup-server', 'compose-setup-files']) {
      state.startStep(step, { serverIp: IP });
      state.completeStep(step, { serverIp: IP });
    }
    upMakes('9999');
    const ctx = freshCtx(state);

    await EFFECTS.provisionServer(ctx);

    expect(ctx.serverProvisioned).toBe(true);
    expect(ctx.serverIp).toBe(IP);
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
});
