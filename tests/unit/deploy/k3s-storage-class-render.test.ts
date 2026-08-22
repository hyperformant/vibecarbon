/**
 * M3 Task 4: `renderK8sStorageClassPlaceholder` (src/lib/deploy/k8s/k3s.js)
 * is the seam that resolves the `{{K8S_STORAGE_CLASS}}` placeholder
 * observability's loki/grafana/prometheus PVCs (and n8n's PVC, once
 * unparked) ship instead of hardcoding Hetzner's `hcloud-volumes`.
 *
 * Why this is a dedicated, DIRECT unit test of the render function rather
 * than another assertion bolted onto k3s-apply-manifests-ordering.test.ts:
 * that suite's `makeProjectDir({ withObservability: true })` fixture is a
 * bare kustomization.yaml stub with no PVC content, so it proves the apply
 * STEP still runs at the right point but never exercises the substitution
 * itself. This file drives the actual seam function against the REAL
 * checked-in observability PVC fixture (read straight off disk, not
 * hand-copied — so a future edit to the shipped manifest can't silently
 * drift out of sync with what this test pins).
 *
 * PVC immutability is why this is pre-apply (a temp-dir render), not a
 * deploy-time kubectl patch — see the function's own doc in k3s.js.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderK8sStorageClassPlaceholder } from '../../../src/lib/deploy/k8s/k3s.js';

const ROOT = join(__dirname, '../../..');
const REAL_GRAFANA_PVC = join(ROOT, 'services/observability/k8s/grafana-pvc.yaml');

/** A control file that never carries the placeholder — proves untouched
 * files pass through the render byte-identical. */
const KUSTOMIZATION_CONTROL = [
  'apiVersion: kustomize.config.k8s.io/v1beta1',
  'kind: Kustomization',
  'namespace: vibecarbon-observability',
  '',
].join('\n');

function makeSourceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-storageclass-src-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'grafana-pvc.yaml'), readFileSync(REAL_GRAFANA_PVC, 'utf-8'));
  writeFileSync(join(dir, 'kustomization.yaml'), KUSTOMIZATION_CONTROL);
  return dir;
}

describe('renderK8sStorageClassPlaceholder', () => {
  it('the real checked-in grafana-pvc.yaml ships the placeholder, not a hardcoded literal', () => {
    // Sanity precondition for every assertion below — if this ever fails,
    // the fixture drifted (someone reverted the Task 4 manifest edit) and
    // the rest of this suite would be testing nothing.
    const raw = readFileSync(REAL_GRAFANA_PVC, 'utf-8');
    expect(raw).toContain('storageClassName: {{K8S_STORAGE_CLASS}}');
    expect(raw).not.toContain('hcloud-volumes');
  });

  it('Hetzner: resolves to hcloud-volumes, byte-identical to the pre-Task-4 literal', () => {
    const srcDir = makeSourceDir();
    const outDir = renderK8sStorageClassPlaceholder(srcDir, 'hcloud-volumes');

    expect(outDir).not.toBe(srcDir);
    const rendered = readFileSync(join(outDir, 'grafana-pvc.yaml'), 'utf-8');
    // Byte-identical to what shipped before M3 Task 4 (git history:
    // `storageClassName: hcloud-volumes` — see the .md report for the
    // pre-image diff).
    const expected = readFileSync(REAL_GRAFANA_PVC, 'utf-8').replace(
      '{{K8S_STORAGE_CLASS}}',
      'hcloud-volumes',
    );
    expect(rendered).toBe(expected);
    expect(rendered).toContain('storageClassName: hcloud-volumes');
  });

  it('DigitalOcean: resolves to do-block-storage', () => {
    const srcDir = makeSourceDir();
    const outDir = renderK8sStorageClassPlaceholder(srcDir, 'do-block-storage');

    const rendered = readFileSync(join(outDir, 'grafana-pvc.yaml'), 'utf-8');
    expect(rendered).toContain('storageClassName: do-block-storage');
    expect(rendered).not.toContain('{{K8S_STORAGE_CLASS}}');
    expect(rendered).not.toContain('hcloud-volumes');
  });

  it('a file with no placeholder passes through byte-identical', () => {
    const srcDir = makeSourceDir();
    const outDir = renderK8sStorageClassPlaceholder(srcDir, 'hcloud-volumes');

    expect(readFileSync(join(outDir, 'kustomization.yaml'), 'utf-8')).toBe(KUSTOMIZATION_CONTROL);
  });

  it('never mutates the source directory (no dirty git working tree after deploy)', () => {
    const srcDir = makeSourceDir();
    const before = readFileSync(join(srcDir, 'grafana-pvc.yaml'), 'utf-8');
    renderK8sStorageClassPlaceholder(srcDir, 'hcloud-volumes');
    const after = readFileSync(join(srcDir, 'grafana-pvc.yaml'), 'utf-8');

    expect(after).toBe(before);
    expect(after).toContain('{{K8S_STORAGE_CLASS}}');
  });

  it('renders into a fresh temp dir whose name still identifies the source addon', () => {
    // The applied path swaps from the project's own observabilityDir to
    // this temp copy — keeping the source basename in the temp dir name
    // means any log/argv matching on "observability" (operator debugging,
    // or a test asserting the apply ran) still finds it.
    // A fresh unique parent per run (mkdtempSync), with a FIXED-name
    // `observability` subdir inside it — collision-free across parallel/
    // repeated test runs while still exercising the real basename.
    const parent = mkdtempSync(join(tmpdir(), 'vc-storageclass-parent-'));
    const namedSrcDir = join(parent, 'observability');
    mkdirSync(namedSrcDir, { recursive: true });
    writeFileSync(join(namedSrcDir, 'kustomization.yaml'), KUSTOMIZATION_CONTROL);

    const outDir = renderK8sStorageClassPlaceholder(namedSrcDir, 'hcloud-volumes');
    expect(outDir).toContain('observability');
    expect(existsSync(join(outDir, 'kustomization.yaml'))).toBe(true);
  });
});

describe('unresolved-placeholder guard (T4 review: k8s accepts a literal placeholder silently)', () => {
  it('throws when the storageClass value is empty instead of writing an unresolved placeholder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-guard-src-'));
    writeFileSync(join(dir, 'pvc.yaml'), 'storageClassName: {{K8S_STORAGE_CLASS}}\n');
    try {
      expect(() => renderK8sStorageClassPlaceholder(dir, '')).toThrow(
        /unresolved placeholder target/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
