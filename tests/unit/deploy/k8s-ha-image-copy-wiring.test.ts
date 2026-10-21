/**
 * Task 5: the k8s-ha deploy copies the primary's app image to the standby.
 *
 * The primary's built ref reaches the standby's deployK3s as a promise
 * (`peerImageRef`), rejected when the primary deploy fails. The copy itself
 * runs only once the WireGuard transport is up: early, inside
 * provision-clusters, when the fan-out prepared it; otherwise in the
 * copy-standby-image step. Either way that step settles it, exactly once.
 * Under -allow-degraded a failed copy marks the standby image missing and the
 * deploy completes (R14); without the flag the deploy fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const events: string[] = [];
const PRIMARY_REF = '10.0.1.11:5000/app:abc123-20261021';

/** A cluster's result keyed by its stack identity, so a role swap shows. */
const clusterFor = (env: string) =>
  env.endsWith('-primary')
    ? { masterIp: '1.1.1.1', dbIp: '1.1.1.2', masterPrivateIp: '10.0.1.11' }
    : { masterIp: '2.2.2.1', dbIp: '2.2.2.2', masterPrivateIp: '10.0.1.21' };

const deployK3s = vi.fn(async (opts: Record<string, unknown>) => {
  const env = String(opts.environment);
  const base = { ...clusterFor(env), floatingIp: '9.9.9.9', dbPrivateIp: '10.0.1.2' };
  if (opts.role === 'primary') {
    (opts.onImageBuilt as (t: string) => void)(PRIMARY_REF);
    events.push('primary:deployed');
    return { ...base, kubeconfig: `/tmp/kc-${env}`, imageTag: PRIMARY_REF };
  }
  const ref = await (opts.peerImageRef as Promise<string>);
  events.push('standby:deployed');
  return { ...base, kubeconfig: `/tmp/kc-${env}`, imageTag: `standby-of:${ref}` };
});

vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/deploy/k8s/k3s.js')>()),
  deployK3s,
}));

vi.mock('../../../src/lib/iac/index.js', () => ({
  summarizePulumiError: (err: unknown) => String((err as Error)?.message ?? err),
}));

const prepareReplicationTransport = vi.fn(async () => {
  events.push('prep:done');
});
vi.mock('../../../src/lib/deploy/k8s/ha/index.js', () => ({
  prepareReplicationTransport,
  configurePrimaryForReplication: vi.fn(async () => {}),
  setupReplication: vi.fn(async () => ({ streaming: true, lastState: '' })),
}));

const copyAppImageToStandby = vi.fn(async () => {
  events.push('copy');
  return { digest: 'sha256:aa', skipped: false };
});
vi.mock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({ copyAppImageToStandby }));

vi.mock('@clack/prompts', async (orig) => ({
  ...(await orig<typeof import('@clack/prompts')>()),
  log: { info: vi.fn(), warn: vi.fn(), step: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const p = await import('@clack/prompts');
const { K8S_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/k8s-ha.js');

const spinner = () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() });
const newCtx = (over: Record<string, unknown> = {}) =>
  ({
    s: spinner(),
    sharedSshKeyPath: '/k/deploy_key_e4',
    options: { environment: 'e4', region: 'nbg1', secondaryRegion: 'hel1', ...over },
  }) as Record<string, unknown>;

/** Let any stray rejection surface before asserting there was none. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  events.length = 0;
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  deployK3s.mockClear();
  prepareReplicationTransport.mockClear();
  copyAppImageToStandby.mockClear();
  vi.mocked(p.log.warn).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.restoreAllMocks();
});

describe('the primary image ref flows to the standby', () => {
  it('passes onImageBuilt to the primary and the resolved ref to the standby', async () => {
    await K8S_HA_EFFECTS.haK8sProvisionClusters(newCtx());
    const calls = deployK3s.mock.calls.map(([o]) => o as Record<string, unknown>);
    const primary = calls.find((o) => o.role === 'primary');
    const standby = calls.find((o) => o.role === 'standby');
    expect(typeof primary?.onImageBuilt).toBe('function');
    expect(primary?.peerImageRef).toBeUndefined();
    await expect(standby?.peerImageRef as Promise<string>).resolves.toBe(PRIMARY_REF);
    // The per-cluster tunnel ports are gone with the operator push.
    expect(primary).not.toHaveProperty('localTunnelPort');
    expect(standby).not.toHaveProperty('localTunnelPort');
  });

  it('rejects the standby ref when the primary deploy fails, and never copies', async () => {
    deployK3s.mockImplementationOnce(async (opts: Record<string, unknown>) => {
      if (opts.role === 'primary') throw new Error('pulumi up failed');
      return {} as never;
    });
    deployK3s.mockImplementationOnce(async (opts: Record<string, unknown>) => {
      await (opts.peerImageRef as Promise<string>);
      return {} as never;
    });
    const ctx = newCtx();
    await expect(K8S_HA_EFFECTS.haK8sProvisionClusters(ctx)).rejects.toThrow(
      /^HA deploy failed — primary: pulumi up failed/,
    );
    const standby = deployK3s.mock.calls
      .map(([o]) => o as Record<string, unknown>)
      .find((o) => o.role === 'standby');
    await expect(standby?.peerImageRef as Promise<string>).rejects.toThrow(
      'primary image unavailable: primary deploy failed',
    );
    expect(copyAppImageToStandby).not.toHaveBeenCalled();
    await settle();
    expect(unhandled).toEqual([]);
  });
});

describe('the primary settlement settles the image ref', () => {
  const standbyRef = () =>
    deployK3s.mock.calls
      .map(([o]) => o as Record<string, unknown>)
      .find((o) => o.role === 'standby')?.peerImageRef as Promise<string>;

  it('a primary that returns its tag without reporting it still hands it over', async () => {
    deployK3s.mockImplementationOnce(async (opts: Record<string, unknown>) => ({
      ...clusterFor(String(opts.environment)),
      imageTag: PRIMARY_REF,
    }));
    await K8S_HA_EFFECTS.haK8sProvisionClusters(newCtx());
    await expect(standbyRef()).resolves.toBe(PRIMARY_REF);
  });

  it('a primary that finishes with no image rejects the ref, so the standby never hangs', async () => {
    deployK3s.mockImplementationOnce(async (opts: Record<string, unknown>) => ({
      ...clusterFor(String(opts.environment)),
    }));
    deployK3s.mockImplementationOnce(async (opts: Record<string, unknown>) => {
      await (opts.peerImageRef as Promise<string>);
      return {} as never;
    });
    await expect(K8S_HA_EFFECTS.haK8sProvisionClusters(newCtx())).rejects.toThrow(
      /standby: primary image unavailable: primary reported no image/,
    );
    await settle();
    expect(unhandled).toEqual([]);
  });
});

describe('the copy starts once the transport is up', () => {
  it('early: provision-clusters starts it after the transport prep, the step awaits it', async () => {
    const ctx = newCtx();
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    expect(ctx.transportPrepared).toBe(true);
    expect(copyAppImageToStandby).toHaveBeenCalledTimes(1);
    expect(events.indexOf('copy')).toBeGreaterThan(events.indexOf('prep:done'));
    expect(copyAppImageToStandby).toHaveBeenCalledWith({
      primaryRef: PRIMARY_REF,
      primaryIp: '1.1.1.1',
      standbyIp: '2.2.2.1',
      primaryMasterPrivateIp: '10.0.1.11',
      standbyMasterPrivateIp: '10.0.1.21',
      standbyDbIp: '2.2.2.2',
      sshKeyPath: '/k/deploy_key_e4',
    });

    await K8S_HA_EFFECTS.haK8sCopyStandbyImage(ctx);
    expect(copyAppImageToStandby).toHaveBeenCalledTimes(1);
    expect(ctx.standbyImageDigest).toBe('sha256:aa');
    expect(ctx.standbyImageMissing).toBe(false);
  });

  it('late: a failed transport prep defers the copy to copy-standby-image', async () => {
    prepareReplicationTransport.mockRejectedValueOnce(new Error('wg handshake timeout'));
    const ctx = newCtx();
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    expect(ctx.transportPrepared).toBe(false);
    expect(copyAppImageToStandby).not.toHaveBeenCalled();

    await K8S_HA_EFFECTS.haK8sCopyStandbyImage(ctx);
    expect(copyAppImageToStandby).toHaveBeenCalledTimes(1);
    expect(ctx.standbyImageDigest).toBe('sha256:aa');
  });

  it('a reconverge copies from the cluster now deployed as primary to the one now standby', async () => {
    const ctx = newCtx({
      region: 'hel1',
      secondaryRegion: 'nbg1',
      haStacks: {
        primary: { stack: 'e4-standby', region: 'hel1' },
        standby: { stack: 'e4-primary', region: 'nbg1' },
      },
    });
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    await K8S_HA_EFFECTS.haK8sCopyStandbyImage(ctx);
    // e4-standby is serving (role primary): it is the source.
    expect(copyAppImageToStandby).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryIp: '2.2.2.1',
        primaryMasterPrivateIp: '10.0.1.21',
        standbyIp: '1.1.1.1',
        standbyMasterPrivateIp: '10.0.1.11',
        standbyDbIp: '1.1.1.2',
      }),
    );
  });
});

describe('a failed copy', () => {
  const failure = 'standby image copy failed: x';

  it('early: fails the deploy with exactly its message, and no unhandled rejection', async () => {
    copyAppImageToStandby.mockRejectedValueOnce(new Error(failure));
    const ctx = newCtx();
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    expect(copyAppImageToStandby).toHaveBeenCalledTimes(1);
    await settle();
    expect(unhandled).toEqual([]);
    await expect(K8S_HA_EFFECTS.haK8sCopyStandbyImage(ctx)).rejects.toThrow(
      new RegExp(`^${failure}$`),
    );
    expect(copyAppImageToStandby).toHaveBeenCalledTimes(1);
  });

  it('late: fails the deploy with exactly its message', async () => {
    prepareReplicationTransport.mockRejectedValueOnce(new Error('wg handshake timeout'));
    copyAppImageToStandby.mockRejectedValueOnce(new Error(failure));
    const ctx = newCtx();
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    await expect(K8S_HA_EFFECTS.haK8sCopyStandbyImage(ctx)).rejects.toThrow(
      new RegExp(`^${failure}$`),
    );
  });

  it('under -allow-degraded does not double the period of a cause that has one', async () => {
    copyAppImageToStandby.mockRejectedValueOnce(new Error(`${failure}.`));
    const ctx = newCtx({ allowDegraded: true });
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    await K8S_HA_EFFECTS.haK8sCopyStandbyImage(ctx);
    const warned = vi.mocked(p.log.warn).mock.calls.map(([m]) => String(m));
    expect(warned.some((m) => m.includes(`${failure}. The standby`))).toBe(true);
    expect(warned.some((m) => m.includes('..'))).toBe(false);
  });

  it('under -allow-degraded marks the standby image missing and lets the deploy finish', async () => {
    copyAppImageToStandby.mockRejectedValueOnce(new Error(failure));
    const ctx = newCtx({ allowDegraded: true });
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
    await K8S_HA_EFFECTS.haK8sCopyStandbyImage(ctx);
    expect(ctx.standbyImageMissing).toBe(true);
    expect(ctx.standbyImageDigest ?? null).toBeNull();
    const warned = vi.mocked(p.log.warn).mock.calls.map(([m]) => String(m));
    expect(warned.some((m) => m.includes(failure) && /failover/i.test(m))).toBe(true);
    // One sentence end, whether or not the cause brought its own.
    expect(warned.some((m) => m.includes('..'))).toBe(false);
    await settle();
    expect(unhandled).toEqual([]);
  });
});
