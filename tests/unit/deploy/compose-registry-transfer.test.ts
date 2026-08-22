/**
 * `EFFECTS.transferImage`'s compose-local branch: registry-first delivery
 * (ensure → operator-side tag → SSH-tunnel push → server pull+retag) with a
 * logged sideload fallback on any failure in that chain. Drives the real
 * effect and awaits `ctx.transferImagePromise` — every downstream call is
 * mocked so no real docker/ssh process ever spawns.
 *
 * F2 concurrency/barrier coverage for the registry path lives in
 * effect-concurrency.test.ts; this file covers the branch's success/fallback
 * *outcomes*, not its overlap-with-the-barrier timing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  ensureComposeRegistry: vi.fn(),
  pushImageOverSshTunnel: vi.fn(),
  sshRunAsync: vi.fn(),
  sideloadCompose: vi.fn(),
  startComposeStackRemote: vi.fn(),
  runCommandAsync: vi.fn(),
  progressLog: vi.fn(),
}));

// The settle ladder is NOT stubbed with a literal here — the point of the
// assertion below is that transferImage forwards the real compose constant,
// so it comes from the real module.
vi.mock('../../../src/lib/deploy/compose/registry.js', async () => ({
  ensureComposeRegistry: H.ensureComposeRegistry,
  REGISTRY_PREFIX: '127.0.0.1:5000/',
  COMPOSE_PUSH_SETTLE_DELAYS_MS: (
    await import('../../../src/lib/deploy/compose/registry-config.js')
  ).COMPOSE_PUSH_SETTLE_DELAYS_MS,
}));

vi.mock('../../../src/lib/deploy/registry-push.js', () => ({
  pushImageOverSshTunnel: H.pushImageOverSshTunnel,
}));

vi.mock('../../../src/lib/deploy/image.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, sideloadCompose: H.sideloadCompose };
});

// compose/index.js exports both sshRunAsync (server-side pull+retag) and
// startComposeStack (the barrier's reconcile call) — mock both so a rejected
// registry step never falls through to a real SSH/reconcile invocation.
vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, sshRunAsync: H.sshRunAsync, startComposeStack: H.startComposeStackRemote };
});

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, runCommandAsync: H.runCommandAsync };
});

vi.mock('../../../src/lib/cli/progress.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, progressLog: H.progressLog };
});

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { COMPOSE_PUSH_SETTLE_DELAYS_MS } = await import(
  '../../../src/lib/deploy/compose/registry-config.js'
);
// registry-push.js is mocked above, so import the k8s default from the
// unmocked original to compare against.
const { DEFAULT_PUSH_SETTLE_DELAYS_MS } = await vi.importActual<{
  DEFAULT_PUSH_SETTLE_DELAYS_MS: number[];
}>('../../../src/lib/deploy/registry-push.js');

function baseCtx(): Record<string, unknown> {
  return {
    isComposeLocal: true,
    isDirectDeploy: false,
    composeLocalBuildPromise: Promise.resolve(),
    localImageTag: 'p-app:local',
    serverIp: '1.1.1.1',
    sshKeyPath: '/tmp/key',
    projectConfig: { projectName: 'p' },
    services: {},
    domain: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.ensureComposeRegistry.mockResolvedValue(undefined);
  H.runCommandAsync.mockResolvedValue('');
  H.pushImageOverSshTunnel.mockResolvedValue(undefined);
  H.sshRunAsync.mockResolvedValue('');
  H.sideloadCompose.mockResolvedValue(undefined);
  H.startComposeStackRemote.mockResolvedValue(undefined);
});

describe('transferImage (compose-local): registry-first, sideload fallback', () => {
  it('happy path: ensure -> operator-side tag -> push -> server pull+retag; sideload never called', async () => {
    const ctx = baseCtx();
    await EFFECTS.transferImage(ctx);
    await ctx.transferImagePromise;

    expect(H.ensureComposeRegistry).toHaveBeenCalledWith('1.1.1.1', '/tmp/key');
    expect(H.runCommandAsync).toHaveBeenCalledWith(
      ['docker', 'tag', 'p-app:local', '127.0.0.1:5000/p-app:local'],
      { silent: true },
    );
    expect(H.pushImageOverSshTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: '127.0.0.1:5000/p-app:local',
        remotePrefix: '127.0.0.1:5000/',
        serverIp: '1.1.1.1',
        sshKey: '/tmp/key',
      }),
    );
    expect(H.sshRunAsync).toHaveBeenCalledWith(
      '1.1.1.1',
      '/tmp/key',
      'docker pull 127.0.0.1:5000/p-app:local && docker tag 127.0.0.1:5000/p-app:local p-app:local',
    );
    expect(H.sideloadCompose).not.toHaveBeenCalled();
    expect(H.progressLog).not.toHaveBeenCalled();
  });

  it('passes COMPOSE_PUSH_SETTLE_DELAYS_MS, not the shared helper k8s default', async () => {
    // The k8s default (226s of settle) was budgeted for S3 throttling under
    // parallel HA cluster pushes; compose has a filesystem-backed registry,
    // one pusher, and an automatic sideload fallback. Forwarding the k8s
    // ladder means every deploy against a wedged-but-running registry burns
    // ~4min of dead retries before falling back.
    const ctx = baseCtx();
    await EFFECTS.transferImage(ctx);
    await ctx.transferImagePromise;

    const { settleDelaysMs } = H.pushImageOverSshTunnel.mock.calls[0][0];
    expect(settleDelaysMs).toEqual(COMPOSE_PUSH_SETTLE_DELAYS_MS);
    expect(settleDelaysMs).not.toEqual(DEFAULT_PUSH_SETTLE_DELAYS_MS);
    // Post-shrink (2026-08-16) the k8s tail is gone too; compose still stays
    // at or below k8s because it has a sideload fallback to reach for.
    const sum = (a: number[]) => a.reduce((t, n) => t + n, 0);
    expect(sum(settleDelaysMs)).toBeLessThanOrEqual(sum(DEFAULT_PUSH_SETTLE_DELAYS_MS));
    expect(settleDelaysMs).toEqual(COMPOSE_PUSH_SETTLE_DELAYS_MS);
  });

  it('ensureComposeRegistry rejects -> falls back to sideload and logs the reason', async () => {
    H.ensureComposeRegistry.mockRejectedValue(new Error('registry create failed'));
    const ctx = baseCtx();
    await EFFECTS.transferImage(ctx);
    await ctx.transferImagePromise;

    expect(H.pushImageOverSshTunnel).not.toHaveBeenCalled();
    expect(H.sideloadCompose).toHaveBeenCalledWith({
      tag: 'p-app:local',
      sshTarget: 'root@1.1.1.1',
      sshKey: '/tmp/key',
    });
    expect(H.progressLog).toHaveBeenCalledTimes(1);
    expect(H.progressLog.mock.calls[0][0]).toMatch(/^\[registry\] falling back to sideload: /);
    expect(H.progressLog.mock.calls[0][0]).toContain('registry create failed');
  });

  it('pushImageOverSshTunnel rejects -> falls back to sideload and logs the reason', async () => {
    H.pushImageOverSshTunnel.mockRejectedValue(new Error('push exhausted retries'));
    const ctx = baseCtx();
    await EFFECTS.transferImage(ctx);
    await ctx.transferImagePromise;

    expect(H.sshRunAsync).not.toHaveBeenCalled();
    expect(H.sideloadCompose).toHaveBeenCalledWith({
      tag: 'p-app:local',
      sshTarget: 'root@1.1.1.1',
      sshKey: '/tmp/key',
    });
    expect(H.progressLog.mock.calls[0][0]).toContain('push exhausted retries');
  });

  it('server-side pull+retag rejects -> falls back to sideload and logs the reason', async () => {
    H.sshRunAsync.mockRejectedValue(new Error('docker pull failed on server'));
    const ctx = baseCtx();
    await EFFECTS.transferImage(ctx);
    await ctx.transferImagePromise;

    expect(H.sideloadCompose).toHaveBeenCalledWith({
      tag: 'p-app:local',
      sshTarget: 'root@1.1.1.1',
      sshKey: '/tmp/key',
    });
    expect(H.progressLog.mock.calls[0][0]).toContain('docker pull failed on server');
  });

  it('R7: registry AND sideload both reject -> transferImagePromise rejects, and startComposeStack rethrows (no swallow)', async () => {
    H.ensureComposeRegistry.mockRejectedValue(new Error('registry down'));
    H.sideloadCompose.mockRejectedValue(new Error('sideload also failed'));
    const ctx = baseCtx();
    await EFFECTS.transferImage(ctx);

    await expect(ctx.transferImagePromise).rejects.toThrow('sideload also failed');
    // The barrier in startComposeStack awaits the same promise — it must
    // rethrow rather than swallow, and reconcile must never run.
    await expect(EFFECTS.startComposeStack(ctx)).rejects.toThrow('sideload also failed');
    expect(H.startComposeStackRemote).not.toHaveBeenCalled();
  });
});
