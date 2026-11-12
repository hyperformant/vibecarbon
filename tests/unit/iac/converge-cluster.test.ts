/**
 * Unit tests for the extracted IaC converge seam (`convergeClusterInfra`).
 *
 * This is the DANGER-ZONE block lifted out of scale.js's `applyScaleChanges`:
 * it guards against a destructive Pulumi replace of the master node (etcd
 * loss). These tests pin the four behaviors that make the seam safe to reuse
 * from failover:
 *
 *   (a) the k3sToken probe is replayed into the REAL program config (userData
 *       stays byte-stable → Pulumi plans an in-place resize, not a replace);
 *   (b) a preview that schedules a master `replace` op throws BEFORE `upStack`
 *       (the master-replace defense fails fast instead of wiping etcd);
 *   (c) `overrides` flows into `buildProgramConfig`'s newValues slot (so a
 *       caller-supplied minWorkers reaches Pulumi's worker floor); and
 *   (d) the interactive S3 prompt is skipped when `s3Creds` are supplied.
 *
 * `../iac/index.js` (upStack/getStackOutputs/getOrCreateStack/
 * classifyK3sTokenProbe) and `../images.js` (k3sVersion) are mocked
 * so no @pulumi / real cloud call is made. The Provider is a fake that records
 * every `getK8sProgram(config)` call, which is how we inspect the assembled
 * program config without exporting internals.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upStackMock = vi.fn();
const getStackOutputsMock = vi.fn();
const getOrCreateStackMock = vi.fn();
const classifyK3sTokenProbeMock = vi.fn();
const dropRetiredMock = vi.fn();
const recordRetiredMock = vi.fn();

vi.mock('../../../src/lib/iac/index.js', () => ({
  upStack: (...a: unknown[]) => upStackMock(...a),
  getStackOutputs: (...a: unknown[]) => getStackOutputsMock(...a),
  getOrCreateStack: (...a: unknown[]) => getOrCreateStackMock(...a),
  dropRetiredStackResources: (...a: unknown[]) => dropRetiredMock(...a),
  classifyK3sTokenProbe: (...a: unknown[]) => classifyK3sTokenProbeMock(...a),
  // Real implementation is a pure string helper; converge uses it to shape
  // Pulumi aborts so they stop reading "code: -2" (2026-08-06 RCA).
  summarizePulumiError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).split('\n')[0],
}));

// The recorder writes the cwd project config: stood in for here.
vi.mock('../../../src/lib/deploy/k8s/retired-reserved-ip.js', () => ({
  recordRetiredReservedIps: (...a: unknown[]) => recordRetiredMock(...a),
}));

const { convergeClusterInfra } = await import('../../../src/lib/iac/converge-cluster.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');

/** Fake Provider that records the config passed to each getK8sProgram call. */
function makeProvider() {
  const programCalls: Record<string, unknown>[] = [];
  const promptSpy = vi.fn(async () => ({ accessKey: 'AK', secretKey: 'SK' }));
  const Provider = {
    getK8sProgram: vi.fn(async (cfg: Record<string, unknown>) => {
      programCalls.push(cfg);
      return async () => ({});
    }),
    promptObjectStorageCredentials: promptSpy,
    // The real (polymorphic) guard with Hetzner's ARM predicate and wording.
    assertAmd64ServerType: (type: string, source: string) =>
      HetznerProvider.assertAmd64ServerType(type, source),
  };
  return { Provider, programCalls, promptSpy };
}

/** Base args for a single-cluster (non-HA) converge with no S3 backend. */
function baseArgs(over: Record<string, unknown> = {}) {
  return {
    projectConfig: { projectName: 'proj', operatorCidrs: [{ cidr: '1.2.3.4/32' }] },
    // No `s3.bucket` → the S3 prompt branch is skipped entirely.
    envConfig: { minWorkers: 2, maxWorkers: 5, serverType: 'cx23' },
    apiToken: 'tok',
    // A clusterEnv that can't have a stray key file in the repo cwd, so the
    // non-HA sshKey read is deterministically '' (existsSync=false).
    clusterEnv: 'unit-cluster-xyz',
    clusterRegion: 'fsn1',
    environment: 'unit-cluster-xyz',
    isHA: false,
    overrides: {},
    s3Creds: null,
    ...over,
  };
}

beforeEach(() => {
  upStackMock.mockReset();
  getStackOutputsMock.mockReset();
  getOrCreateStackMock.mockReset();
  classifyK3sTokenProbeMock.mockReset();
  dropRetiredMock.mockReset();
  dropRetiredMock.mockResolvedValue({ removed: [], addresses: [], deployment: null });
  recordRetiredMock.mockReset();

  // Defaults: probe returns an empty (fresh-stack) classification, preview
  // emits no events (no master replace), upStack succeeds with outputs.
  getStackOutputsMock.mockResolvedValue({});
  classifyK3sTokenProbeMock.mockReturnValue({ status: 'empty', reason: 'fresh stack' });
  getOrCreateStackMock.mockResolvedValue({ preview: vi.fn(async () => {}) });
  upStackMock.mockResolvedValue({ outputs: { masterIp: '1.2.3.4' }, summary: {} });
});

describe('convergeClusterInfra', () => {
  it('(a) replays the probed k3sToken into the real program config', async () => {
    classifyK3sTokenProbeMock.mockReturnValue({
      status: 'recovered',
      priorK3sToken: 'REPLAY_TOKEN',
      reason: 'k3sToken present',
    });
    const { Provider, programCalls } = makeProvider();

    await convergeClusterInfra({ ...baseArgs(), Provider });

    // getK8sProgram is called twice: [0] = probe program (no replay), [1] =
    // real program with the replayed token merged in.
    expect(programCalls).toHaveLength(2);
    expect(programCalls[0].k3sToken).toBeUndefined();
    expect(programCalls[1].k3sToken).toBe('REPLAY_TOKEN');
    expect(upStackMock).toHaveBeenCalledTimes(1);
  });

  it('(b) throws before upStack when the preview schedules a master replace', async () => {
    getOrCreateStackMock.mockResolvedValue({
      preview: vi.fn(async ({ onEvent }: { onEvent: (e: unknown) => void }) => {
        onEvent({
          resourcePreEvent: {
            metadata: {
              op: 'replace',
              urn: 'urn:pulumi:e::vibecarbon::hcloud:index/server:Server::master',
              new: { inputs: { labels: { role: 'master' } } },
            },
          },
        });
      }),
    });
    const { Provider } = makeProvider();

    await expect(convergeClusterInfra({ ...baseArgs(), Provider })).rejects.toThrow(/master/i);
    expect(upStackMock).not.toHaveBeenCalled();
  });

  it('(c) flows overrides.minWorkers into buildProgramConfig', async () => {
    const { Provider, programCalls } = makeProvider();

    await convergeClusterInfra({ ...baseArgs(), Provider, overrides: { minWorkers: 9 } });

    // buildProgramConfig maps newValues.minWorkers → programConfig.minWorkers.
    expect(programCalls[0].minWorkers).toBe(9);
  });

  it('(d) skips the S3 credential prompt when s3Creds are provided', async () => {
    const { Provider, promptSpy } = makeProvider();

    await convergeClusterInfra({
      ...baseArgs(),
      Provider,
      envConfig: {
        minWorkers: 2,
        maxWorkers: 5,
        serverType: 'cx23',
        s3: { bucket: 'b', region: 'r', endpoint: 'https://e' },
      },
      s3Creds: { accessKey: 'PROVIDED_AK', secretKey: 'PROVIDED_SK' },
    });

    expect(promptSpy).not.toHaveBeenCalled();
    expect(upStackMock).toHaveBeenCalledTimes(1);
  });

  it('(d-control) prompts for S3 credentials when a bucket is set but no s3Creds given', async () => {
    const { Provider, promptSpy } = makeProvider();

    await convergeClusterInfra({
      ...baseArgs(),
      Provider,
      envConfig: {
        minWorkers: 2,
        maxWorkers: 5,
        serverType: 'cx23',
        s3: { bucket: 'b', region: 'r', endpoint: 'https://e' },
      },
      s3Creds: null,
    });

    expect(promptSpy).toHaveBeenCalledTimes(1);
  });

  // C1: the worker-type override must reach Pulumi under BOTH spellings —
  // `scale` passes buildProgramConfig's short `workerType`, pilot-light
  // `failover` provisioning passes the persisted long `workerServerType`. Before
  // the normalization, only the short key was read, so `-server-type` and the
  // persisted standbyWorkerSpec.serverType were silently dropped. programCalls[0]
  // is the probe program config — buildProgramConfig's `workerServerType` slot.
  it('(e) maps BOTH workerType and workerServerType overrides into the program config', async () => {
    const short = makeProvider();
    await convergeClusterInfra({
      ...baseArgs(),
      Provider: short.Provider,
      overrides: { workerType: 'cpx41' },
    });
    expect(short.programCalls[0].workerServerType).toBe('cpx41');

    const long = makeProvider();
    await convergeClusterInfra({
      ...baseArgs(),
      Provider: long.Provider,
      overrides: { workerServerType: 'cpx41' },
    });
    expect(long.programCalls[0].workerServerType).toBe('cpx41');
  });

  // I5: the long-form master/database server-type overrides (what
  // provisionStandbyCapacity pins from envConfig.ha.standby.*ServerType) must
  // also reach the program config, or the failover converge re-derives them
  // from the primary's types and plans an in-place resize of the standby's
  // master/db node.
  it('(e2) maps long-form master/database server-type overrides into the program config', async () => {
    const { Provider, programCalls } = makeProvider();
    await convergeClusterInfra({
      ...baseArgs(),
      Provider,
      overrides: { masterServerType: 'cpx31', dbServerType: 'cpx41' },
    });
    expect(programCalls[0].masterServerType).toBe('cpx31');
    expect(programCalls[0].dbServerType).toBe('cpx41');
  });

  // Minor: the master-replace abort weaves the caller's action word so a DR
  // operator invoking failover isn't told about "scaling". Default stays 'scale'
  // (scale's wording byte-identical).
  it('(f) weaves the action word into the master-replace abort (default scale; failover overrides)', async () => {
    const masterReplacePreview = () => ({
      preview: vi.fn(async ({ onEvent }: { onEvent: (e: unknown) => void }) => {
        onEvent({
          resourcePreEvent: {
            metadata: {
              op: 'replace',
              urn: 'urn:pulumi:e::vibecarbon::hcloud:index/server:Server::master',
              new: { inputs: { labels: { role: 'master' } } },
            },
          },
        });
      }),
    });

    getOrCreateStackMock.mockResolvedValue(masterReplacePreview());
    await expect(
      convergeClusterInfra({ ...baseArgs(), Provider: makeProvider().Provider }),
    ).rejects.toThrow(/Refusing to scale/);

    getOrCreateStackMock.mockResolvedValue(masterReplacePreview());
    await expect(
      convergeClusterInfra({
        ...baseArgs(),
        Provider: makeProvider().Provider,
        action: 'failover',
      }),
    ).rejects.toThrow(/Refusing to failover/);
  });

  // F4 (arch audit 2026-10-15): the persisted per-role types are reused
  // verbatim for every role a run does not override (scale with no `-type`,
  // the CA worker-pool re-patch). An ARM type hand-edited into
  // .vibecarbon.json after deploy must be refused before any stack work,
  // with the same message a flag gets.
  it('(g) refuses an ARM type persisted in .vibecarbon.json before touching the stack', async () => {
    const { Provider, programCalls } = makeProvider();
    const args = baseArgs({
      envConfig: { minWorkers: 2, maxWorkers: 5, serverType: 'cpx22', workerServerType: 'cax21' },
    });
    await expect(convergeClusterInfra({ ...args, Provider })).rejects.toThrow(
      ".vibecarbon.json workerServerType: 'cax21' is an ARM (aarch64) Hetzner Cloud server type.",
    );
    expect(programCalls).toHaveLength(0);
    expect(getOrCreateStackMock).not.toHaveBeenCalled();
    expect(upStackMock).not.toHaveBeenCalled();
  });

  it('(g2) names serverType when the ARM type comes from the unified default', async () => {
    const { Provider } = makeProvider();
    const args = baseArgs({ envConfig: { minWorkers: 2, maxWorkers: 5, serverType: 'cax11' } });
    await expect(convergeClusterInfra({ ...args, Provider })).rejects.toThrow(
      ".vibecarbon.json serverType: 'cax11' is an ARM",
    );
  });

  it('(g4) refuses an ARM type that arrives as an override (a hand-edited ha.standby record)', async () => {
    // k8s-ha scale seeds each cluster's overrides from its own record
    // (ha.standby.masterServerType here), so an ARM type hand-edited there
    // reaches converge as an override, not a persisted top-level type.
    const { Provider, programCalls } = makeProvider();
    const args = baseArgs({
      envConfig: { minWorkers: 2, maxWorkers: 5, serverType: 'cpx22' },
      overrides: { masterType: 'cax21', minWorkers: 0, maxWorkers: 0 },
    });
    await expect(convergeClusterInfra({ ...args, Provider })).rejects.toThrow(
      /'cax21' is an ARM \(aarch64\) Hetzner Cloud server type/,
    );
    expect(programCalls).toHaveLength(0);
    expect(getOrCreateStackMock).not.toHaveBeenCalled();
    expect(upStackMock).not.toHaveBeenCalled();
  });

  it('(g3) does not refuse a persisted ARM role the run overrides with an x86 type', async () => {
    const { Provider, programCalls } = makeProvider();
    const args = baseArgs({
      envConfig: { minWorkers: 2, maxWorkers: 5, serverType: 'cpx22', workerServerType: 'cax21' },
      overrides: { workerType: 'cpx32' },
    });
    await convergeClusterInfra({ ...args, Provider });
    expect(programCalls[0].workerServerType).toBe('cpx32');
  });

  // The preview below refuses any plan that replaces the master, so in a
  // converge the master's id and private address cannot change during the up.
  // Handed to the program as prior state records them, the db and workers
  // resize alongside the master instead of after it (Linode k8s scale,
  // 2026-11-08: the worker waited 7 minutes for the master's resize).
  it('(h) hands the real program the master as prior state records it', async () => {
    getStackOutputsMock.mockResolvedValue({
      k3sToken: 'REPLAY_TOKEN',
      masterId: 5000001,
      masterPrivateIp: '10.0.1.2',
    });
    const { Provider, programCalls } = makeProvider();

    await convergeClusterInfra({ ...baseArgs(), Provider });

    expect(programCalls[0].priorMaster).toBeUndefined();
    expect(programCalls[1].priorMaster).toEqual({ id: '5000001', privateIp: '10.0.1.2' });
  });

  it('(h2) leaves the program on the live master when state lacks either value', async () => {
    for (const outputs of [
      { k3sToken: 'T', masterPrivateIp: '10.0.1.2' },
      { k3sToken: 'T', masterId: '5000001' },
      { k3sToken: 'T', masterId: '', masterPrivateIp: '10.0.1.2' },
      {},
    ]) {
      getStackOutputsMock.mockResolvedValue(outputs);
      const { Provider, programCalls } = makeProvider();
      await convergeClusterInfra({ ...baseArgs(), Provider });
      expect(programCalls[1], JSON.stringify(outputs)).not.toHaveProperty('priorMaster');
    }
  });

  it('(h3) a stack the backend does not have yet: no prior master either', async () => {
    getStackOutputsMock.mockRejectedValue(
      Object.assign(new Error('Pulumi stack "unit-cluster-xyz" was not found'), {
        stackNotFound: true,
      }),
    );
    classifyK3sTokenProbeMock.mockReturnValue({
      status: 'missing',
      reason: 'no stack unit-cluster-xyz in the state backend yet',
    });
    const { Provider, programCalls } = makeProvider();
    await convergeClusterInfra({ ...baseArgs(), Provider });
    expect(programCalls[1]).not.toHaveProperty('priorMaster');
  });
  // A DigitalOcean cluster made before 2026-11 still holds a reserved IP its
  // domain may point at. Scale and failover converge the current program,
  // which no longer declares it: without the surgery the preview plans, and
  // the up runs, its delete, cutting the domain off with no DNS move
  // (lib/iac/retired-resources.js). So it leaves the state before either.
  it('(i) takes retired resources out of the stack before the preview and the up', async () => {
    const order: string[] = [];
    const stack = { name: 'prod', preview: vi.fn(async () => order.push('preview')) };
    getOrCreateStackMock.mockResolvedValue(stack);
    dropRetiredMock.mockImplementation(async () => {
      order.push('drop');
      return [];
    });
    upStackMock.mockImplementation(async () => {
      order.push('up');
      return { outputs: { masterIp: '1.2.3.4' }, summary: {} };
    });
    const { Provider } = makeProvider();

    await convergeClusterInfra({
      ...baseArgs({
        envConfig: { provider: 'digitalocean', minWorkers: 2, maxWorkers: 5, serverType: 'x' },
      }),
      Provider,
    });

    expect(order).toEqual(['drop', 'preview', 'up']);
    expect(dropRetiredMock).toHaveBeenCalledWith(stack, 'digitalocean', {
      recordAddresses: expect.any(Function),
    });
    // What the surgery takes out goes onto the record of this cluster's stack,
    // in the environment as the operator names it.
    const [, , { recordAddresses }] = dropRetiredMock.mock.calls[0];
    recordAddresses(['203.0.113.9']);
    expect(recordRetiredMock).toHaveBeenCalledWith({
      environment: 'unit-cluster-xyz',
      stackName: 'unit-cluster-xyz',
      addresses: ['203.0.113.9'],
    });
  });

  it('(i2) a failed surgery stops the converge before the preview and the up', async () => {
    const stack = { name: 'prod', preview: vi.fn(async () => {}) };
    getOrCreateStackMock.mockResolvedValue(stack);
    dropRetiredMock.mockRejectedValue(new Error('Could not take the retired reserved IP out'));
    const { Provider } = makeProvider();

    await expect(
      convergeClusterInfra({
        ...baseArgs({
          envConfig: { provider: 'digitalocean', minWorkers: 2, maxWorkers: 5, serverType: 'x' },
        }),
        Provider,
      }),
    ).rejects.toThrow(/Could not take the retired reserved IP out/);
    expect(stack.preview).not.toHaveBeenCalled();
    expect(upStackMock).not.toHaveBeenCalled();
  });
});

/**
 * (i) holds for scale and failover only while both reach the stack through
 * this seam. Failover's provisionStandbyCapacity defaults its converge to
 * makeDefaultConverge, which binds convergeClusterInfra; a failover that grew
 * its own up or preview would plan the standby's reserved IP's delete, and the
 * DNS flip that follows targets that very address on a standby no deploy has
 * moved yet (failover/server-identification.test.ts).
 */
describe('scale and failover converge through this seam', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../../src/${rel}`, import.meta.url)), 'utf8');

  it("failover: provisionStandbyCapacity's default converge is convergeClusterInfra", () => {
    const src = read('failover.js');
    const start = src.indexOf('async function makeDefaultConverge(');
    const seam = src.slice(start, src.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(0);
    expect(seam).toContain("await import('./lib/iac/converge-cluster.js')");
    expect(seam).toMatch(/convergeClusterInfra\(\{\s*\.\.\.args,/);
    expect(src).toContain('converge = await makeDefaultConverge(creds);');
    // No other route from failover to a Pulumi up or preview.
    expect(src).not.toMatch(/\bupStack\(|\.preview\(|\.up\(\{/);
  });

  it('scale: its infra change goes through convergeClusterInfra', () => {
    const src = read('scale.js');
    expect(src).toMatch(/await convergeClusterInfra\(\{/);
    expect(src).not.toMatch(/\bupStack\(|\.preview\(|\.up\(\{/);
  });
});

describe('convergeClusterInfra — a state the passphrase cannot read', () => {
  // The real probe classifier, not the mock: it is the seam that decides.
  // A passphrase failure must stop the converge before the real program is
  // built, because building it without a recovered token mints a fresh one
  // into every new node's user data.
  // A held stack or a stopped legacy migration stops it the same way: both
  // can clear by the up's own open, which would then carry a minted token
  // onto the live cluster.
  it.each([
    ['the passphrase cannot read it', 'StateUndecryptableError'],
    ['another run holds the stack', 'StackHeldError'],
    ['the legacy migration stopped', 'StateMigrationError'],
  ])(
    '%s: stops before the real program: no fresh k3s token, no preview, no up',
    async (_label, kind) => {
      const real = await vi.importActual<typeof import('../../../src/lib/iac/index.js')>(
        '../../../src/lib/iac/index.js',
      );
      const { StateMigrationError, StateUndecryptableError } = await import(
        '../../../src/lib/iac/state-error.js'
      );
      const { StackHeldError } = await import('../../../src/lib/iac/stack-lock.js');
      classifyK3sTokenProbeMock.mockImplementation(real.classifyK3sTokenProbe);
      const failure =
        kind === 'StackHeldError'
          ? new StackHeldError('unit-cluster-xyz', [
              { user: 'someone', host: 'laptop', pid: 4242, at: '2026-11-11T10:00:00Z' },
            ])
          : kind === 'StateMigrationError'
            ? new StateMigrationError(
                'Stopped while re-encrypting the Pulumi state for unit-cluster-xyz: error: could not import deployment.',
              )
            : new StateUndecryptableError('unit-cluster-xyz');
      getStackOutputsMock.mockRejectedValue(failure);
      const { Provider, programCalls } = makeProvider();
      // The plain spinner, whose lines land in p.log.
      vi.stubEnv('VIBECARBON_PLAIN', '1');
      const p = await import('@clack/prompts');
      const success = vi.spyOn(p.log, 'success').mockImplementation(() => {});
      const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});

      try {
        await expect(convergeClusterInfra({ ...baseArgs(), Provider })).rejects.toBe(failure);

        // [0] is the probe program; a second call would be the real program,
        // built with a minted token.
        expect(programCalls).toHaveLength(1);
        expect(getOrCreateStackMock).not.toHaveBeenCalled();
        expect(upStackMock).not.toHaveBeenCalled();
        // The spinner says what happened, never that the state was read.
        expect(success.mock.calls.flat().join('\n')).not.toContain('Prior cluster state read');
        expect(error).toHaveBeenCalledWith("Prior cluster state can't be read (unit-cluster-xyz)");
      } finally {
        success.mockRestore();
        error.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );
});

// The probe mints a token only for a stack the backend doesn't have (R22).
// Any other failed read stops the converge: the stack may exist, and its
// live cluster's token is what every new node needs to join. Scale and
// failover reach the stack only through this seam.
describe('convergeClusterInfra — the k3s token probe mints only for a missing stack', () => {
  async function withRealClassifier() {
    const real = await vi.importActual<typeof import('../../../src/lib/iac/index.js')>(
      '../../../src/lib/iac/index.js',
    );
    classifyK3sTokenProbeMock.mockImplementation(real.classifyK3sTokenProbe);
    return real;
  }

  it.each([
    ['the state backend is unreachable', 'NoSuchBucket: state backend gone'],
    [
      'backpressure retries ran out',
      'error: blob (code=Unknown): SlowDown: Please reduce your request rate.',
    ],
  ])('%s: stops before the real program, the preview and the up', async (_label, message) => {
    const real = await withRealClassifier();
    const cause = new Error(message);
    getStackOutputsMock.mockRejectedValue(cause);
    const { Provider, programCalls } = makeProvider();
    vi.stubEnv('VIBECARBON_PLAIN', '1');
    const p = await import('@clack/prompts');
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    try {
      const err = await convergeClusterInfra({ ...baseArgs(), Provider }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(real.K3sTokenProbeError);
      expect((err as Error).cause).toBe(cause);
      expect((err as Error).message).toContain(
        "Couldn't read the k3s join token for unit-cluster-xyz from its Pulumi state",
      );
      expect(programCalls).toHaveLength(1);
      expect(getOrCreateStackMock).not.toHaveBeenCalled();
      expect(upStackMock).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("Prior cluster state can't be read (unit-cluster-xyz)");
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('a stack the backend does not have: the fresh-stack path, a minted token, the preview and the up', async () => {
    await withRealClassifier();
    getStackOutputsMock.mockRejectedValue(
      Object.assign(new Error('Pulumi stack "unit-cluster-xyz" was not found'), {
        stackNotFound: true,
      }),
    );
    const { Provider, programCalls } = makeProvider();
    const p = await import('@clack/prompts');
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    try {
      await convergeClusterInfra({ ...baseArgs(), Provider });
      expect(programCalls).toHaveLength(2);
      expect(programCalls[1].k3sToken).toBeUndefined();
      expect(upStackMock).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'unit-cluster-xyz: no stack unit-cluster-xyz in the state backend yet, so this run makes its k3s token.',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
