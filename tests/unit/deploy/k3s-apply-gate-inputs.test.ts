import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { digestDir } from '../../../src/lib/deploy/digest.js';
// @ts-expect-error — JS module without types
import { BUNDLED_K8S_DIR, buildK3sApplyInputs } from '../../../src/lib/deploy/k8s/k3s.js';
// @ts-expect-error — JS module without types
import { StateTracker } from '../../../src/lib/deploy/state.js';

/**
 * Regression coverage for the `k3s-apply` gate hole found in the M3 follow-up
 * review: the step's inputs digested only `projectDir/k8s`, never the CLI's
 * OWN bundled `carbon/k8s` tree — which this same step applies (s3-egress-vpc,
 * repl-gateway) and which every project copy is generated from. A CLI upgrade
 * whose only change was a bundled manifest edit therefore left every gate input
 * identical, and a warm/state-resumed redeploy SKIPPED the apply: observed live
 * when the cluster-autoscaler probe-budget fix never reached a running cluster
 * until `k3s-apply` was hand-deleted from `.vibecarbon/deploy-state-<env>.json`.
 */

const REPO_BUNDLED_K8S = join(process.cwd(), 'carbon', 'k8s');
// digestDir of an empty/missing tree — the "we digested nothing" sentinel a
// wrong BUNDLED_K8S_DIR path would silently produce.
const EMPTY_TREE_DIGEST = digestDir(join(tmpdir(), 'vc-definitely-not-a-real-dir'));

describe('buildK3sApplyInputs — bundled manifest tree is part of the gate', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-k3s-gate-'));
    mkdirSync(join(dir, 'k8s', 'base'), { recursive: true });
    writeFileSync(join(dir, 'k8s', 'base', 'kustomization.yaml'), 'resources: []\n');
    // StateTracker keys its state file off process.cwd()/.vibecarbon.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseArgs = () => ({
    imageTag: 'registry:5000/app:abc123',
    dbImageTag: 'ghcr.io/o/db:v1',
    restore: undefined,
    projectDir: dir,
  });

  it('digests BOTH the project copy and the CLI-bundled carbon/k8s tree', () => {
    const inputs = buildK3sApplyInputs(baseArgs());

    expect(inputs.manifestDigest).toBe(digestDir(join(dir, 'k8s')));
    // Pins the bundled path itself: a wrong/renamed BUNDLED_K8S_DIR would
    // digest nothing at all and still look like a plausible hex string.
    expect(inputs.bundledManifestDigest).toBe(digestDir(REPO_BUNDLED_K8S));
    expect(inputs.bundledManifestDigest).not.toBe(EMPTY_TREE_DIGEST);
    expect(BUNDLED_K8S_DIR.endsWith(join('carbon', 'k8s'))).toBe(true);
    // Absent `restore` normalizes to '' so the hash is stable across runs.
    expect(inputs.restore).toBe('');
  });

  it('is stable across calls (content-only digest — no mtimes/absolute paths)', () => {
    expect(buildK3sApplyInputs(baseArgs())).toEqual(buildK3sApplyInputs(baseArgs()));
  });

  it('re-runs the gate when only the bundled manifest content changed', () => {
    const inputs = buildK3sApplyInputs(baseArgs());
    const t1 = new StateTracker('proj', 'prod');
    t1.startStep('k3s-apply', inputs);
    t1.completeStep('k3s-apply');

    // Same image tags, same project copy — only the CLI's bundled tree moved
    // (the shipped-CLI-upgrade case).
    const t2 = new StateTracker('proj', 'prod');
    expect(
      t2.shouldSkip('k3s-apply', { ...inputs, bundledManifestDigest: 'changed-by-cli-upgrade' }),
    ).toBe(false);

    // Nothing changed at all — still skips (no needless 20-minute re-apply).
    const t3 = new StateTracker('proj', 'prod');
    expect(t3.shouldSkip('k3s-apply', buildK3sApplyInputs(baseArgs()))).toBe(true);
  });

  it('re-runs the gate when only the project manifest content changed', () => {
    const t1 = new StateTracker('proj', 'prod');
    t1.startStep('k3s-apply', buildK3sApplyInputs(baseArgs()));
    t1.completeStep('k3s-apply');

    writeFileSync(join(dir, 'k8s', 'base', 'kustomization.yaml'), 'resources: [app.yaml]\n');
    const t2 = new StateTracker('proj', 'prod');
    expect(t2.shouldSkip('k3s-apply', buildK3sApplyInputs(baseArgs()))).toBe(false);
  });
});
