import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isInSurface, run } from '../../../scripts/check-paid-boundary.js';
import {
  PAID_ENTRY_POINTS,
  PAID_SURFACE,
  PAID_TEMPLATE_ASSETS,
} from '../../../src/lib/licensing/paid-surface.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function allSurfacePaths() {
  return Object.values(PAID_SURFACE).flat();
}

describe('paid-surface manifest', () => {
  it('every PAID_SURFACE path exists on disk', () => {
    for (const p of allSurfacePaths()) {
      expect(existsSync(join(repoRoot, p)), `${p} (PAID_SURFACE) does not exist`).toBe(true);
    }
  });

  it('every PAID_ENTRY_POINTS path exists on disk and is a real file', () => {
    for (const p of PAID_ENTRY_POINTS) {
      expect(existsSync(join(repoRoot, p)), `${p} (PAID_ENTRY_POINTS) does not exist`).toBe(true);
      expect(p.endsWith('/'), `${p} (PAID_ENTRY_POINTS) must be a file, not a directory`).toBe(
        false,
      );
    }
  });

  it('every PAID_TEMPLATE_ASSETS path exists on disk', () => {
    for (const p of PAID_TEMPLATE_ASSETS) {
      expect(existsSync(join(repoRoot, p)), `${p} (PAID_TEMPLATE_ASSETS) does not exist`).toBe(
        true,
      );
    }
  });

  it('every entry point is inside the declared surface', () => {
    // An entry point that isn't part of PAID_SURFACE would be a
    // contradiction: the guard would never treat it as an in-surface
    // destination, so the "importee in surface but not an entry point"
    // check could never actually exempt it.
    for (const p of PAID_ENTRY_POINTS) {
      expect(isInSurface(p), `${p} (PAID_ENTRY_POINTS) is not covered by PAID_SURFACE`).toBe(true);
    }
  });
});

describe('check-paid-boundary.js', () => {
  it('exits 0 when spawned against the real tree', () => {
    expect(() =>
      execFileSync('node', ['scripts/check-paid-boundary.js'], {
        cwd: repoRoot,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('passes clean (no violations) when run() is called directly against src/', () => {
    const violations = run(join(repoRoot, 'src'));
    expect(violations).toEqual([]);
  });

  // Proves the guard actually DETECTS a violation rather than always
  // passing — a synthetic tree with one free file reaching past an entry
  // point into a paid-engine internal.
  it('detects a synthetic deep reach past a paid entry point', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'paid-boundary-fixture-'));
    try {
      const srcDir = join(fixtureRoot, 'src');
      const k8sDir = join(srcDir, 'lib', 'deploy', 'k8s');
      mkdirSync(k8sDir, { recursive: true });

      // A paid-surface internal (not in PAID_ENTRY_POINTS).
      writeFileSync(join(k8sDir, 'k3s.js'), "export const K3S_VERSION = 'v1.31.5+k3s1';\n");

      // Free code reaching directly into the internal instead of through
      // src/lib/deploy/k8s/index.js.
      writeFileSync(
        join(srcDir, 'scale.js'),
        "const { K3S_VERSION } = await import('./lib/deploy/k8s/k3s.js');\nconsole.log(K3S_VERSION);\n",
      );

      const violations = run(srcDir, fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0].rel).toBe('src/scale.js');
      expect(violations[0].importee).toBe('src/lib/deploy/k8s/k3s.js');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('honors a paid-boundary-ignore comment on the synthetic violation', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'paid-boundary-fixture-'));
    try {
      const srcDir = join(fixtureRoot, 'src');
      const k8sDir = join(srcDir, 'lib', 'deploy', 'k8s');
      mkdirSync(k8sDir, { recursive: true });

      writeFileSync(join(k8sDir, 'k3s.js'), "export const K3S_VERSION = 'v1.31.5+k3s1';\n");
      writeFileSync(
        join(srcDir, 'scale.js'),
        '// paid-boundary-ignore: test fixture\n' +
          "const { K3S_VERSION } = await import('./lib/deploy/k8s/k3s.js');\n" +
          'console.log(K3S_VERSION);\n',
      );

      const violations = run(srcDir, fixtureRoot);
      expect(violations).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
