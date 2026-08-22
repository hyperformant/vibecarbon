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
 * classifyK3sTokenProbe) and `../deploy/k8s/index.js` (K3S_VERSION) are mocked
 * so no @pulumi / real cloud call is made. The Provider is a fake that records
 * every `getK8sProgram(config)` call, which is how we inspect the assembled
 * program config without exporting internals.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upStackMock = vi.fn();
const getStackOutputsMock = vi.fn();
const getOrCreateStackMock = vi.fn();
const classifyK3sTokenProbeMock = vi.fn();

vi.mock('../../../src/lib/iac/index.js', () => ({
  upStack: (...a: unknown[]) => upStackMock(...a),
  getStackOutputs: (...a: unknown[]) => getStackOutputsMock(...a),
  getOrCreateStack: (...a: unknown[]) => getOrCreateStackMock(...a),
  classifyK3sTokenProbe: (...a: unknown[]) => classifyK3sTokenProbeMock(...a),
  // Real implementation is a pure string helper; converge uses it to shape
  // Pulumi aborts so they stop reading "code: -2" (2026-08-06 RCA).
  summarizePulumiError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).split('\n')[0],
}));

vi.mock('../../../src/lib/deploy/k8s/index.js', () => ({
  K3S_VERSION: '1.30.4+k3s1',
}));

const { convergeClusterInfra } = await import('../../../src/lib/iac/converge-cluster.js');

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

  // I5: the long-form master/supabase server-type overrides (what
  // provisionStandbyCapacity pins from envConfig.ha.standby.*ServerType) must
  // also reach the program config, or the failover converge re-derives them
  // from the primary's types and plans an in-place resize of the standby's
  // master/db node.
  it('(e2) maps long-form master/supabase server-type overrides into the program config', async () => {
    const { Provider, programCalls } = makeProvider();
    await convergeClusterInfra({
      ...baseArgs(),
      Provider,
      overrides: { masterServerType: 'cpx31', supabaseServerType: 'cpx41' },
    });
    expect(programCalls[0].masterServerType).toBe('cpx31');
    expect(programCalls[0].supabaseServerType).toBe('cpx41');
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
});
