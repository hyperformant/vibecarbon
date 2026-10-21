import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverAppImage } from '../../../src/lib/deploy/k8s/k3s.js';
import { StateTracker } from '../../../src/lib/deploy/state.js';

/**
 * A k8s-ha standby takes the primary's app image by copy: it never builds,
 * sideloads or pushes its own. deliverAppImage is the image step deployK3s
 * runs, extracted with injectable deps because deployK3s itself can't be
 * driven in a unit test.
 */
function harness(role?: 'primary' | 'standby', extra: Record<string, unknown> = {}) {
  // StateTracker writes under process.cwd()/.vibecarbon (state.js:26).
  vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'vc-deliver-')));
  const buildAppImage = vi.fn(async () => ({
    tag: '10.0.1.1:5000/quorum:built',
    gitSha: 'abc',
    isDirty: false,
  }));
  const sideloadK3s = vi.fn(async () => {});
  const onImageBuilt = vi.fn();
  const args = {
    role,
    onImageBuilt,
    state: new StateTracker('quorum', `e4-${role ?? 'single'}`),
    buildInputs: {
      projectName: 'quorum',
      masterPrivateIp: '10.0.1.1',
      sourceDigest: 'd',
      buildArgsDigest: 'b',
    },
    projectDir: '/p',
    projectName: 'quorum',
    masterPrivateIp: '10.0.1.1',
    sshTargets: ['root@m', 'root@d'],
    privateKeyPath: '/k',
    khPath: '/kh',
    perfPrefix: `k3s.${role ?? 'x'}`,
    spinner: { start() {}, stop() {} },
    deps: { buildAppImage, sideloadK3s },
    ...extra,
  };
  return { args, buildAppImage, sideloadK3s, onImageBuilt };
}

describe('deliverAppImage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('standby: no build, no sideload, the peer ref re-prefixed', async () => {
    const h = harness('standby', {
      masterPrivateIp: '10.120.0.3',
      peerImageRef: Promise.resolve('10.110.0.2:5000/quorum:t1'),
    });
    await expect(deliverAppImage(h.args)).resolves.toBe('10.120.0.3:5000/quorum:t1');
    expect(h.buildAppImage).not.toHaveBeenCalled();
    expect(h.sideloadK3s).not.toHaveBeenCalled();
    expect(h.onImageBuilt).not.toHaveBeenCalled();
  });

  it('standby: a failed primary rejects with its message, nothing built', async () => {
    const h = harness('standby', {
      peerImageRef: Promise.reject(new Error('primary image unavailable: primary deploy failed')),
    });
    await expect(deliverAppImage(h.args)).rejects.toThrow(
      'primary image unavailable: primary deploy failed',
    );
    expect(h.buildAppImage).not.toHaveBeenCalled();
  });

  it('standby without peerImageRef is a programming error', async () => {
    const h = harness('standby');
    await expect(deliverAppImage(h.args)).rejects.toThrow(
      'deployK3s: role standby requires peerImageRef',
    );
  });

  it('primary: build, sideload, onImageBuilt once with the built tag; a warm rerun still reports the tag', async () => {
    const h = harness('primary');
    await expect(deliverAppImage(h.args)).resolves.toBe('10.0.1.1:5000/quorum:built');
    expect(h.sideloadK3s).toHaveBeenCalledTimes(1);
    expect(h.onImageBuilt).toHaveBeenCalledExactlyOnceWith('10.0.1.1:5000/quorum:built');
    h.onImageBuilt.mockClear();
    await deliverAppImage(h.args); // same state: the k3s-build gate skips
    expect(h.buildAppImage).toHaveBeenCalledTimes(1);
    expect(h.onImageBuilt).toHaveBeenCalledExactlyOnceWith('10.0.1.1:5000/quorum:built');
  });

  it('single k8s (no role): same calls as primary, onImageBuilt optional', async () => {
    const h = harness(undefined, { onImageBuilt: undefined });
    await expect(deliverAppImage(h.args)).resolves.toBe('10.0.1.1:5000/quorum:built');
    expect(h.buildAppImage).toHaveBeenCalledTimes(1);
    expect(h.sideloadK3s).toHaveBeenCalledTimes(1);
  });
});
