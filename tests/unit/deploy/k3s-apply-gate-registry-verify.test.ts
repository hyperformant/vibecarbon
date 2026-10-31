import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { primaryRegistryHasImage, shouldSkipK3sApply } from '../../../src/lib/deploy/k8s/k3s.js';
import { StateTracker } from '../../../src/lib/deploy/state.js';

/**
 * The primary's one image delivery (deliverImage: a layer delta into the
 * master, then `ctr images push` into its registry) lives inside the k3s-apply
 * gate. The gate's inputs (manifests, tags) can't see a registry that lost its
 * contents, so a warm primary deploy verifies the tag is still there and
 * re-runs the apply (and so the delivery) when it is not. A standby delivers
 * nothing and skips on the hash.
 */
const IMAGE = '10.0.1.1:5000/quorum:abc-123';
const inputs = { imageTag: IMAGE };

function warmState() {
  vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'vc-gate-')));
  const state = new StateTracker('quorum', 'e4');
  state.startStep('k3s-apply', inputs);
  state.completeStep('k3s-apply');
  return state;
}

describe('shouldSkipK3sApply', () => {
  afterEach(() => vi.restoreAllMocks());

  it('primary, tag present: skips', async () => {
    const imageInRegistry = vi.fn(async () => true);
    await expect(
      shouldSkipK3sApply({
        state: warmState(),
        applyInputs: inputs,
        role: 'primary',
        imageInRegistry,
      }),
    ).resolves.toBe(true);
    expect(imageInRegistry).toHaveBeenCalledTimes(1);
  });

  it('primary, tag missing: does not skip, so the delivery runs again', async () => {
    await expect(
      shouldSkipK3sApply({
        state: warmState(),
        applyInputs: inputs,
        role: 'primary',
        imageInRegistry: async () => false,
      }),
    ).resolves.toBe(false);
  });

  it('single cluster (no role) verifies like a primary', async () => {
    await expect(
      shouldSkipK3sApply({
        state: warmState(),
        applyInputs: inputs,
        imageInRegistry: async () => false,
      }),
    ).resolves.toBe(false);
  });

  it('changed inputs: never probes, never skips', async () => {
    const imageInRegistry = vi.fn(async () => true);
    await expect(
      shouldSkipK3sApply({
        state: warmState(),
        applyInputs: { imageTag: 'other' },
        role: 'primary',
        imageInRegistry,
      }),
    ).resolves.toBe(false);
    expect(imageInRegistry).not.toHaveBeenCalled();
  });

  it('standby: skips on the hash alone, no registry probe', async () => {
    const imageInRegistry = vi.fn(async () => false);
    await expect(
      shouldSkipK3sApply({
        state: warmState(),
        applyInputs: inputs,
        role: 'standby',
        imageInRegistry,
      }),
    ).resolves.toBe(true);
    expect(imageInRegistry).not.toHaveBeenCalled();
  });
});

describe('primaryRegistryHasImage', () => {
  const base = { masterIp: '203.0.113.5', sshKeyPath: '/k', imageTag: IMAGE };

  it('true when the registry answers with a digest; the script HEADs that exact tag', async () => {
    const run = vi.fn(async () => 'sha256:deadbeef');
    await expect(primaryRegistryHasImage({ ...base, run })).resolves.toBe(true);
    const script = String(run.mock.calls[0]?.[0]);
    expect(script).toContain('digest 10.0.1.1:5000 quorum abc-123');
    expect(script).toContain('docker-content-digest');
  });

  it('false when the registry has no such tag (empty digest)', async () => {
    await expect(primaryRegistryHasImage({ ...base, run: async () => '' })).resolves.toBe(false);
  });

  it('an ssh failure propagates, so the gate keeps its hash decision', async () => {
    await expect(
      primaryRegistryHasImage({
        ...base,
        run: async () => {
          throw new Error('ssh: connect refused');
        },
      }),
    ).rejects.toThrow('ssh: connect refused');
  });

  it('refuses a ref that is not a shell-safe local-registry ref', async () => {
    await expect(
      primaryRegistryHasImage({ ...base, imageTag: '10.0.1.1:5000/q:$(id)', run: async () => 'x' }),
    ).rejects.toThrow();
  });
});

describe('deployK3s wiring', () => {
  it('the k3s-apply gate goes through shouldSkipK3sApply', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const body = src.slice(src.indexOf('export async function deployK3s('));
    expect(body).toContain('await shouldSkipK3sApply({');
    expect(body).toContain('if (!skipApply) {');
    expect(body).not.toContain("state.shouldSkip('k3s-apply'");
  });
});
