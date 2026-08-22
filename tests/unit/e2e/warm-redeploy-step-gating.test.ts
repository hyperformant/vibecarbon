import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WARM_REDEPLOY_APP_FILE,
  WARM_REDEPLOY_MANIFEST_FILE,
} from '../../e2e/utils/warm-redeploy-mutations.js';

/**
 * Source-level guard for the `warm-redeploy-change` step's WIRING, in the same
 * static convention as lifecycle-restore-reseed-provider.test.ts (
 * _run-lifecycle.ts has no unit harness — it is a scenario-definition file
 * exercised only by real-infra runs, so wiring invariants are pinned by
 * reading the source).
 *
 * This exists because mutation-testing the guard found a hole: deleting the
 * step's mode gate broke nothing in the unit tier. An ungated
 * `warm-redeploy-change` would run a mutating 5–10 minute redeploy on ALL FOUR
 * release scenarios — adding ~30 minutes to a matrix run, and doing it in
 * compose modes where the kubectl assertion cannot possibly pass. That is a
 * costly, silent mis-wiring, so it gets a tripwire.
 */
describe('_run-lifecycle.ts: warm-redeploy-change wiring', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../tests/e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
    'utf8',
  );

  it('is filtered out for every mode except k8s', () => {
    // k8s-single only: compose/compose-ha have no k3s-apply gate to guard, and
    // k8s-ha already state-resumes a deploy in `reconverge-deploy`.
    expect(src).toContain("if (config.mode !== 'k8s') {");
    const gateIdx = src.indexOf("if (config.mode !== 'k8s') {");
    const filterIdx = src.indexOf(
      "filteredStepDefs.filter((s) => s.name !== 'warm-redeploy-change')",
    );
    expect(gateIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(gateIdx);
  });

  it('does not repurpose warm-deploy, which is a curated perf-table column', () => {
    // Making `warm-deploy` mutating would silently redefine a published
    // README number (it times the NO-OP convergence path) and shift the
    // perf-table anomaly-guard baselines. The two steps must stay distinct.
    expect(src).toContain("name: 'warm-deploy',");
    expect(src).toContain("name: 'warm-redeploy-change',");
    const warmDeployIdx = src.indexOf("name: 'warm-deploy',");
    const changeIdx = src.indexOf("name: 'warm-redeploy-change',");
    expect(changeIdx).toBeGreaterThan(warmDeployIdx);
    // The mutators must not be invoked from inside the warm-deploy step body.
    const warmDeployBody = src.slice(warmDeployIdx, changeIdx);
    expect(warmDeployBody).not.toContain('mutateConfigMapManifest');
    expect(warmDeployBody).not.toContain('mutateAppHealthRoute');
  });

  it('mutates BOTH a bundled manifest and an app source file', () => {
    // The whole point of the step is that a manifest-only assertion would miss
    // the stale-image half of the class, and vice versa.
    expect(src).toContain('mutateConfigMapManifest');
    expect(src).toContain('mutateAppHealthRoute');
    expect(src).toContain('WARM_REDEPLOY_MANIFEST_FILE');
    expect(src).toContain('WARM_REDEPLOY_APP_FILE');
  });

  it('asserts the manifest change via kubectl and the app change over HTTPS', () => {
    const changeIdx = src.indexOf("name: 'warm-redeploy-change',");
    const body = src.slice(changeIdx, changeIdx + 8000);
    expect(body).toContain('jsonpath=');
    expect(body).toContain('dnsSafeFetch');
  });

  it('the two mutated paths are the ones create() lays into a project', () => {
    // `create` copies carbon/k8s -> <project>/k8s and carbon/src -> <project>/src,
    // so these project-relative paths must not carry a carbon/ prefix.
    expect(WARM_REDEPLOY_MANIFEST_FILE).toBe('k8s/base/config/configmap.yaml');
    expect(WARM_REDEPLOY_APP_FILE).toBe('src/server/routes/health.ts');
  });
});

describe('backup-evidence check wiring', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../tests/e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
    'utf8',
  );

  it('runs at BOTH specced hook points — after deploy and again after scale', () => {
    const calls = [...src.matchAll(/runBackupEvidenceChecks\(/g)];
    expect(calls.length).toBe(2);
    expect(src).toContain("phase: 'verify-scale',");
    expect(src).toContain("if (stepName === 'verify-deploy') {");
  });

  it('probes the HA primary, never an arbitrary node', () => {
    // On HA the standby's archive path is write-guarded off by design; probing
    // it would report a skip and quietly make the check vacuous.
    expect(src).toContain('masterIp: sshCheckMasterIp,');
  });

  it('fails verify-scale when the post-scale backup evidence is missing', () => {
    expect(src).toContain('verify-scale: backup evidence missing after scale');
  });
});
