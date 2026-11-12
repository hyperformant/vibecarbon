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
 * resolveStackK3sToken must recover the stored token.
 *
 * A stack with no recorded token (none in the backend, or outputs without
 * it) gets the one derived from the project's state passphrase, never a
 * random one: a first up that failed after creating servers leaves empty
 * outputs while its servers booted with that token, and the rerun must hand
 * them the same one (ruling R23, lib/iac/k3s-token.js).
 *
 * Sentinels only: the passphrase and tokens here are never real.
 */

const PASSPHRASE = 'SENTINEL-passphrase-replay-00000000000000000000';
const passphrase = vi.hoisted(() => ({ dirs: [] as string[] }));
vi.mock('../../../src/lib/state-passphrase.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async (dir: string) => {
    passphrase.dirs.push(dir);
    return PASSPHRASE;
  },
}));

const getStackOutputs = vi.fn();
const { StateMigrationError, StateUndecryptableError } = await import(
  '../../../src/lib/iac/state-error.js'
);
const { StackHeldError } = await import('../../../src/lib/iac/stack-lock.js');
const { K3sTokenProbeError } = await import('../../../src/lib/iac/index.js');
const { StatePassphraseError } = await import('../../../src/lib/state-passphrase.js');
const { deriveK3sToken } = await import('../../../src/lib/iac/k3s-token.js');

vi.mock('../../../src/lib/iac/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/iac/index.js')>();
  return { ...real, getStackOutputs };
});

const derived = (stackName: string) =>
  deriveK3sToken({ passphrase: PASSPHRASE, projectName: 'shop', stackName });

/** Every string a call recorded, for "never logged, never passed" checks. */
const said = (fn: ReturnType<typeof vi.fn>) => JSON.stringify(fn.mock.calls);

describe('resolveStackK3sToken', () => {
  beforeEach(() => {
    getStackOutputs.mockReset();
    passphrase.dirs.length = 0;
  });

  const load = async () => {
    const mod = await import('../../../src/lib/deploy/k8s/k3s.js');
    return mod.resolveStackK3sToken;
  };

  it('replays the token from an existing stack', async () => {
    getStackOutputs.mockResolvedValueOnce({ k3sToken: 'stack-token-abc', masterIp: '1.2.3.4' });
    const resolveStackK3sToken = await load();
    const token = await resolveStackK3sToken(
      { environment: 'e4-primary' },
      { log: vi.fn(), projectName: 'shop' },
    );
    expect(token).toEqual({ k3sToken: 'stack-token-abc', k3sTokenReplayed: true });
    // The probe only reads outputs, so its program is never the real one: the
    // real one needs the token this probe decides.
    expect(getStackOutputs).toHaveBeenCalledWith(
      'e4-primary',
      expect.any(Function),
      expect.objectContaining({ projectName: 'shop' }),
    );
    expect(passphrase.dirs).toEqual([]);
  });

  // A first up that failed after it created servers: the stack exists, its
  // outputs are empty, and its servers booted with the derived token.
  it('empty outputs: the token derived for this project and stack, never logged', async () => {
    getStackOutputs.mockResolvedValueOnce({});
    const log = vi.fn();
    const resolveStackK3sToken = await load();
    const token = await resolveStackK3sToken(
      { environment: 'e4-standby' },
      { log, projectName: 'shop', projectDir: '/proj' },
    );
    expect(token).toEqual({ k3sToken: derived('e4-standby'), k3sTokenReplayed: false });
    expect(passphrase.dirs).toEqual(['/proj']);
    expect(log).toHaveBeenCalledWith(
      '[k3s-infra] k3s token probe: empty (outputs object empty (fresh stack)), using the token derived from the state passphrase for this stack',
    );
    // Neither the token nor the passphrase is logged or handed to the probe.
    for (const secret of [token.k3sToken, PASSPHRASE]) {
      expect(said(log)).not.toContain(secret);
      expect(said(getStackOutputs)).not.toContain(secret);
    }
  });

  // A first deploy: getStackOutputs finds no stack (getOrCreateStack's
  // requireExisting answer, the flag set).
  it('a stack the backend does not have yet: the derived token, as its rerun will get', async () => {
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
    const first = await resolveStackK3sToken(
      { environment: 'e4-primary' },
      { log, projectName: 'shop' },
    );
    expect(first).toEqual({ k3sToken: derived('e4-primary'), k3sTokenReplayed: false });
    expect(log).toHaveBeenCalledWith(
      '[k3s-infra] k3s token probe: missing (no stack e4-primary in the state backend yet), using the token derived from the state passphrase for this stack',
    );
    // The rerun after that first up failed reads empty outputs: same token.
    getStackOutputs.mockResolvedValueOnce({});
    const rerun = await resolveStackK3sToken(
      { environment: 'e4-primary' },
      { log, projectName: 'shop' },
    );
    expect(rerun.k3sToken).toBe(first.k3sToken);
    expect(said(log)).not.toContain(first.k3sToken);
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
    const err = await resolveStackK3sToken({ environment: 'e4-primary' }, { log }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(K3sTokenProbeError);
    expect((err as Error).cause).toBe(cause);
    expect((err as Error).message).toContain("Couldn't read your k3s join token for e4-primary");
    expect((err as Error).message).toContain('You can run this again safely.');
    expect(log).not.toHaveBeenCalled();
    expect(passphrase.dirs).toEqual([]);
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
      await expect(resolveStackK3sToken({ environment: 'e4-primary' }, { log })).rejects.toBe(
        failure,
      );
      expect(log).not.toHaveBeenCalled();
      expect(passphrase.dirs).toEqual([]);
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
      await expect(resolveStackK3sToken({ environment: 'e4-primary' }, { log })).rejects.toBe(
        failure,
      );
      expect(log).not.toHaveBeenCalled();
      expect(passphrase.dirs).toEqual([]);
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
      { environment: 'd3' },
      { log: vi.fn(), provider: 'digitalocean', providerToken: 'do-secret-token' },
    );
    expect(getStackOutputs).toHaveBeenCalledWith(
      'd3',
      expect.any(Function),
      expect.objectContaining({ provider: 'digitalocean', providerToken: 'do-secret-token' }),
    );
  });
});

describe('deployK3s wires the replayed token into the real program', () => {
  it('k3s-infra block calls resolveStackK3sToken and spreads the token', () => {
    // Source-level lockstep guard (same style as the walg-prefix and
    // node-ip guards): the helper is only load-bearing if the k3s-infra
    // block actually consumes it before building the program, and it always
    // does: a program built without a token refuses (k3s-token-census).
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    expect(src).toMatch(/const stackToken = await resolveStackK3sToken\(programConfig, \{/);
    expect(src).toMatch(/getK8sProgram\(\{ \.\.\.programConfig, \.\.\.stackToken \}\)/);
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
      /resolveStackK3sToken\(programConfig, \{\s*provider: providerIdFor\(options\),/,
    );
    expect(src).toMatch(
      /upStack\(options\.environment, program, \{\s*perfStem: [^\n]*\n\s*provider: providerIdFor\(options\),/,
    );
  });
});
