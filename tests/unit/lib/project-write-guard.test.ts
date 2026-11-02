/**
 * Writers into the project refuse a path with a symlinked component: the
 * write would land wherever the link points, possibly outside the project.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { symlinkedComponent } from '../../../src/lib/project-write-guard.js';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'vc-write-guard-'));
  const outside = mkdtempSync(join(tmpdir(), 'vc-write-guard-out-'));
  mkdirSync(join(root, 'k8s', 'base'), { recursive: true });
  writeFileSync(join(outside, 'target.yaml'), 'x\n');
  return { root, outside };
}

describe('symlinkedComponent', () => {
  it('null for plain directories and files, existing or not', () => {
    const { root } = project();
    writeFileSync(join(root, 'k8s', 'base', 'a.yaml'), 'a\n');
    expect(symlinkedComponent(root, 'k8s/base/a.yaml')).toBeNull();
    expect(symlinkedComponent(root, 'k8s/base/new/b.yaml')).toBeNull();
    expect(symlinkedComponent(root, 'missing/dir/c.yaml')).toBeNull();
  });

  it('names a symlinked directory on the way', () => {
    const { root, outside } = project();
    symlinkSync(outside, join(root, 'k8s', 'base', 'observability'));
    expect(symlinkedComponent(root, 'k8s/base/observability/target.yaml')).toBe(
      'k8s/base/observability',
    );
  });

  it('names a symlinked file itself', () => {
    const { root, outside } = project();
    symlinkSync(join(outside, 'target.yaml'), join(root, 'k8s', 'base', 'a.yaml'));
    expect(symlinkedComponent(root, 'k8s/base/a.yaml')).toBe('k8s/base/a.yaml');
  });

  it('a dangling symlink counts too', () => {
    const { root } = project();
    symlinkSync(join(root, 'nowhere'), join(root, 'k8s', 'base', 'gone'));
    expect(symlinkedComponent(root, 'k8s/base/gone/x.yaml')).toBe('k8s/base/gone');
  });
});
