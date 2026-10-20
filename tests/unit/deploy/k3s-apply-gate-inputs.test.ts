import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // Post-failover reconverge (e4, 2026-10-20). Each cluster's deploy-state
  // file is keyed by its STACK name; failover swaps which stack holds which
  // role and touches neither file. The reconverge redeploy then hashed the
  // same image tags + manifests as each stack's last deploy and skipped the
  // apply on both, so the promoted cluster never got observability.
  it('re-runs the gate on a stack promoted from standby to primary', () => {
    const asStandby = new StateTracker('proj', 'e4-standby');
    asStandby.startStep('k3s-apply', buildK3sApplyInputs({ ...baseArgs(), role: 'standby' }));
    asStandby.completeStep('k3s-apply');

    const promoted = new StateTracker('proj', 'e4-standby');
    expect(
      promoted.shouldSkip('k3s-apply', buildK3sApplyInputs({ ...baseArgs(), role: 'primary' })),
    ).toBe(false);
  });

  it('re-runs the gate on a stack demoted from primary to standby', () => {
    const asPrimary = new StateTracker('proj', 'e4-primary');
    asPrimary.startStep('k3s-apply', buildK3sApplyInputs({ ...baseArgs(), role: 'primary' }));
    asPrimary.completeStep('k3s-apply');

    const demoted = new StateTracker('proj', 'e4-primary');
    expect(
      demoted.shouldSkip('k3s-apply', buildK3sApplyInputs({ ...baseArgs(), role: 'standby' })),
    ).toBe(false);
  });

  it('a same-role redeploy still skips, and single-cluster hashes as primary', () => {
    const t1 = new StateTracker('proj', 'e4-standby');
    t1.startStep('k3s-apply', buildK3sApplyInputs({ ...baseArgs(), role: 'standby' }));
    t1.completeStep('k3s-apply');
    expect(
      new StateTracker('proj', 'e4-standby').shouldSkip(
        'k3s-apply',
        buildK3sApplyInputs({ ...baseArgs(), role: 'standby' }),
      ),
    ).toBe(true);
    expect(buildK3sApplyInputs(baseArgs())).toEqual(
      buildK3sApplyInputs({ ...baseArgs(), role: 'primary' }),
    );
  });
});

describe('deployK3s feeds the pilot-light role into the k3s-apply gate', () => {
  it('passes options.role to buildK3sApplyInputs', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const body = src.slice(src.indexOf('export async function deployK3s('));
    const gateCall = body.slice(body.indexOf('buildK3sApplyInputs({'));
    expect(gateCall.slice(0, gateCall.indexOf('});'))).toMatch(/\n\s+role: options\.role,\n/);
  });
});

// Nothing k3s-apply renders carries the environment name (the k8s Secret has
// no VC_ENV; the WAL-G prefix is rendered from walgPrefix, constant per env),
// so the environment is not a gate input, and there is no key prefix either.
describe('buildK3sApplyInputs — no environment or key prefix input', () => {
  const base = { imageTag: 'r:5000/app:abc', dbImageTag: 'db:v1', projectDir: tmpdir() };

  it('records neither environment nor keyPrefix', () => {
    const inputs = buildK3sApplyInputs(base);
    expect(inputs).not.toHaveProperty('environment');
    expect(inputs).not.toHaveProperty('keyPrefix');
  });

  it('deployK3s does not pass an environment to the gate', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const body = src.slice(src.indexOf('export async function deployK3s('));
    const gateCall = body.slice(body.indexOf('buildK3sApplyInputs({'));
    const args = gateCall.slice(0, gateCall.indexOf('});'));
    expect(args).not.toMatch(/environment:/);
  });
});
