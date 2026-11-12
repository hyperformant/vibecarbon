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
const { recordStateSeal, stateSealRecorded } = await import('../../../src/lib/iac/state-seal.js');
const { hasPinnedHostKey, knownHostsPathForKey } = await import('../../../src/lib/host-keys.js');
const { LiveChangeRefusedError, liveChangeOf } = await import(
  '../../../src/lib/iac/live-change-guard.js'
);
const { SERVER_RESOURCE_TYPES } = await import('../../../src/lib/iac/create-timeout.js');
const p = await import('@clack/prompts');

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
    KEY = '/tmp/never-created';
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

  /** An up whose seal records the marker, as upStack's does, and returns server `serverId` at IP. */
  const sealingUp = (state: unknown, serverId: string) =>
    upStackMock.mockImplementationOnce((async () => {
      recordStateSeal(state, 'production');
      return { outputs: { serverIp: IP, serverId, firewallId: 'fw-1' } };
    }) as never);

  it('a run whose up throws forgets the marker, so the next deploy provisions again', async () => {
    const state = ledger();
    recordStateSeal(state, 'production');
    upStackMock.mockRejectedValueOnce(new Error('the up failed'));

    await expect(EFFECTS.provisionServer(warmCtx(state))).rejects.toThrow('the up failed');

    expect(stateSealRecorded(state, 'production')).toBe(false);
  });

  it('an SSH wait that runs out (waitForSSH answers false) counts as a failed run: the marker the up recorded is forgotten', async () => {
    const state = ledger();
    sealingUp(state, '9999');
    waitForSSHMock.mockResolvedValueOnce(false);

    await EFFECTS.provisionServer(warmCtx(state));

    expect(waitForSSHMock).toHaveBeenCalledTimes(1);
    expect(stateSealRecorded(state, 'production')).toBe(false);
  });

  it('a host-key scan that finds nothing (seedKnownHosts answers false) counts as a failed run: the marker is forgotten', async () => {
    const state = ledger();
    sealingUp(state, '9999');
    seedKnownHostsMock.mockResolvedValueOnce(false);

    await EFFECTS.provisionServer(warmCtx(state));

    expect(seedKnownHostsMock).toHaveBeenCalledTimes(1);
    expect(stateSealRecorded(state, 'production')).toBe(false);
  });

  it('SSH answered and the scan landed: the marker the up recorded stays', async () => {
    const state = ledger();
    sealingUp(state, '9999');

    await EFFECTS.provisionServer(warmCtx(state));

    expect(stateSealRecorded(state, 'production')).toBe(true);
  });

  /** known_hosts as the last deploy pinned server 4242 at IP, beside another host's key. */
  const PINNED = `${IP} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLDKEY4242`;
  const OTHER = '198.51.100.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHERHOST';
  const pinFor4242 = () => {
    writeFileSync(knownHostsPathForKey(KEY), `${OTHER}\n${PINNED}\n`, { mode: 0o600 });
  };
  const knownHosts = () => readFileSync(knownHostsPathForKey(KEY), 'utf8');

  it('the same server id at the same IP is the same machine: its pinned key stays, SSH checks against it, no keyscan', async () => {
    const state = ledger();
    pinFor4242();
    sealingUp(state, '4242');
    let pinnedAtWait: string | undefined;
    waitForSSHMock.mockImplementationOnce(async () => {
      pinnedAtWait = knownHosts();
      return true;
    });

    await EFFECTS.provisionServer(warmCtx(state));

    expect(waitForSSHMock).toHaveBeenCalledWith(IP, KEY, 30);
    expect(pinnedAtWait).toContain(PINNED);
    expect(seedKnownHostsMock).not.toHaveBeenCalled();
    expect(knownHosts()).toBe(`${OTHER}\n${PINNED}\n`);
    expect(stateSealRecorded(state, 'production')).toBe(true);
  });

  it('a new server id at the same IP is a new machine: the old key is dropped before the wait, and the new one scanned after', async () => {
    const state = ledger();
    pinFor4242();
    sealingUp(state, '9999');
    let pinnedAtWait: string | undefined;
    waitForSSHMock.mockImplementationOnce(async () => {
      pinnedAtWait = knownHosts();
      return true;
    });

    await EFFECTS.provisionServer(warmCtx(state));

    // accept-new trusts the new machine on first connect, as on a fresh
    // provision, instead of refusing it on the old machine's key.
    expect(pinnedAtWait).not.toContain(PINNED);
    expect(pinnedAtWait).toContain(OTHER);
    expect(seedKnownHostsMock).toHaveBeenCalledWith(knownHostsPathForKey(KEY), IP);
  });

  it('the same server id with no key pinned for its IP: scanned, as a first pin', async () => {
    const state = ledger();
    sealingUp(state, '4242');

    expect(hasPinnedHostKey(knownHostsPathForKey(KEY), IP)).toBe(false);

    await EFFECTS.provisionServer(warmCtx(state));

    expect(seedKnownHostsMock).toHaveBeenCalledWith(knownHostsPathForKey(KEY), IP);
  });

  it("an env record without a server id names no machine to compare: the pinned key stays, SSH checks against it, and this run's id goes on the record", async () => {
    const state = ledger();
    pinFor4242();
    sealingUp(state, '4242');
    let pinnedAtWait: string | undefined;
    waitForSSHMock.mockImplementationOnce(async () => {
      pinnedAtWait = knownHosts();
      return true;
    });
    const ctx = { ...warmCtx(state), providerServerId: null };

    await EFFECTS.provisionServer(ctx);

    expect(pinnedAtWait).toContain(PINNED);
    expect(seedKnownHostsMock).not.toHaveBeenCalled();
    expect(knownHosts()).toBe(`${OTHER}\n${PINNED}\n`);
    // persist-provisioned-server writes it, so a later new id is caught.
    expect(ctx.serverProvisioned).toBe(true);
    expect(composeServerRecord({ ...ctx, region: 'nbg1', serverType: 'cpx22' })).toMatchObject({
      id: '4242',
      ip: IP,
    });
  });

  it('an env record without a server id and no key pinned for its IP: scanned, as a first pin', async () => {
    const state = ledger();
    sealingUp(state, '4242');

    await EFFECTS.provisionServer({ ...warmCtx(state), providerServerId: null });

    expect(seedKnownHostsMock).toHaveBeenCalledWith(knownHostsPathForKey(KEY), IP);
  });
});

describe("provisionServer: the seal's up never changes the live server (iac/live-change-guard.js)", () => {
  const IP = '203.0.113.10';
  /** A step of the seal up's plan, as the preview's guard reads it. */
  const step = (op: string, type: string, logical: string, name: string) =>
    liveChangeOf(
      {
        resourcePreEvent: {
          metadata: {
            op,
            type,
            urn: `urn:pulumi:production::testapp::${type}::${logical}`,
            old: { inputs: { name } },
          },
        },
      },
      SERVER_RESOURCE_TYPES,
    );
  const SERVER = 'hcloud:index/server:Server';
  const SCALEWAY_IP = 'scaleway:instance/ip:Ip';
  let warn: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    warn?.mockRestore();
    waitForSSHMock.mockReset();
    seedKnownHostsMock.mockReset();
  });

  const ctxWith = (state: unknown, over: Record<string, unknown> = {}) => ({
    projectConfig: { projectName: 'testapp', operatorCidrs: [{ cidr: '1.2.3.4/32' }] },
    environment: 'production',
    region: 'nbg1',
    serverType: undefined,
    apiToken: 'test-token',
    s3Config: { bucket: 'b', region: 'nbg1' },
    sshKeyPath: '/tmp/never-created',
    envConfig: { provider: 'hetzner' },
    state,
    ...over,
  });

  /** The seal's up on a recorded server, with a ledger that marks it sealed. */
  function recordedCtx() {
    const dir = createTempDir('provision-refuse-');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const state = new StateTracker('testapp', 'production');
    cwd.mockRestore();
    for (const name of ['compose-setup-server', 'compose-setup-files']) {
      state.startStep(name, { serverIp: IP });
      state.completeStep(name, { serverIp: IP });
    }
    recordStateSeal(state, 'production');
    return ctxWith(state, {
      serverIp: IP,
      providerServerId: '4242',
      providerServerName: 'testapp-production',
      providerFirewallId: 'fw-1',
      stateSealed: false,
    }) as Record<string, unknown> & { state: InstanceType<typeof StateTracker> };
  }

  it('asks upStack to refuse live changes only when the env records a server', async () => {
    upStackMock.mockRejectedValueOnce(new Error('STOP_AFTER_UPSTACK_CALL'));
    await expect(EFFECTS.provisionServer(recordedCtx())).rejects.toThrow('STOP_AFTER_UPSTACK_CALL');
    expect(upStackMock.mock.calls.at(-1)?.[2]).toMatchObject({ refuseLiveChanges: true });

    upStackMock.mockRejectedValueOnce(new Error('STOP_AFTER_UPSTACK_CALL'));
    await expect(EFFECTS.provisionServer(ctxWith(noLedger()))).rejects.toThrow(
      'STOP_AFTER_UPSTACK_CALL',
    );
    expect(upStackMock.mock.calls.at(-1)?.[2]).not.toHaveProperty('refuseLiveChanges');
  });

  const PLANS: Array<[string, unknown[], string]> = [
    [
      'resize the server in place',
      [step('update', SERVER, 'server', 'testapp-production')],
      'Server testapp-production (update)',
    ],
    [
      'replace the server',
      ['replace', 'create-replacement', 'delete-replaced'].map((op) =>
        step(op, SERVER, 'server', 'testapp-production'),
      ),
      'Server testapp-production (replace)',
    ],
    [
      'make a new server in its place',
      [step('create', SERVER, 'server', 'testapp-production')],
      'Server testapp-production (create)',
    ],
    [
      'replace its Scaleway IP',
      [step('replace', SCALEWAY_IP, 'ip', 'testapp-production-ip')],
      'Ip testapp-production-ip (replace)',
    ],
  ];
  for (const [what, changes, named] of PLANS) {
    it(`a plan that would ${what}: no up, the seal skipped with a warning naming ${named}, the deploy goes on with the server as it is`, async () => {
      const ctx = recordedCtx();
      warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
      upStackMock.mockRejectedValueOnce(new LiveChangeRefusedError('production', changes));

      await expect(EFFECTS.provisionServer(ctx)).resolves.toBeUndefined();

      // The marker stays unset, so the next deploy checks again.
      expect(stateSealRecorded(ctx.state, 'production')).toBe(false);
      // Nothing re-provisions or re-sets-up: the server as the record has it.
      expect(ctx.serverProvisioned).toBeUndefined();
      expect(ctx.serverIp).toBe(IP);
      expect(ctx.providerServerId).toBe('4242');
      expect(ctx.providerFirewallId).toBe('fw-1');
      expect(ctx.state.shouldSkip('compose-setup-server', { serverIp: IP })).toBe(true);
      expect(ctx.state.shouldSkip('compose-setup-files', { serverIp: IP })).toBe(true);
      expect(waitForSSHMock).not.toHaveBeenCalled();
      expect(seedKnownHostsMock).not.toHaveBeenCalled();
      const [message] = warn.mock.calls.at(-1) as [string];
      expect(message).toContain(
        'Your production server testapp-production (203.0.113.10) was left as it is.',
      );
      expect(message).toContain(
        "vibecarbon won't change your live server during that one-time step",
      );
      // What drifted: each change once, with the type, the name and the op.
      expect(message).toContain(`The plan for it would make these changes: ${named}. `);
      expect(message).toContain('the deploy goes on without it');
      expect(message).toContain('The next deploy checks again');
      expect(message).not.toContain('—');
    });
  }

  it('the warning lists every change the plan wanted, and the deploy log their steps', async () => {
    const ctx = recordedCtx();
    warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    // progressLog's line once the spinner has stopped.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    upStackMock.mockRejectedValueOnce(
      new LiveChangeRefusedError('production', [
        step('update', SERVER, 'server', 'testapp-production'),
        step('delete', 'hcloud:index/firewall:Firewall', 'firewall', 'testapp-production-fw'),
      ]),
    );

    try {
      await EFFECTS.provisionServer(ctx);
      expect(logged.mock.calls.map(([line]) => String(line))).toContainEqual(
        expect.stringMatching(
          /^\[pulumi\] The up for production would change .*\(steps: update urn:.*, delete urn:/,
        ),
      );
    } finally {
      logged.mockRestore();
    }

    expect(warn.mock.calls.at(-1)?.[0]).toContain(
      'would make these changes: Server testapp-production (update), Firewall testapp-production-fw (delete). ',
    );
  });

  it('a first deploy (no server on record) never asks, so a refusal there is just an error', async () => {
    upStackMock.mockRejectedValueOnce(
      new LiveChangeRefusedError('production', [step('update', SERVER, 'server', 'x')]),
    );
    await expect(EFFECTS.provisionServer(ctxWith(noLedger()))).rejects.toBeInstanceOf(
      LiveChangeRefusedError,
    );
  });
});
