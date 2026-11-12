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
// @ts-expect-error — JS module without types
import { activateImageSet, bundledImageSet } from '../../../src/lib/images.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

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

  it('an unchanged version set leaves the gate shut, and a moved one opens it', () => {
    const before = buildK3sApplyInputs(baseArgs());
    const set = bundledImageSet();
    try {
      activateImageSet(structuredClone(set));
      expect(buildK3sApplyInputs(baseArgs())).toEqual(before);
      activateImageSet({
        ...set,
        images: {
          ...set.images,
          traefik: `${set.images.traefik.split('@')[0]}@sha256:${'c'.repeat(64)}`,
        },
      });
      expect(buildK3sApplyInputs(baseArgs()).imageSetDigest).not.toBe(before.imageSetDigest);
    } finally {
      activateImageSet(null);
    }
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

  it('a same-role redeploy still skips', () => {
    const t1 = new StateTracker('proj', 'e4-standby');
    t1.startStep('k3s-apply', buildK3sApplyInputs({ ...baseArgs(), role: 'standby' }));
    t1.completeStep('k3s-apply');
    expect(
      new StateTracker('proj', 'e4-standby').shouldSkip(
        'k3s-apply',
        buildK3sApplyInputs({ ...baseArgs(), role: 'standby' }),
      ),
    ).toBe(true);
  });

  it('an HA cluster and a single cluster render different dbs, so they never share a skip', () => {
    // The HA db StatefulSet carries the replication hostPort from its first
    // apply (rendersReplicationHostPort); a single cluster's does not. A gate
    // blind to that would skip the apply that adds it, and the replication
    // setup would then find no hostPort to relay to.
    const single = buildK3sApplyInputs(baseArgs());
    const haPrimary = buildK3sApplyInputs({ ...baseArgs(), role: 'primary' });
    expect(single.replicationHostPort).toBe(false);
    expect(haPrimary.replicationHostPort).toBe(true);
    expect(buildK3sApplyInputs({ ...baseArgs(), role: 'standby' }).replicationHostPort).toBe(true);
    const t = new StateTracker('proj', 'e4-gate-ha');
    t.startStep('k3s-apply', single);
    t.completeStep('k3s-apply');
    expect(new StateTracker('proj', 'e4-gate-ha').shouldSkip('k3s-apply', haPrimary)).toBe(false);
  });
});

// Where the app bucket and the backups bucket are is rendered into the applied
// Secrets (the app Secret's S3_*, the infra Secret's S3_BACKUP_BUCKET) and the
// db StatefulSet (wal-g's endpoint and region), and no manifest digest sees
// them. Without them in the gate, a deploy that corrected an environment's
// uploads region (s3-setup's self-heal) skipped the apply, and the app Secret
// kept the wrong region for good.
describe('buildK3sApplyInputs: where the buckets are is part of the gate', () => {
  const EP = (region: string) => `https://${region}.your-objectstorage.com`;
  const app = (region: string) => ({
    accessKey: 'AK',
    secretKey: 'SK',
    bucket: 'proj-abc123-prod-storage',
    region,
    endpoint: EP(region),
  });
  const backups = (region: string, bucket = 'proj-abc123-backups') => ({
    bucket,
    region,
    endpoint: EP(region),
  });
  const base = { imageTag: 'r:5000/app:abc', dbImageTag: 'db:v1', projectDir: tmpdir() };
  const inputs = (s3Config: unknown, backupTarget: unknown) =>
    buildK3sApplyInputs({ ...base, s3Config, backupTarget });
  // StateTracker keys its state file off process.cwd()/.vibecarbon.
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-k3s-gate-storage-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('names each bucket with its region and endpoint', () => {
    expect(inputs(app('fsn1'), backups('nbg1')).storageTargets).toBe(
      `proj-abc123-prod-storage@fsn1@${EP('fsn1')} proj-abc123-backups@nbg1@${EP('nbg1')}`,
    );
  });

  it("changing the backups target's region changes the inputs", () => {
    const before = inputs(app('fsn1'), backups('fsn1'));
    const after = inputs(app('fsn1'), backups('nbg1'));
    expect(after.storageTargets).not.toBe(before.storageTargets);
    const t = new StateTracker('proj', 'gate-storage-backups');
    t.startStep('k3s-apply', before);
    t.completeStep('k3s-apply');
    expect(new StateTracker('proj', 'gate-storage-backups').shouldSkip('k3s-apply', after)).toBe(
      false,
    );
  });

  it("changing the app bucket's region changes the inputs (the self-healed record)", () => {
    const before = inputs(app('nbg1'), backups('nbg1'));
    const after = inputs(app('fsn1'), backups('nbg1'));
    expect(after.storageTargets).not.toBe(before.storageTargets);
    const t = new StateTracker('proj', 'gate-storage-app');
    t.startStep('k3s-apply', before);
    t.completeStep('k3s-apply');
    expect(new StateTracker('proj', 'gate-storage-app').shouldSkip('k3s-apply', after)).toBe(false);
  });

  it('another backups bucket changes the inputs; the same targets keep the skip', () => {
    expect(
      inputs(app('fsn1'), backups('fsn1', 'proj-abc123-fsn1-backups')).storageTargets,
    ).not.toBe(inputs(app('fsn1'), backups('fsn1')).storageTargets);
    expect(inputs(app('fsn1'), backups('fsn1'))).toEqual(inputs(app('fsn1'), backups('fsn1')));
  });
});

// The apply writes the provider API token into
// kube-system/carbon-autoscaler-config and restarts the autoscaler when it
// changed (applyK3sManifests). A skipped apply would leave the autoscaler on
// a token the operator replaced, perhaps revoked, so the token is an input:
// as a keyed digest, never the token, since the inputs are hashed into the
// deploy-state file.
describe('buildK3sApplyInputs — a replaced provider token opens the gate', () => {
  const MARK = 'vc-sentinel-token-5e1b';
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = createTempDir('vc-k3s-gate-token-');
    mkdirSync(join(dir, 'k8s', 'base'), { recursive: true });
    writeFileSync(join(dir, 'k8s', 'base', 'kustomization.yaml'), 'resources: []\n');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    cleanupTempDir(dir);
  });

  const inputs = (apiToken?: string) =>
    buildK3sApplyInputs({
      imageTag: 'registry:5000/app:abc123',
      dbImageTag: 'ghcr.io/o/db:v1',
      projectDir: dir,
      apiToken,
    });
  const deployed = (apiToken: string) => {
    const t = new StateTracker('proj', 'prod');
    t.startStep('k3s-apply', inputs(apiToken));
    t.completeStep('k3s-apply');
  };

  it('a new token opens the gate', () => {
    deployed(`${MARK}-old`);
    expect(new StateTracker('proj', 'prod').shouldSkip('k3s-apply', inputs(`${MARK}-new`))).toBe(
      false,
    );
  });

  it('the same token keeps it shut', () => {
    deployed(MARK);
    expect(new StateTracker('proj', 'prod').shouldSkip('k3s-apply', inputs(MARK))).toBe(true);
  });

  it('neither the inputs nor the deploy-state file hold the token', () => {
    const withToken = inputs(MARK);
    expect(withToken.providerTokenDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(withToken)).not.toContain(MARK);
    deployed(MARK);
    const file = readFileSync(join(dir, '.vibecarbon', 'deploy-state-prod.json'), 'utf-8');
    expect(file).not.toContain(MARK);
    expect(file).not.toContain(withToken.providerTokenDigest);
  });

  it('no token digests as empty, as the app storage key does', () => {
    expect(inputs(undefined).providerTokenDigest).toBe('');
  });

  it('deployK3s passes the deploy token to the gate', () => {
    // process.cwd() is the temp dir here.
    const src = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const body = src.slice(src.indexOf('export async function deployK3s('));
    const gateCall = body.slice(body.indexOf('buildK3sApplyInputs({'));
    expect(gateCall.slice(0, gateCall.indexOf('});'))).toMatch(
      /\n\s+apiToken: options\.apiToken,\n/,
    );
  });
});

describe('deployK3s feeds the k3s-apply gate its pilot-light role and storage targets', () => {
  it('deployK3s hands the gate the app config and the backups target', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const body = src.slice(src.indexOf('export async function deployK3s('));
    const gateCall = body.slice(body.indexOf('buildK3sApplyInputs({'));
    const args = gateCall.slice(0, gateCall.indexOf('});'));
    expect(args).toMatch(/\n\s+s3Config: options\.s3Config,\n/);
    expect(args).toMatch(/\n\s+backupTarget: options\.backupTarget,\n/);
  });

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
