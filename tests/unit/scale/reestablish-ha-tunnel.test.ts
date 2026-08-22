import { beforeEach, describe, expect, it, vi } from 'vitest';

// The k8s-ha scale belt (item I-1): after a supabase-node resize reboots the
// node that owns the host `wg0`, the repl-gateway crash-loops and the primary's
// pods-Ready wait would time out. `scaleReestablishHaTunnel` recreates the
// transport BEFORE that wait — but ONLY when the env is HA AND the supabase node
// was actually resized (a master/worker-only resize leaves wg0 intact, so we
// must not needlessly tear down a healthy tunnel).

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

vi.mock('../../../src/failover.js', () => ({
  identifyServers: vi.fn(() => ({
    primary: {
      ip: '1.1.1.1',
      supabaseIp: '167.233.150.173',
      supabasePrivateIp: '10.0.1.2',
    },
    standby: {
      ip: '2.2.2.2',
      supabaseIp: '157.180.115.19',
      supabasePrivateIp: '10.0.1.2',
    },
  })),
}));

vi.mock('../../../src/lib/deploy/k8s/ha/index.js', () => ({
  reestablishReplicationTransport: vi.fn(async () => {}),
}));

const { SCALE_EFFECTS } = await import('../../../src/scale.js');
const { identifyServers } = await import('../../../src/failover.js');
const { reestablishReplicationTransport } = await import('../../../src/lib/deploy/k8s/ha/index.js');

const baseCtx = {
  environment: 'prod',
  envConfig: {},
  projectConfig: {},
  region: 'nbg1',
  secondaryRegion: 'ash',
};

describe('scaleReestablishHaTunnel gating', () => {
  beforeEach(() => {
    vi.mocked(reestablishReplicationTransport).mockClear();
    vi.mocked(identifyServers).mockClear();
  });

  it('is registered as the k8s scale-tier effect', () => {
    expect(typeof SCALE_EFFECTS.scaleReestablishHaTunnel).toBe('function');
  });

  it('no-ops for a non-HA env (single-cluster k8s has no tunnel)', async () => {
    await SCALE_EFFECTS.scaleReestablishHaTunnel({
      ...baseCtx,
      isHA: false,
      infraChanges: ['supabaseType'],
    });
    expect(reestablishReplicationTransport).not.toHaveBeenCalled();
    expect(identifyServers).not.toHaveBeenCalled();
  });

  it('no-ops when the supabase node was not resized (wg0 not disrupted)', async () => {
    await SCALE_EFFECTS.scaleReestablishHaTunnel({
      ...baseCtx,
      isHA: true,
      infraChanges: ['workerType', 'masterType'],
    });
    expect(reestablishReplicationTransport).not.toHaveBeenCalled();
  });

  it('re-establishes the transport when HA + supabase node resized', async () => {
    await SCALE_EFFECTS.scaleReestablishHaTunnel({
      ...baseCtx,
      isHA: true,
      infraChanges: ['supabaseType', 'workerType'],
    });
    expect(reestablishReplicationTransport).toHaveBeenCalledTimes(1);
    expect(reestablishReplicationTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryIp: '1.1.1.1',
        standbyIp: '2.2.2.2',
        primarySupabaseIp: '167.233.150.173',
        standbySupabaseIp: '157.180.115.19',
        primarySupabasePrivateIp: '10.0.1.2',
        standbySupabasePrivateIp: '10.0.1.2',
        sshKeyPath: expect.stringContaining('deploy_key_prod'),
      }),
    );
  });

  it('never throws out of the belt — a transport failure only warns', async () => {
    vi.mocked(reestablishReplicationTransport).mockRejectedValueOnce(new Error('ssh boom'));
    await expect(
      SCALE_EFFECTS.scaleReestablishHaTunnel({
        ...baseCtx,
        isHA: true,
        infraChanges: ['supabaseType'],
      }),
    ).resolves.toBeUndefined();
  });
});
