import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RCA 2026-07-17 e4 run 4: the post-failover reconverge deploy REPLACED all
 * servers of BOTH clusters. deployK3s's k3s-infra block built its Pulumi
 * program without replaying the stack's existing k3sToken; the token is
 * interpolated into every node's userData, userData is immutable, so a fresh
 * token on an existing stack plans a full-cluster replace (etcd + PVC data
 * loss). The role reconciler makes cross-role re-runs of that block routine.
 * resolveStackK3sToken must recover the stored token; only a fresh stack may
 * mint one.
 */

const getStackOutputs = vi.fn();
const { StateMigrationError, StateUndecryptableError } = await import(
  '../../../src/lib/iac/state-error.js'
);
const { StackHeldError } = await import('../../../src/lib/iac/stack-lock.js');
const { K3sTokenProbeError } = await import('../../../src/lib/iac/index.js');
const { StatePassphraseError } = await import('../../../src/lib/state-passphrase.js');

vi.mock('../../../src/lib/iac/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/iac/index.js')>();
  return { ...real, getStackOutputs };
});

const FakeProvider = {
  getK8sProgram: vi.fn(async () => ({ fake: 'program' })),
};

describe('resolveStackK3sToken', () => {
  beforeEach(() => {
    getStackOutputs.mockReset();
    FakeProvider.getK8sProgram.mockClear();
  });

  const load = async () => {
    const mod = await import('../../../src/lib/deploy/k8s/k3s.js');
    return mod.resolveStackK3sToken;
  };

  it('replays the token from an existing stack', async () => {
    getStackOutputs.mockResolvedValueOnce({ k3sToken: 'stack-token-abc', masterIp: '1.2.3.4' });
    const resolveStackK3sToken = await load();
    const token = await resolveStackK3sToken(
      FakeProvider,
      { environment: 'e4-primary' },
      { log: vi.fn() },
    );
    expect(token).toBe('stack-token-abc');
    expect(getStackOutputs).toHaveBeenCalledWith(
      'e4-primary',
      { fake: 'program' },
      expect.anything(),
    );
  });

  it('returns undefined (fresh-stack path) on empty outputs, loudly', async () => {
    getStackOutputs.mockResolvedValueOnce({});
    const log = vi.fn();
    const resolveStackK3sToken = await load();
    const token = await resolveStackK3sToken(FakeProvider, { environment: 'e4-standby' }, { log });
    expect(token).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fresh token'));
  });

  // A first deploy: getStackOutputs finds no stack (getOrCreateStack's
  // requireExisting answer, the flag set). The program mints a token exactly
  // as it always has.
  it('a stack the backend does not have yet mints, as a first deploy always has', async () => {
    getStackOutputs.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Pulumi stack "e4-primary" was not found in the configured state backend (s3://b). Refusing to create an empty stack in its place.',
        ),
        { stackNotFound: true },
      ),
    );
    const log = vi.fn();
    const resolveStackK3sToken = await load();
    const token = await resolveStackK3sToken(FakeProvider, { environment: 'e4-primary' }, { log });
    expect(token).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      '[k3s-infra] k3s token probe: missing (no stack e4-primary in the state backend yet), minting a fresh token (fresh-stack path)',
    );
  });

  // Any other failed read leaves a stack that may exist unread, with the
  // token its live cluster runs with. A minted one would reach every new
  // node and none could join (R22), so the deploy stops instead.
  it.each([
    ['the state backend is gone', 'NoSuchBucket: state backend gone'],
    [
      'backpressure retries ran out',
      'error: blob (code=Unknown): SlowDown: Please reduce your request rate.',
    ],
  ])('%s: the deploy stops, naming the stack, and mints nothing', async (_label, message) => {
    const cause = new Error(message);
    getStackOutputs.mockRejectedValueOnce(cause);
    const log = vi.fn();
    const resolveStackK3sToken = await load();
    const err = await resolveStackK3sToken(
      FakeProvider,
      { environment: 'e4-primary' },
      { log },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(K3sTokenProbeError);
    expect((err as Error).cause).toBe(cause);
    expect((err as Error).message).toContain("Couldn't read the k3s join token for e4-primary");
    expect((err as Error).message).toContain('Running this again is safe.');
    expect(log).not.toHaveBeenCalled();
  });

  // A state the project's passphrase cannot read still holds the cluster's
  // token. Minting one here would put it into the program's user data; if
  // the up that follows can read the state (the one-time legacy migration
  // re-encrypts it on first open), the minted token reaches a live cluster
  // and its new nodes cannot join. So a passphrase failure propagates.
  describe('never mints a token when the passphrase cannot open the state', () => {
    const passphraseFailures: Array<[string, () => Error]> = [
      [
        'Pulumi refuses the passphrase (raw)',
        () =>
          new Error(
            'code: -2\n stdout: \n stderr: Command failed with exit code 1: pulumi stack output --json --show-secrets --stack e4-primary --non-interactive\nerror: failed to decrypt: incorrect passphrase, please set PULUMI_CONFIG_PASSPHRASE to the correct passphrase or set PULUMI_CONFIG_PASSPHRASE_FILE to a file containing the passphrase\n',
          ),
      ],
      ['an undecryptable stack (typed)', () => new StateUndecryptableError('e4-primary')],
      [
        'the passphrase is missing before Pulumi runs',
        () => new StatePassphraseError('missing', "This project's state passphrase isn't set."),
      ],
    ];

    it.each(passphraseFailures)('%s: the probe error propagates', async (_label, make) => {
      const failure = make();
      getStackOutputs.mockRejectedValueOnce(failure);
      const log = vi.fn();
      const resolveStackK3sToken = await load();
      await expect(
        resolveStackK3sToken(FakeProvider, { environment: 'e4-primary' }, { log }),
      ).rejects.toBe(failure);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('fresh token'));
    });
  });

  // The probe is often the first open of the stack in the process, so the
  // one-time legacy migration runs inside it, and it can stop for a reason
  // that clears on the up's own open moments later: the child re-encrypted
  // the state and exited non-zero, or another run held the lock and has now
  // finished. A token minted on that "errored" probe would ride the up onto
  // the live cluster, and every later deploy would replay it.
  describe('never mints a token when the open stopped for a reason a later open clears', () => {
    const stops: Array<[string, () => Error]> = [
      [
        'the legacy migration stopped',
        () =>
          new StateMigrationError(
            'Stopped while re-encrypting the Pulumi state for e4-primary: error: could not import deployment.',
          ),
      ],
      [
        'another run holds the stack',
        () =>
          new StackHeldError('e4-primary', [
            { user: 'someone', host: 'laptop', pid: 4242, at: '2026-11-11T10:00:00Z' },
          ]),
      ],
    ];

    it.each(stops)('%s: the probe error propagates', async (_label, make) => {
      const failure = make();
      getStackOutputs.mockRejectedValueOnce(failure);
      const log = vi.fn();
      const resolveStackK3sToken = await load();
      await expect(
        resolveStackK3sToken(FakeProvider, { environment: 'e4-primary' }, { log }),
      ).rejects.toBe(failure);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('fresh token'));
    });
  });

  // M3 Task 9a (DO k8s 401 RCA): buildEnv now throws when a providerToken is
  // passed without a provider id (no more silent 'hetzner' default), so this
  // probe call MUST forward opts.provider through to getStackOutputs or a
  // DigitalOcean k3s-infra probe would 401/throw (and now stop the deploy)
  // instead of reading the stack's token.
  it('forwards opts.provider into the getStackOutputs probe call', async () => {
    getStackOutputs.mockResolvedValueOnce({ k3sToken: 'stack-token-abc' });
    const resolveStackK3sToken = await load();
    await resolveStackK3sToken(
      FakeProvider,
      { environment: 'd3' },
      { log: vi.fn(), provider: 'digitalocean', providerToken: 'do-secret-token' },
    );
    expect(getStackOutputs).toHaveBeenCalledWith(
      'd3',
      { fake: 'program' },
      expect.objectContaining({ provider: 'digitalocean', providerToken: 'do-secret-token' }),
    );
  });
});

describe('deployK3s wires the replayed token into the real program', () => {
  it('k3s-infra block calls resolveStackK3sToken and spreads the token', () => {
    // Source-level lockstep guard (same style as the walg-prefix and
    // node-ip guards): the helper is only load-bearing if the k3s-infra
    // block actually consumes it before building the program.
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    expect(src).toMatch(/resolveStackK3sToken\(Provider, programConfig/);
    expect(src).toMatch(/\.\.\.\(priorK3sToken \? \{ k3sToken: priorK3sToken \} : \{\}\)/);
  });

  // M3 Task 9a (DO k8s 401 RCA): the k3s-infra block's two IaC calls
  // (resolveStackK3sToken's probe + the real upStack) both carry
  // `providerToken: options.apiToken`. buildEnv now throws unless a
  // `provider` id rides alongside that token, so both call sites must pass
  // one explicitly (providerIdFor(options), which defaults to 'hetzner'
  // the same way providerFor(options) already does for the Provider class
  // resolved two lines above) — a caller that forgets it turns every
  // DigitalOcean k8s deploy into an immediate throw instead of a live 401.
  it('threads provider explicitly into both k3s-infra IaC calls', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    expect(src).toMatch(
      /resolveStackK3sToken\(Provider, programConfig, \{\s*provider: providerIdFor\(options\),/,
    );
    expect(src).toMatch(
      /upStack\(options\.environment, program, \{\s*perfStem: [^\n]*\n\s*provider: providerIdFor\(options\),/,
    );
  });
});
