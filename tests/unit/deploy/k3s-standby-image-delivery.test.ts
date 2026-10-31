import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverAppImage, startAppImageBuild } from '../../../src/lib/deploy/k8s/k3s.js';
import { StateTracker } from '../../../src/lib/deploy/state.js';

/**
 * A k8s-ha standby takes the primary's app image by copy: it never builds or
 * delivers its own. deliverAppImage is the build step deployK3s runs,
 * extracted with injectable deps because deployK3s itself can't be driven in a
 * unit test. It only builds: the one delivery to the master's registry runs in
 * applyK3sManifests (k8s-image-delivery-order.test.ts), and no node gets the
 * image from the operator any more.
 */
function harness(role?: 'primary' | 'standby', extra: Record<string, unknown> = {}) {
  // StateTracker writes under process.cwd()/.vibecarbon (state.js:26).
  vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'vc-deliver-')));
  // The build tags the image for no particular cluster; deliverAppImage
  // retags it for the master's registry once the master's private IP is known.
  const buildAppImage = vi.fn(async () => ({
    tag: 'vibecarbon-local/quorum:built',
    gitSha: 'abc',
    isDirty: false,
  }));
  const tagImage = vi.fn(async () => {});
  const buildK3sBuildInputs = vi.fn(() => ({
    projectName: 'quorum',
    masterPrivateIp: '10.0.1.1',
    sourceDigest: 'd',
    buildArgsDigest: 'b',
  }));
  const onImageBuilt = vi.fn();
  const args = {
    role,
    onImageBuilt,
    state: new StateTracker('quorum', `e4-${role ?? 'single'}`),
    projectDir: '/p',
    projectName: 'quorum',
    masterPrivateIp: '10.0.1.1',
    perfPrefix: `k3s.${role ?? 'x'}`,
    spinner: { start() {}, stop() {} },
    deps: { buildAppImage, buildK3sBuildInputs, tagImage },
    ...extra,
  };
  return { args, buildAppImage, buildK3sBuildInputs, tagImage, onImageBuilt };
}

describe('deliverAppImage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('standby: no build, the peer ref re-prefixed', async () => {
    const h = harness('standby', {
      masterPrivateIp: '10.120.0.3',
      peerImageRef: Promise.resolve('10.110.0.2:5000/quorum:t1'),
    });
    await expect(deliverAppImage(h.args)).resolves.toBe('10.120.0.3:5000/quorum:t1');
    expect(h.buildAppImage).not.toHaveBeenCalled();
    expect(h.onImageBuilt).not.toHaveBeenCalled();
  });

  it('standby: never hashes the app source (no build gate, no build inputs)', async () => {
    const h = harness('standby', {
      masterPrivateIp: '10.120.0.3',
      peerImageRef: Promise.resolve('10.110.0.2:5000/quorum:t1'),
    });
    await deliverAppImage(h.args);
    expect(h.buildK3sBuildInputs).not.toHaveBeenCalled();
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

  it('primary: build, onImageBuilt once with the built tag; a warm rerun still reports the tag', async () => {
    const h = harness('primary');
    await expect(deliverAppImage(h.args)).resolves.toBe('10.0.1.1:5000/quorum:built');
    expect(h.buildK3sBuildInputs).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: '/p',
        projectName: 'quorum',
        masterPrivateIp: '10.0.1.1',
      }),
    );
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
  });

  it('primary: records no per-node sideload step', async () => {
    const h = harness('primary');
    const state = h.args.state as InstanceType<typeof StateTracker>;
    await deliverAppImage(h.args);
    expect(state.state.steps['k3s-sideload']).toBeUndefined();
  });
});

/**
 * The app image build runs on the operator's machine and needs nothing from
 * the cluster but the master's private IP, which only names the registry the
 * image is pushed to. So it starts before the cluster is provisioned, while
 * Pulumi creates the servers (DO e2e 2026-10-31: it ran serially after k3s
 * was Ready), and deliverAppImage retags it for the registry afterwards.
 */
describe('startAppImageBuild: the build overlaps provisioning', () => {
  afterEach(() => vi.restoreAllMocks());

  const startArgs = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) => ({
    role: h.args.role,
    state: h.args.state,
    projectDir: '/p',
    projectName: 'quorum',
    domain: 'q.example.test',
    perfPrefix: 'k3s',
    deps: h.args.deps,
    ...extra,
  });

  it('cold deploy: starts the build at once, quietly, before any cluster exists', () => {
    const h = harness('primary');
    const build = startAppImageBuild(startArgs(h, { priorMasterPrivateIp: undefined }));
    expect(build).toBeInstanceOf(Promise);
    // Synchronously started: nothing has to settle first.
    expect(h.buildAppImage).toHaveBeenCalledExactlyOnceWith(
      '/p',
      'quorum',
      false,
      'q.example.test',
      {
        quiet: true,
      },
    );
  });

  it('standby: starts nothing (it copies the primary image)', () => {
    const h = harness('standby');
    expect(startAppImageBuild(startArgs(h))).toBeNull();
    expect(h.buildAppImage).not.toHaveBeenCalled();
  });

  it('warm rerun whose build gate will skip: starts nothing', async () => {
    const h = harness('primary');
    await deliverAppImage(h.args); // completes k3s-build under 10.0.1.1
    h.buildAppImage.mockClear();
    expect(startAppImageBuild(startArgs(h, { priorMasterPrivateIp: '10.0.1.1' }))).toBeNull();
    expect(h.buildAppImage).not.toHaveBeenCalled();
  });

  it('warm rerun whose inputs changed: starts the build early too', async () => {
    const h = harness('primary');
    await deliverAppImage(h.args);
    h.buildAppImage.mockClear();
    h.buildK3sBuildInputs.mockReturnValue({
      projectName: 'quorum',
      masterPrivateIp: '10.0.1.1',
      sourceDigest: 'changed',
      buildArgsDigest: 'b',
    });
    expect(startAppImageBuild(startArgs(h, { priorMasterPrivateIp: '10.0.1.1' }))).not.toBeNull();
    expect(h.buildAppImage).toHaveBeenCalledTimes(1);
  });

  it('a build that fails before anyone awaits it is not an unhandled rejection', async () => {
    const h = harness('primary');
    h.buildAppImage.mockRejectedValueOnce(new Error('docker build failed'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      startAppImageBuild(startArgs(h));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('deliverAppImage: takes the early build and retags it for the registry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the early build, builds nothing itself, and records the registry tag', async () => {
    const h = harness('primary', { masterPrivateIp: '10.110.0.2' });
    const earlyBuild = Promise.resolve({
      tag: 'vibecarbon-local/quorum:early',
      gitSha: 'abc',
      isDirty: false,
    });
    await expect(deliverAppImage({ ...h.args, earlyBuild })).resolves.toBe(
      '10.110.0.2:5000/quorum:early',
    );
    expect(h.buildAppImage).not.toHaveBeenCalled();
    expect(h.tagImage).toHaveBeenCalledExactlyOnceWith(
      'vibecarbon-local/quorum:early',
      '10.110.0.2:5000/quorum:early',
    );
    expect(h.onImageBuilt).toHaveBeenCalledExactlyOnceWith('10.110.0.2:5000/quorum:early');
  });

  it('a failed early build fails the deploy loudly and records no build', async () => {
    const h = harness('primary');
    const earlyBuild = Promise.reject(new Error('buildLocalImage: docker build failed for x'));
    earlyBuild.catch(() => {});
    await expect(deliverAppImage({ ...h.args, earlyBuild })).rejects.toThrow(
      'buildLocalImage: docker build failed for x',
    );
    expect(h.args.state.getStepResult('k3s-build')).toBeNull();
    expect(h.tagImage).not.toHaveBeenCalled();
  });

  it('no early build: builds now and retags the same way', async () => {
    const h = harness('primary');
    await expect(deliverAppImage(h.args)).resolves.toBe('10.0.1.1:5000/quorum:built');
    expect(h.buildAppImage).toHaveBeenCalledExactlyOnceWith('/p', 'quorum', false, undefined);
    expect(h.tagImage).toHaveBeenCalledExactlyOnceWith(
      'vibecarbon-local/quorum:built',
      '10.0.1.1:5000/quorum:built',
    );
  });
});
